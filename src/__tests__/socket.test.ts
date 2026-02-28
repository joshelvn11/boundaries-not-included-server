import fs from "fs";
import os from "os";
import path from "path";
import { createServer } from "http";

import type Database from "better-sqlite3";
import { io as createClientSocket, type Socket as ClientSocket } from "socket.io-client";
import { Server as SocketIOServer } from "socket.io";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../app";
import { createDb } from "../db/client";
import { runMigrations } from "../db/migrate";
import { RoomLifecycleService } from "../services/room-lifecycle.service";
import { setupRealtime } from "../socket/realtime";

let dbPath = "";
let ioServer: SocketIOServer;
let clientSockets: ClientSocket[] = [];
let serverPort = 0;
let closeServer: (() => Promise<void>) | null = null;
let roomService: RoomLifecycleService;
let connection: Database.Database | null = null;

type Auth = {
  playerId: string;
  reconnectToken: string;
};

function onceEvent<T = unknown>(socket: ClientSocket, eventName: string): Promise<T> {
  return new Promise((resolve) => {
    socket.once(eventName, (payload: T) => {
      resolve(payload);
    });
  });
}

function waitForRoomState(
  socket: ClientSocket,
  predicate: (payload: { game: unknown; room: { status: string } }) => boolean
): Promise<{ game: unknown; room: { status: string } }> {
  return new Promise((resolve) => {
    const handler = (payload: { game: unknown; room: { status: string } }) => {
      if (!predicate(payload)) {
        return;
      }

      socket.off("room:state", handler);
      resolve(payload);
    };

    socket.on("room:state", handler);
  });
}

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `bni-socket-test-${Date.now()}-${Math.random()}.sqlite`);
  await runMigrations(dbPath, path.resolve(process.cwd(), "drizzle"));

  ({ connection } = createDb(dbPath));
  connection
    .prepare(
      `INSERT INTO white_cards (id, text, pack, source_id, is_active)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run("white_1", "A tiny horse", "base", "white_source_1", 1);
  connection
    .prepare(
      `INSERT INTO black_cards (id, text, pick_count, pack, source_id, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run("black_1", "____ ruined my summer.", 1, "base", "black_source_1", 1);

  roomService = new RoomLifecycleService(connection);

  const app = createApp(
    {
      PORT: 4000,
      CORS_ORIGIN: "*",
      BNI_SQLITE_PATH: dbPath
    },
    { roomService }
  );

  const httpServer = createServer(app);
  ioServer = new SocketIOServer(httpServer, {
    cors: {
      origin: "*"
    }
  });

  setupRealtime(ioServer, roomService);

  await new Promise<void>((resolve) => {
    httpServer.listen(0, () => {
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        throw new Error("Unable to resolve socket test server port");
      }

      serverPort = address.port;
      resolve();
    });
  });

  closeServer = async () => {
    await new Promise<void>((resolve) => {
      ioServer.close(() => {
        httpServer.close(() => resolve());
      });
    });
  };
});

afterEach(async () => {
  for (const socket of clientSockets) {
    socket.removeAllListeners();
    socket.disconnect();
  }
  clientSockets = [];

  if (closeServer) {
    await closeServer();
    closeServer = null;
  }

  if (connection) {
    connection.close();
    connection = null;
  }

  if (dbPath && fs.existsSync(dbPath)) {
    fs.rmSync(dbPath, { force: true });
  }
});

