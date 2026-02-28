import type Database from "better-sqlite3";

import { ApiError } from "../errors/api-error";
import {
  DEFAULT_SETTINGS,
  GAME_STATUS,
  type RoomSettings,
  type RoomSnapshot,
  type RoomStatus
} from "../types/domain";

type RoomRow = {
  id: string;
  code: string;
  status: RoomStatus;
  settings_json: string;
};

type ViewerRow = {
  player_id: string;
  display_name: string;
  is_host: number;
  is_ready: number;
  score: number;
  connected: number;
};

type MemberRow = {
  player_id: string;
  display_name: string;
  is_host: number;
  is_ready: number;
  score: number;
  connected: number;
  hand_count: number;
};

type HandRow = {
  hand_card_id: string;
  card_id: string;
  text: string;
  pack: string;
};

type GameRow = {
  id: string;
  status: string;
  current_round: number;
  winner_player_id: string | null;
  target_score: number;
  ended_reason: string | null;
};

type RoundRow = {
  id: string;
  judge_player_id: string;
  black_card_id: string;
  pick_count_required: number;
  status: string;
};

type PromptRow = {
  card_id: string;
  text: string;
};

type SubmissionRow = {
  submission_group_id: string;
  card_order: number;
  player_id: string;
  display_name: string;
  card_text: string;
  reveal_order: number | null;
  is_winner: number;
};

type GroupedSubmission = {
  submissionId: string;
  revealOrder: number | null;
  playerId: string;
  displayName: string;
  answerCards: string[];
  isWinner: boolean;
};

