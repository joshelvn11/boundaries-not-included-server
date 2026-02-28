import crypto from "crypto";

import type Database from "better-sqlite3";
import { z } from "zod";

import { ApiError } from "../errors/api-error";
import {
  DEFAULT_SETTINGS,
  GAME_STATUS,
  LIMITS,
  ROOM_STATUS,
  type RequestAuthContext,
  type RoomSettings,
  type RoomSnapshot,
  type SessionBundle
} from "../types/domain";
import { GameEngineService } from "./game-engine.service";
import { generateUniqueRoomCode } from "./room-code.service";
import { createReconnectToken, hashToken } from "./session.service";
import { SnapshotService } from "./snapshot.service";

const createRoomSchema = z.object({
  displayName: z.string().trim().min(LIMITS.minDisplayNameLength).max(LIMITS.maxDisplayNameLength),
  settings: z
    .object({
      maxPlayers: z
        .number()
        .int()
        .min(LIMITS.minMaxPlayers)
        .max(LIMITS.maxMaxPlayers)
        .optional(),
      targetScore: z
        .number()
        .int()
        .min(LIMITS.minTargetScore)
        .max(LIMITS.maxTargetScore)
        .optional()
    })
    .optional()
});

const joinSchema = z.object({
  displayName: z.string().trim().min(LIMITS.minDisplayNameLength).max(LIMITS.maxDisplayNameLength)
});

const reconnectSchema = z.object({
  playerId: z.string().min(1),
  reconnectToken: z.string().min(1)
});

const readySchema = z.object({
  isReady: z.boolean()
});

const submitSchema = z.object({
  handCardIds: z.array(z.string().min(1)).min(1).max(3).refine((items) => new Set(items).size === items.length, {
    message: "handCardIds must be unique"
  })
});

const pickSchema = z.object({
  submissionId: z.string().min(1)
});

type RoomRow = {
  id: string;
  code: string;
  status: string;
  host_player_id: string;
  settings_json: string;
};

type MemberRow = {
  player_id: string;
  is_host: number;
  connected: number;
  join_order: number;
};

type SessionRow = {
  id: string;
  token_hash: string;
  revoked_at: string | null;
};

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseRoomSettings(rawSettings: string): RoomSettings {
  try {
    const parsed = JSON.parse(rawSettings) as Partial<RoomSettings>;
    return {
      maxPlayers: parsed.maxPlayers ?? DEFAULT_SETTINGS.maxPlayers,
      targetScore: parsed.targetScore ?? DEFAULT_SETTINGS.targetScore
    };
  } catch {
    return {
      maxPlayers: DEFAULT_SETTINGS.maxPlayers,
      targetScore: DEFAULT_SETTINGS.targetScore
    };
  }
}

type SocketIdentity = {
  socketId: string;
  roomId: string;
  roomCode: string;
  playerId: string;
};

export class RoomLifecycleService {
  private readonly snapshotService: SnapshotService;

  private readonly gameEngine: GameEngineService;

  private readonly disconnectTimers = new Map<string, NodeJS.Timeout>();

  private readonly socketIdentities = new Map<string, SocketIdentity>();

  private broadcastHook?: (roomCode: string) => void | Promise<void>;

  constructor(private readonly connection: Database.Database) {
    this.snapshotService = new SnapshotService(connection);
    this.gameEngine = new GameEngineService(connection);
  }

  setBroadcastHook(hook: (roomCode: string) => void | Promise<void>): void {
    this.broadcastHook = hook;
  }

  validateCreatePayload(input: unknown): z.infer<typeof createRoomSchema> {
    return createRoomSchema.parse(input);
  }

  validateJoinPayload(input: unknown): z.infer<typeof joinSchema> {
    return joinSchema.parse(input);
  }

  validateReconnectPayload(input: unknown): z.infer<typeof reconnectSchema> {
    return reconnectSchema.parse(input);
  }

  validateReadyPayload(input: unknown): z.infer<typeof readySchema> {
    return readySchema.parse(input);
  }