describe("socket authentication and state emission", () => {
  it("emits room:state on valid socket handshake", async () => {
    const room = roomService.createRoom({ displayName: "Host" });

    const socket = createClientSocket(`http://127.0.0.1:${serverPort}`, {
      transports: ["websocket"],
      auth: {
        roomCode: room.roomCode,
        playerId: room.playerId,
        reconnectToken: room.reconnectToken
      }
    });
    clientSockets.push(socket);

    const snapshot = await onceEvent<{ room: { code: string } }>(socket, "room:state");
    expect(snapshot.room.code).toBe(room.roomCode);
  });

  it("emits error and disconnects for invalid token", async () => {
    const room = roomService.createRoom({ displayName: "Host" });

    const socket = createClientSocket(`http://127.0.0.1:${serverPort}`, {
      transports: ["websocket"],
      auth: {
        roomCode: room.roomCode,
        playerId: room.playerId,
        reconnectToken: "wrong-token"
      }
    });
    clientSockets.push(socket);

    const payload = await onceEvent<{ error: string }>(socket, "error");
    expect(payload.error).toBe("UNAUTHORIZED");
  });

  it("emits lobby snapshot to connected clients after host play-again", async () => {
    const host = roomService.createRoom({ displayName: "Host" });
    const join2 = roomService.joinRoom(host.roomCode, { displayName: "Player 2" });
    const join3 = roomService.joinRoom(host.roomCode, { displayName: "Player 3" });

    const hostAuth: Auth = { playerId: host.playerId, reconnectToken: host.reconnectToken };
    const player2Auth: Auth = { playerId: join2.playerId, reconnectToken: join2.reconnectToken };
    const player3Auth: Auth = { playerId: join3.playerId, reconnectToken: join3.reconnectToken };

    roomService.setReady(
      roomService.authenticateRequest(host.roomCode, player2Auth.playerId, player2Auth.reconnectToken),
      { isReady: true }
    );
    roomService.setReady(
      roomService.authenticateRequest(host.roomCode, player3Auth.playerId, player3Auth.reconnectToken),
      { isReady: true }
    );

    roomService.startGame(
      roomService.authenticateRequest(host.roomCode, hostAuth.playerId, hostAuth.reconnectToken)
    );

    const startSnapshot = roomService.getSnapshotForPlayer(host.roomCode, hostAuth.playerId);
    const judgePlayerId = startSnapshot.game?.judgePlayerId;
    const participants = [hostAuth, player2Auth, player3Auth].filter(
      (item) => item.playerId !== judgePlayerId
    );

    for (const participant of participants) {
      const snapshot = roomService.getSnapshotForPlayer(host.roomCode, participant.playerId);
      const pickCount = snapshot.game?.prompt?.pickCount ?? 1;
      roomService.submitCard(
        roomService.authenticateRequest(host.roomCode, participant.playerId, participant.reconnectToken),
        {
          handCardIds: snapshot.viewer.hand.slice(0, pickCount).map((card) => card.handCardId)
        }
      );
    }

    const judgeAuth = [hostAuth, player2Auth, player3Auth].find(
      (item) => item.playerId === judgePlayerId
    ) as Auth;
    const pickSnapshot = roomService.getSnapshotForPlayer(host.roomCode, judgeAuth.playerId);
    const submissionId = pickSnapshot.game?.submissions[0].submissionId as string;

    if (!connection) {
      throw new Error("Database connection not initialized");
    }

    const winnerRow = connection
      .prepare("SELECT player_id FROM round_submissions WHERE submission_group_id = ? LIMIT 1")
      .get(submissionId) as { player_id: string } | undefined;
    const roomRow = connection
      .prepare("SELECT id FROM rooms WHERE code = ? LIMIT 1")
      .get(host.roomCode) as { id: string } | undefined;

    if (!winnerRow || !roomRow) {
      throw new Error("Unable to resolve round submission winner setup");
    }

    connection
      .prepare("UPDATE room_players SET score = 6 WHERE room_id = ? AND player_id = ?")
      .run(roomRow.id, winnerRow.player_id);

    roomService.pickWinner(
      roomService.authenticateRequest(host.roomCode, judgeAuth.playerId, judgeAuth.reconnectToken),
      { submissionId }
    );

    const finalSnapshot = roomService.getSnapshotForPlayer(host.roomCode, hostAuth.playerId);
    expect(finalSnapshot.game?.status).toBe("GAME_OVER");

    const hostSocket = createClientSocket(`http://127.0.0.1:${serverPort}`, {
      transports: ["websocket"],
      auth: {
        roomCode: host.roomCode,
        playerId: hostAuth.playerId,
        reconnectToken: hostAuth.reconnectToken
      }
    });
    const player2Socket = createClientSocket(`http://127.0.0.1:${serverPort}`, {
      transports: ["websocket"],
      auth: {
        roomCode: host.roomCode,
        playerId: player2Auth.playerId,
        reconnectToken: player2Auth.reconnectToken
      }
    });

    clientSockets.push(hostSocket, player2Socket);

    await onceEvent(hostSocket, "room:state");
    await onceEvent(player2Socket, "room:state");

    const hostLobbyState = waitForRoomState(hostSocket, (payload) => payload.game === null);
    const player2LobbyState = waitForRoomState(player2Socket, (payload) => payload.game === null);

    roomService.playAgain(
      roomService.authenticateRequest(host.roomCode, hostAuth.playerId, hostAuth.reconnectToken)
    );

    const [hostUpdate, player2Update] = await Promise.all([hostLobbyState, player2LobbyState]);

    expect(hostUpdate.room.status).toBe("ROOM_OPEN");
    expect(hostUpdate.game).toBeNull();
    expect(player2Update.room.status).toBe("ROOM_OPEN");
    expect(player2Update.game).toBeNull();
  });
});