function parseRoomSettings(raw: string): RoomSettings {
  try {
    const parsed = JSON.parse(raw) as Partial<RoomSettings>;
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

function buildSubmissionText(promptText: string, answerCards: string[]): string {
  const matches = [...promptText.matchAll(/_+/g)];
  if (matches.length === 0) {
    const appended = answerCards.length > 0 ? ` ${answerCards.join(" ")}` : "";
    return `${promptText.trim()}${appended}`.trim();
  }

  let cursor = 0;
  let result = "";

  matches.forEach((match, index) => {
    const matchIndex = match.index ?? 0;
    result += promptText.slice(cursor, matchIndex);
    result += answerCards[index] ?? "_";
    cursor = matchIndex + match[0].length;
  });

  result += promptText.slice(cursor);

  if (answerCards.length > matches.length) {
    result = `${result} ${answerCards.slice(matches.length).join(" ")}`.trim();
  }

  return result.trim();
}

export class SnapshotService {
  constructor(private readonly connection: Database.Database) {}

  getSnapshot(roomCode: string, viewerPlayerId: string): RoomSnapshot {
    const room = this.connection
      .prepare("SELECT id, code, status, settings_json FROM rooms WHERE code = ? LIMIT 1")
      .get(roomCode) as RoomRow | undefined;

    if (!room) {
      throw new ApiError(404, "ROOM_NOT_FOUND", "Room not found");
    }

    const viewer = this.connection
      .prepare(
        `SELECT rp.player_id, p.display_name, rp.is_host, rp.is_ready, rp.score, rp.connected
         FROM room_players rp
         JOIN players p ON p.id = rp.player_id
         WHERE rp.room_id = ? AND rp.player_id = ?
         LIMIT 1`
      )
      .get(room.id, viewerPlayerId) as ViewerRow | undefined;

    if (!viewer) {
      throw new ApiError(401, "UNAUTHORIZED", "Viewer is not a room member");
    }

    const members = this.connection
      .prepare(
        `SELECT rp.player_id, p.display_name, rp.is_host, rp.is_ready, rp.score, rp.connected,
                COALESCE(h.hand_count, 0) AS hand_count
         FROM room_players rp
         JOIN players p ON p.id = rp.player_id
         LEFT JOIN (
           SELECT room_id, player_id, COUNT(*) AS hand_count
           FROM player_hands
           GROUP BY room_id, player_id
         ) h ON h.room_id = rp.room_id AND h.player_id = rp.player_id
         WHERE rp.room_id = ?
         ORDER BY rp.join_order ASC`
      )
      .all(room.id) as MemberRow[];

    const hand = this.connection
      .prepare(
        `SELECT ph.id AS hand_card_id, wc.id AS card_id, wc.text, wc.pack
         FROM player_hands ph
         JOIN white_cards wc ON wc.id = ph.white_card_id
         WHERE ph.room_id = ? AND ph.player_id = ?
         ORDER BY ph.dealt_at ASC, ph.id ASC`
      )
      .all(room.id, viewerPlayerId) as HandRow[];

    const latestGame = this.connection
      .prepare(
        `SELECT id, status, current_round, winner_player_id, target_score, ended_reason
         FROM games
         WHERE room_id = ? AND archived_at IS NULL
         ORDER BY rowid DESC
         LIMIT 1`
      )
      .get(room.id) as GameRow | undefined;

    const snapshot: RoomSnapshot = {
      room: {
        id: room.id,
        code: room.code,
        status: room.status,
        settings: parseRoomSettings(room.settings_json)
      },
      members: members.map((member) => ({
        playerId: member.player_id,
        displayName: member.display_name,
        isHost: Boolean(member.is_host),
        isReady: Boolean(member.is_ready),
        score: member.score,
        connected: Boolean(member.connected),
        handCount: member.hand_count
      })),
      game: null,
      viewer: {
        playerId: viewer.player_id,
        displayName: viewer.display_name,
        isHost: Boolean(viewer.is_host),
        isReady: Boolean(viewer.is_ready),
        score: viewer.score,
        connected: Boolean(viewer.connected),
        hand: hand.map((card) => ({
          handCardId: card.hand_card_id,
          cardId: card.card_id,
          text: card.text,
          pack: card.pack
        }))
      }
    };

    if (!latestGame) {
      return snapshot;
    }

    const round = this.connection
      .prepare(
        `SELECT id, judge_player_id, black_card_id, pick_count_required, status
         FROM rounds
         WHERE game_id = ?
         ORDER BY round_number DESC
         LIMIT 1`
      )
      .get(latestGame.id) as RoundRow | undefined;

    const prompt = round
      ? ((this.connection
          .prepare("SELECT id AS card_id, text FROM black_cards WHERE id = ? LIMIT 1")
          .get(round.black_card_id) as PromptRow | undefined) ?? null)
      : null;

    const submissions = round
      ? ((this.connection
          .prepare(
            `SELECT rs.submission_group_id, rs.card_order, rs.player_id, p.display_name, wc.text AS card_text, rs.reveal_order, rs.is_winner
             FROM round_submissions rs
             JOIN players p ON p.id = rs.player_id
             JOIN white_cards wc ON wc.id = rs.white_card_id
             WHERE rs.round_id = ?
             ORDER BY
               CASE WHEN rs.reveal_order IS NULL THEN 1 ELSE 0 END,
               rs.reveal_order ASC,
               rs.submission_group_id ASC,
               rs.card_order ASC,
               rs.rowid ASC`
          )
          .all(round.id) as SubmissionRow[]) ?? [])
      : [];

    const requiredCount = round
      ? ((this.connection
          .prepare(
            `SELECT COUNT(*) AS count
             FROM room_players
             WHERE room_id = ? AND connected = 1 AND player_id != ?`
          )
          .get(room.id, round.judge_player_id) as { count: number }).count)
      : 0;

    const shouldRevealIdentity =
      latestGame.status === GAME_STATUS.OVER || round?.status === GAME_STATUS.ROUND_RESULTS;

    const groupedSubmissionsMap = new Map<string, GroupedSubmission>();
    for (const row of submissions) {
      const existing = groupedSubmissionsMap.get(row.submission_group_id);
      if (existing) {
        existing.answerCards.push(row.card_text);
        existing.isWinner = existing.isWinner || Boolean(row.is_winner);
        continue;
      }

      groupedSubmissionsMap.set(row.submission_group_id, {
        submissionId: row.submission_group_id,
        revealOrder: row.reveal_order,
        playerId: row.player_id,
        displayName: row.display_name,
        answerCards: [row.card_text],
        isWinner: Boolean(row.is_winner)
      });
    }

    const groupedSubmissions = [...groupedSubmissionsMap.values()];

    const submissionView = groupedSubmissions
      .filter(() => round?.status !== GAME_STATUS.SUBMIT)
      .map((item) => {
        const text = prompt ? buildSubmissionText(prompt.text, item.answerCards) : item.answerCards.join(" ");

        if (shouldRevealIdentity) {
          return {
            submissionId: item.submissionId,
            text,
            answerCards: item.answerCards,
            revealOrder: item.revealOrder,
            playerId: item.playerId,
            displayName: item.displayName,
            isWinner: item.isWinner
          };
        }

        return {
          submissionId: item.submissionId,
          text,
          answerCards: item.answerCards,
          revealOrder: item.revealOrder
        };
      });

    snapshot.game = {
      id: latestGame.id,
      status: latestGame.status as
        | "ROUND_SUBMIT"
        | "ROUND_PICK_WINNER"
        | "ROUND_RESULTS"
        | "GAME_OVER",
      currentRound: latestGame.current_round,
      judgePlayerId: round?.judge_player_id ?? null,
      prompt: prompt
        ? {
            cardId: prompt.card_id,
            text: prompt.text,
            pickCount: round?.pick_count_required ?? 1
          }
        : null,
      submissions: submissionView,
      submittedCount: groupedSubmissions.length,
      requiredCount,
      winnerPlayerId: latestGame.winner_player_id,
      endedReason: latestGame.ended_reason
    };

    return snapshot;
  }
}