  validateSubmitPayload(input: unknown): z.infer<typeof submitSchema> {
    return submitSchema.parse(input);
  }

  validatePickPayload(input: unknown): z.infer<typeof pickSchema> {
    return pickSchema.parse(input);
  }

  createRoom(input: z.infer<typeof createRoomSchema>): {
    roomCode: string;
    playerId: string;
    reconnectToken: string;
    snapshot: RoomSnapshot;
  } {
    const parsed = this.validateCreatePayload(input);

    let roomCode = "";
    let playerId = "";
    let reconnectToken = "";

    const tx = this.connection.transaction(() => {
      const roomId = createId("room");
      roomCode = generateUniqueRoomCode(this.connection);
      playerId = createId("plr");
      reconnectToken = createReconnectToken();

      const settings: RoomSettings = {
        maxPlayers: parsed.settings?.maxPlayers ?? DEFAULT_SETTINGS.maxPlayers,
        targetScore: parsed.settings?.targetScore ?? DEFAULT_SETTINGS.targetScore
      };

      this.connection
        .prepare("INSERT INTO players (id, display_name, last_seen_at, created_at) VALUES (?, ?, ?, ?)")
        .run(playerId, parsed.displayName, nowIso(), nowIso());

      this.connection
        .prepare(
          `INSERT INTO rooms (id, code, host_player_id, status, settings_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(roomId, roomCode, playerId, ROOM_STATUS.OPEN, JSON.stringify(settings), nowIso());

      this.connection
        .prepare(
          `INSERT INTO room_players (room_id, player_id, is_host, is_ready, score, join_order, connected)
           VALUES (?, ?, 1, 1, 0, 1, 1)`
        )
        .run(roomId, playerId);

      this.upsertSession(roomId, playerId, reconnectToken);
    });

    tx();

    const snapshot = this.snapshotService.getSnapshot(roomCode, playerId);
    this.notifyRoom(roomCode);

    return {
      roomCode,
      playerId,
      reconnectToken,
      snapshot
    };
  }

  joinRoom(roomCodeInput: string, input: z.infer<typeof joinSchema>): {
    roomCode: string;
    playerId: string;
    reconnectToken: string;
    snapshot: RoomSnapshot;
  } {
    const parsed = this.validateJoinPayload(input);
    const roomCode = roomCodeInput.toUpperCase();
    const room = this.getRoomByCode(roomCode);

    if (room.status !== ROOM_STATUS.OPEN) {
      throw new ApiError(409, "GAME_IN_PROGRESS_JOIN_BLOCKED", "Cannot join room while a game is in progress");
    }

    const settings = parseRoomSettings(room.settings_json);
    const memberCount = (
      this.connection
        .prepare("SELECT COUNT(*) AS count FROM room_players WHERE room_id = ?")
        .get(room.id) as { count: number }
    ).count;

    if (memberCount >= settings.maxPlayers) {
      throw new ApiError(409, "ROOM_FULL", "Room is already full");
    }

    let playerId = "";
    let reconnectToken = "";

    const tx = this.connection.transaction(() => {
      playerId = createId("plr");
      reconnectToken = createReconnectToken();

      const joinOrder = (
        this.connection
          .prepare("SELECT COALESCE(MAX(join_order), 0) AS value FROM room_players WHERE room_id = ?")
          .get(room.id) as { value: number }
      ).value;

      this.connection
        .prepare("INSERT INTO players (id, display_name, last_seen_at, created_at) VALUES (?, ?, ?, ?)")
        .run(playerId, parsed.displayName, nowIso(), nowIso());

      this.connection
        .prepare(
          `INSERT INTO room_players (room_id, player_id, is_host, is_ready, score, join_order, connected)
           VALUES (?, ?, 0, 0, 0, ?, 1)`
        )
        .run(room.id, playerId, joinOrder + 1);

      this.upsertSession(room.id, playerId, reconnectToken);
    });

    tx();

    const snapshot = this.snapshotService.getSnapshot(roomCode, playerId);
    this.notifyRoom(roomCode);

    return {
      roomCode,
      playerId,
      reconnectToken,
      snapshot
    };
  }

  reconnect(roomCodeInput: string, input: z.infer<typeof reconnectSchema>): {
    playerId: string;
    reconnectToken: string;
    snapshot: RoomSnapshot;
  } {
    const roomCode = roomCodeInput.toUpperCase();
    const parsed = this.validateReconnectPayload(input);

    this.authenticateSession(roomCode, parsed.playerId, parsed.reconnectToken);

    const room = this.getRoomByCode(roomCode);

    this.connection
      .prepare("UPDATE room_players SET connected = 1 WHERE room_id = ? AND player_id = ?")
      .run(room.id, parsed.playerId);

    this.connection
      .prepare("UPDATE players SET last_seen_at = ? WHERE id = ?")
      .run(nowIso(), parsed.playerId);

    this.connection
      .prepare(
        `UPDATE room_sessions
         SET last_used_at = ?
         WHERE room_id = ? AND player_id = ? AND revoked_at IS NULL`
      )
      .run(nowIso(), room.id, parsed.playerId);

    this.cancelDisconnectTimer(room.id, parsed.playerId);

    const snapshot = this.snapshotService.getSnapshot(roomCode, parsed.playerId);
    this.notifyRoom(roomCode);

    return {
      playerId: parsed.playerId,
      reconnectToken: parsed.reconnectToken,
      snapshot
    };
  }

  authenticateRequest(roomCodeInput: string, playerId: string, reconnectToken: string): RequestAuthContext {
    const roomCode = roomCodeInput.toUpperCase();
    const room = this.getRoomByCode(roomCode);

    this.authenticateSession(roomCode, playerId, reconnectToken);

    const member = this.connection
      .prepare(
        `SELECT player_id
         FROM room_players
         WHERE room_id = ? AND player_id = ?
         LIMIT 1`
      )
      .get(room.id, playerId) as { player_id: string } | undefined;

    if (!member) {
      throw new ApiError(401, "UNAUTHORIZED", "Player is not a member of this room");
    }

    this.connection
      .prepare("UPDATE room_players SET connected = 1 WHERE room_id = ? AND player_id = ?")
      .run(room.id, playerId);

    this.connection
      .prepare(
        `UPDATE room_sessions
         SET last_used_at = ?
         WHERE room_id = ? AND player_id = ? AND revoked_at IS NULL`
      )
      .run(nowIso(), room.id, playerId);

    this.cancelDisconnectTimer(room.id, playerId);

    return {
      roomId: room.id,
      roomCode: room.code,
      playerId
    };
  }

  getSnapshotForPlayer(roomCodeInput: string, playerId: string): RoomSnapshot {
    return this.snapshotService.getSnapshot(roomCodeInput.toUpperCase(), playerId);
  }

  setReady(auth: RequestAuthContext, input: z.infer<typeof readySchema>): RoomSnapshot {
    const parsed = this.validateReadyPayload(input);
    const room = this.getRoomByCode(auth.roomCode);

    if (room.status !== ROOM_STATUS.OPEN) {
      throw new ApiError(409, "INVALID_STATE", "Room is not in lobby state");
    }

    this.connection
      .prepare("UPDATE room_players SET is_ready = ? WHERE room_id = ? AND player_id = ?")
      .run(parsed.isReady ? 1 : 0, auth.roomId, auth.playerId);

    const snapshot = this.snapshotService.getSnapshot(room.code, auth.playerId);
    this.notifyRoom(room.code);
    return snapshot;
  }

  startGame(auth: RequestAuthContext): RoomSnapshot {
    const room = this.getRoomByCode(auth.roomCode);

    if (room.status !== ROOM_STATUS.OPEN) {
      throw new ApiError(409, "INVALID_STATE", "Room is already in game");
    }

    const hostRow = this.connection
      .prepare(
        `SELECT is_host
         FROM room_players
         WHERE room_id = ? AND player_id = ?
         LIMIT 1`
      )
      .get(auth.roomId, auth.playerId) as { is_host: number } | undefined;

    if (!hostRow || !hostRow.is_host) {
      throw new ApiError(403, "FORBIDDEN", "Only the host can start the game");
    }

    const connectedCount = (
      this.connection
        .prepare("SELECT COUNT(*) AS count FROM room_players WHERE room_id = ? AND connected = 1")
        .get(auth.roomId) as { count: number }
    ).count;

    if (connectedCount < LIMITS.minPlayersToStart) {
      throw new ApiError(409, "NOT_READY_TO_START", "Need at least 3 connected players to start");
    }

    const readyConnectedCount = (
      this.connection
        .prepare(
          `SELECT COUNT(*) AS count
           FROM room_players
           WHERE room_id = ? AND connected = 1 AND is_ready = 1`
        )
        .get(auth.roomId) as { count: number }
    ).count;

    if (readyConnectedCount !== connectedCount) {
      throw new ApiError(409, "NOT_READY_TO_START", "All connected players must be ready");
    }

    const settings = parseRoomSettings(room.settings_json);

    const tx = this.connection.transaction(() => {
      this.gameEngine.startGame(auth.roomId, settings);
    });
    tx();

    const snapshot = this.snapshotService.getSnapshot(room.code, auth.playerId);
    this.notifyRoom(room.code);
    return snapshot;
  }

  playAgain(auth: RequestAuthContext): RoomSnapshot {
    const room = this.getRoomByCode(auth.roomCode);

    const hostRow = this.connection
      .prepare(
        `SELECT is_host
         FROM room_players
         WHERE room_id = ? AND player_id = ?
         LIMIT 1`
      )
      .get(auth.roomId, auth.playerId) as { is_host: number } | undefined;

    if (!hostRow || !hostRow.is_host) {
      throw new ApiError(403, "FORBIDDEN", "Only the host can start another game");
    }

    const latestUnarchivedGame = this.connection
      .prepare(
        `SELECT id, status
         FROM games
         WHERE room_id = ? AND archived_at IS NULL
         ORDER BY rowid DESC
         LIMIT 1`
      )
      .get(auth.roomId) as { id: string; status: string } | undefined;

    if (!latestUnarchivedGame || latestUnarchivedGame.status !== GAME_STATUS.OVER) {
      throw new ApiError(409, "INVALID_STATE", "No completed game is available to reset");
    }

    const tx = this.connection.transaction(() => {
      this.connection
        .prepare("UPDATE games SET archived_at = ? WHERE id = ?")
        .run(nowIso(), latestUnarchivedGame.id);
      this.connection.prepare("UPDATE rooms SET status = ? WHERE id = ?").run(ROOM_STATUS.OPEN, auth.roomId);
      this.connection
        .prepare("UPDATE room_players SET is_ready = 0, score = 0 WHERE room_id = ?")
        .run(auth.roomId);
      this.connection.prepare("DELETE FROM player_hands WHERE room_id = ?").run(auth.roomId);
    });
    tx();

    const snapshot = this.snapshotService.getSnapshot(room.code, auth.playerId);
    this.notifyRoom(room.code);
    return snapshot;
  }

  submitCard(auth: RequestAuthContext, input: z.infer<typeof submitSchema>): RoomSnapshot {
    const parsed = this.validateSubmitPayload(input);

    const tx = this.connection.transaction(() => {
      this.gameEngine.submitCard(auth.roomId, auth.playerId, parsed.handCardIds);
    });
    tx();

    const snapshot = this.snapshotService.getSnapshot(auth.roomCode, auth.playerId);
    this.notifyRoom(auth.roomCode);
    return snapshot;
  }

  pickWinner(auth: RequestAuthContext, input: z.infer<typeof pickSchema>): RoomSnapshot {
    const parsed = this.validatePickPayload(input);

    const tx = this.connection.transaction(() => {
      this.gameEngine.pickWinner(auth.roomId, auth.playerId, parsed.submissionId);
    });
    tx();

    const snapshot = this.snapshotService.getSnapshot(auth.roomCode, auth.playerId);
    this.notifyRoom(auth.roomCode);
    return snapshot;
  }

  leaveRoom(auth: RequestAuthContext): void {
    const room = this.getRoomByCode(auth.roomCode);

    const tx = this.connection.transaction(() => {
      this.removeMember(room.id, auth.playerId);
    });
    tx();

    this.notifyRoom(room.code);
  }

  attachSocket(socketId: string, roomCodeInput: string, playerId: string, reconnectToken: string): RoomSnapshot {
    const auth = this.authenticateRequest(roomCodeInput, playerId, reconnectToken);

    this.socketIdentities.set(socketId, {
      socketId,
      roomId: auth.roomId,
      roomCode: auth.roomCode,
      playerId: auth.playerId
    });

    const snapshot = this.snapshotService.getSnapshot(auth.roomCode, auth.playerId);
    this.notifyRoom(auth.roomCode);
    return snapshot;
  }

  detachSocket(socketId: string): void {
    const identity = this.socketIdentities.get(socketId);
    if (!identity) {
      return;
    }

    this.socketIdentities.delete(socketId);

    const hasAnotherSocket = [...this.socketIdentities.values()].some(
      (entry) =>
        entry.roomId === identity.roomId &&
        entry.playerId === identity.playerId &&
        entry.socketId !== socketId
    );

    if (hasAnotherSocket) {
      return;
    }

    this.connection
      .prepare("UPDATE room_players SET connected = 0 WHERE room_id = ? AND player_id = ?")
      .run(identity.roomId, identity.playerId);

    this.scheduleDisconnectRemoval(identity.roomId, identity.roomCode, identity.playerId);
    this.notifyRoom(identity.roomCode);
  }

  listSocketIdentitiesForRoom(roomCodeInput: string): SocketIdentity[] {
    const roomCode = roomCodeInput.toUpperCase();
    return [...this.socketIdentities.values()].filter((entry) => entry.roomCode === roomCode);
  }

  private notifyRoom(roomCode: string): void {
    if (!this.broadcastHook) {
      return;
    }

    void this.broadcastHook(roomCode);
  }

  private scheduleDisconnectRemoval(roomId: string, roomCode: string, playerId: string): void {
    this.cancelDisconnectTimer(roomId, playerId);

    const timerKey = `${roomId}:${playerId}`;
    const timeout = setTimeout(() => {
      try {
        const stillDisconnected = this.connection
          .prepare(
            `SELECT connected
             FROM room_players
             WHERE room_id = ? AND player_id = ?
             LIMIT 1`
          )
          .get(roomId, playerId) as { connected: number } | undefined;

        if (!stillDisconnected || stillDisconnected.connected === 1) {
          return;
        }

        const tx = this.connection.transaction(() => {
          this.removeMember(roomId, playerId);
        });
        tx();
      } finally {
        this.disconnectTimers.delete(timerKey);
        this.notifyRoom(roomCode);
      }
    }, LIMITS.reconnectGraceMs);

    this.disconnectTimers.set(timerKey, timeout);
  }

  private cancelDisconnectTimer(roomId: string, playerId: string): void {
    const timerKey = `${roomId}:${playerId}`;
    const timeout = this.disconnectTimers.get(timerKey);
    if (!timeout) {
      return;
    }

    clearTimeout(timeout);
    this.disconnectTimers.delete(timerKey);
  }

  private authenticateSession(roomCode: string, playerId: string, reconnectToken: string): SessionRow {
    const room = this.getRoomByCode(roomCode);
    const activeSession = this.connection
      .prepare(
        `SELECT id, token_hash, revoked_at
         FROM room_sessions
         WHERE room_id = ? AND player_id = ? AND revoked_at IS NULL
         ORDER BY rowid DESC
         LIMIT 1`
      )
      .get(room.id, playerId) as SessionRow | undefined;

    if (!activeSession) {
      throw new ApiError(401, "UNAUTHORIZED", "Session not found for player");
    }

    if (activeSession.token_hash !== hashToken(reconnectToken)) {
      throw new ApiError(401, "UNAUTHORIZED", "Invalid reconnect token");
    }

    return activeSession;
  }

  private upsertSession(roomId: string, playerId: string, reconnectToken: string): SessionBundle {
    const now = nowIso();

    this.connection
      .prepare(
        `UPDATE room_sessions
         SET revoked_at = ?
         WHERE room_id = ? AND player_id = ? AND revoked_at IS NULL`
      )
      .run(now, roomId, playerId);

    this.connection
      .prepare(
        `INSERT INTO room_sessions (id, room_id, player_id, token_hash, created_at, last_used_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(createId("session"), roomId, playerId, hashToken(reconnectToken), now, now);

    return {
      playerId,
      reconnectToken
    };
  }

  private removeMember(roomId: string, playerId: string): void {
    const member = this.connection
      .prepare(
        `SELECT player_id, is_host, connected, join_order
         FROM room_players
         WHERE room_id = ? AND player_id = ?
         LIMIT 1`
      )
      .get(roomId, playerId) as MemberRow | undefined;

    if (!member) {
      return;
    }

    this.cancelDisconnectTimer(roomId, playerId);

    this.connection
      .prepare("UPDATE room_sessions SET revoked_at = ? WHERE room_id = ? AND player_id = ? AND revoked_at IS NULL")
      .run(nowIso(), roomId, playerId);

    this.connection.prepare("DELETE FROM player_hands WHERE room_id = ? AND player_id = ?").run(roomId, playerId);
    this.connection.prepare("DELETE FROM room_players WHERE room_id = ? AND player_id = ?").run(roomId, playerId);

    for (const [socketId, identity] of this.socketIdentities.entries()) {
      if (identity.roomId === roomId && identity.playerId === playerId) {
        this.socketIdentities.delete(socketId);
      }
    }

    if (member.is_host) {
      const nextHost = this.connection
        .prepare(
          `SELECT player_id
           FROM room_players
           WHERE room_id = ?
           ORDER BY connected DESC, join_order ASC
           LIMIT 1`
        )
        .get(roomId) as { player_id: string } | undefined;

      if (nextHost) {
        this.connection.prepare("UPDATE room_players SET is_host = 0 WHERE room_id = ?").run(roomId);
        this.connection
          .prepare("UPDATE room_players SET is_host = 1 WHERE room_id = ? AND player_id = ?")
          .run(roomId, nextHost.player_id);
        this.connection
          .prepare("UPDATE rooms SET host_player_id = ? WHERE id = ?")
          .run(nextHost.player_id, roomId);
      }
    }

    const remainingMembers = (
      this.connection
        .prepare("SELECT COUNT(*) AS count FROM room_players WHERE room_id = ?")
        .get(roomId) as { count: number }
    ).count;

    if (remainingMembers === 0) {
      this.connection.prepare("UPDATE rooms SET status = ? WHERE id = ?").run(ROOM_STATUS.CLOSED, roomId);
      return;
    }

    this.gameEngine.handleMembershipChange(roomId, playerId);

    const activeGame = this.connection
      .prepare(
        `SELECT status
         FROM games
         WHERE room_id = ?
         ORDER BY rowid DESC
         LIMIT 1`
      )
      .get(roomId) as { status: string } | undefined;

    if (activeGame && activeGame.status === GAME_STATUS.OVER) {
      this.connection.prepare("UPDATE rooms SET status = ? WHERE id = ?").run(ROOM_STATUS.OPEN, roomId);
    }
  }

  private getRoomByCode(roomCodeInput: string): RoomRow {
    const roomCode = roomCodeInput.toUpperCase();
    const room = this.connection
      .prepare(
        `SELECT id, code, status, host_player_id, settings_json
         FROM rooms
         WHERE code = ?
         LIMIT 1`
      )
      .get(roomCode) as RoomRow | undefined;

    if (!room) {
      throw new ApiError(404, "ROOM_NOT_FOUND", "Room not found");
    }

    return room;
  }
}
