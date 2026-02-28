import crypto from "crypto";

import type Database from "better-sqlite3";

import { ApiError } from "../errors/api-error";
import { GAME_STATUS, LIMITS, ROOM_STATUS, type RoomSettings } from "../types/domain";

type ActiveGameRow = {
  id: string;
  status: string;
  current_round: number;
  target_score: number;
};

type ActiveRoundRow = {
  id: string;
  round_number: number;
  judge_player_id: string;
  pick_count_required: number;
  status: string;
};

type MemberRow = {
  player_id: string;
  join_order: number;
  score: number;
};

type HandRow = {
  id: string;
  white_card_id: string;
};

type BlackCardRow = {
  id: string;
  text: string;
};

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function inferPromptPickCount(promptText: string): number | null {
  const blankCount = promptText.match(/_+/g)?.length ?? 0;
  if (blankCount === 0) {
    return 1;
  }

  if (blankCount > 3) {
    return null;
  }

  return blankCount;
}

export class GameEngineService {
  constructor(private readonly connection: Database.Database) {}

  startGame(roomId: string, settings: RoomSettings): void {
    const connectedPlayers = this.getConnectedMembers(roomId);
    if (connectedPlayers.length < LIMITS.minPlayersToStart) {
      throw new ApiError(409, "NOT_READY_TO_START", "At least 3 connected players are required to start");
    }

    this.assertCardPoolAvailable();

    const gameId = createId("game");
    const roundId = createId("round");
    const startedAt = nowIso();
    const judge = connectedPlayers[0];
    const blackPrompt = this.pickPlayableBlackPrompt();

    this.connection.prepare("DELETE FROM player_hands WHERE room_id = ?").run(roomId);

    this.connection
      .prepare(
        `INSERT INTO games (id, room_id, status, current_round, winner_player_id, started_at, ended_at, target_score, ended_reason)
         VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, NULL)`
      )
      .run(gameId, roomId, GAME_STATUS.SUBMIT, 1, startedAt, settings.targetScore);

    this.connection
      .prepare(
        `INSERT INTO rounds (id, game_id, round_number, judge_player_id, black_card_id, pick_count_required, status, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        roundId,
        gameId,
        1,
        judge.player_id,
        blackPrompt.id,
        blackPrompt.pickCountRequired,
        GAME_STATUS.SUBMIT,
        startedAt
      );

    this.connection.prepare("UPDATE rooms SET status = ? WHERE id = ?").run(ROOM_STATUS.IN_GAME, roomId);
    this.connection.prepare("UPDATE room_players SET score = 0, is_ready = 0 WHERE room_id = ?").run(roomId);

    this.ensureHands(roomId, connectedPlayers.map((row) => row.player_id));
  }

  submitCard(roomId: string, playerId: string, handCardIds: string[]): void {
    const game = this.getActiveGame(roomId);
    const round = this.getCurrentRound(game.id);

    if (round.status !== GAME_STATUS.SUBMIT) {
      throw new ApiError(409, "INVALID_STATE", "Round is not accepting submissions");
    }

    if (round.judge_player_id === playerId) {
      throw new ApiError(403, "FORBIDDEN", "Judge cannot submit a card this round");
    }

    if (handCardIds.length !== round.pick_count_required) {
      const cardWord = round.pick_count_required === 1 ? "card" : "cards";
      throw new ApiError(
        409,
        "INVALID_STATE",
        `This round requires exactly ${round.pick_count_required} ${cardWord}`
      );
    }

    const existingSubmission = this.connection
      .prepare("SELECT 1 FROM round_submissions WHERE round_id = ? AND player_id = ? LIMIT 1")
      .get(round.id, playerId);

    if (existingSubmission) {
      throw new ApiError(409, "INVALID_STATE", "Player already submitted this round");
    }

    const placeholders = handCardIds.map(() => "?").join(", ");
    const handCards = this.connection
      .prepare(
        `SELECT id, white_card_id
         FROM player_hands
         WHERE room_id = ? AND player_id = ? AND id IN (${placeholders})`
      )
      .all(roomId, playerId, ...handCardIds) as HandRow[];

    if (handCards.length !== handCardIds.length) {
      throw new ApiError(422, "CARD_NOT_IN_HAND", "Submitted card is not in player's hand");
    }

    const byHandId = new Map<string, string>(handCards.map((item) => [item.id, item.white_card_id]));

    this.connection
      .prepare(
        `DELETE FROM player_hands
         WHERE room_id = ? AND player_id = ? AND id IN (${placeholders})`
      )
      .run(roomId, playerId, ...handCardIds);

    const submissionGroupId = createId("subgrp");
    const insertSubmission = this.connection.prepare(
      `INSERT INTO round_submissions (
         id, round_id, player_id, white_card_id, submission_group_id, card_order, is_winner, reveal_order, submitted_at
       )
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?)`
    );

    handCardIds.forEach((handCardId, index) => {
      const whiteCardId = byHandId.get(handCardId);
      if (!whiteCardId) {
        throw new ApiError(422, "CARD_NOT_IN_HAND", "Submitted card is not in player's hand");
      }

      insertSubmission.run(
        createId("sub"),
        round.id,
        playerId,
        whiteCardId,
        submissionGroupId,
        index + 1,
        nowIso()
      );
    });

    this.transitionToPickIfReady(roomId, game.id, round.id, round.judge_player_id);
  }

  pickWinner(roomId: string, judgePlayerId: string, submissionId: string): void {
    const game = this.getActiveGame(roomId);
    const round = this.getCurrentRound(game.id);

    if (round.status !== GAME_STATUS.PICK_WINNER) {
      throw new ApiError(409, "INVALID_STATE", "Round is not waiting for judge selection");
    }

    if (round.judge_player_id !== judgePlayerId) {
      throw new ApiError(403, "FORBIDDEN", "Only the active judge can pick a winner");
    }

    const submission = this.connection
      .prepare(
        `SELECT submission_group_id, player_id
         FROM round_submissions
         WHERE submission_group_id = ? AND round_id = ?
         LIMIT 1`
      )
      .get(submissionId, round.id) as
      | { submission_group_id: string; player_id: string }
      | undefined;

    if (!submission) {
      throw new ApiError(404, "INVALID_STATE", "Submission does not belong to current round");
    }

    this.connection.prepare("UPDATE round_submissions SET is_winner = 0 WHERE round_id = ?").run(round.id);
    this.connection
      .prepare("UPDATE round_submissions SET is_winner = 1 WHERE round_id = ? AND submission_group_id = ?")
      .run(round.id, submission.submission_group_id);
    this.connection
      .prepare("UPDATE room_players SET score = score + 1 WHERE room_id = ? AND player_id = ?")
      .run(roomId, submission.player_id);

    this.connection
      .prepare("UPDATE rounds SET status = ?, ended_at = ? WHERE id = ?")
      .run(GAME_STATUS.ROUND_RESULTS, nowIso(), round.id);

    const winnerScore = (
      this.connection
        .prepare("SELECT score FROM room_players WHERE room_id = ? AND player_id = ? LIMIT 1")
        .get(roomId, submission.player_id) as { score: number }
    ).score;

    if (winnerScore >= game.target_score) {
      this.finishGame(roomId, game.id, submission.player_id, "TARGET_SCORE");
      return;
    }

    const connected = this.getConnectedMembers(roomId);
    if (connected.length < LIMITS.minPlayersToStart) {
      this.finishGame(roomId, game.id, submission.player_id, "NOT_ENOUGH_PLAYERS");
      return;
    }

    const nextJudge = this.selectNextJudge(connected, round.judge_player_id);
    const nextRoundNumber = round.round_number + 1;
    const nextRoundId = createId("round");
    const blackPrompt = this.pickPlayableBlackPrompt();

    this.ensureHands(roomId, connected.map((row) => row.player_id));

    this.connection
      .prepare(
        `INSERT INTO rounds (id, game_id, round_number, judge_player_id, black_card_id, pick_count_required, status, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        nextRoundId,
        game.id,
        nextRoundNumber,
        nextJudge.player_id,
        blackPrompt.id,
        blackPrompt.pickCountRequired,
        GAME_STATUS.SUBMIT,
        nowIso()
      );

    this.connection
      .prepare("UPDATE games SET status = ?, current_round = ?, winner_player_id = ? WHERE id = ?")
      .run(GAME_STATUS.SUBMIT, nextRoundNumber, submission.player_id, game.id);
  }

  handleMembershipChange(roomId: string, removedPlayerId: string): void {
    const game = this.getActiveGameOrNull(roomId);
    if (!game) {
      return;
    }

    const connected = this.getConnectedMembers(roomId);

    if (connected.length < LIMITS.minPlayersToStart) {
      this.finishGame(roomId, game.id, null, "NOT_ENOUGH_PLAYERS");
      return;
    }

    const round = this.getCurrentRound(game.id);

    if (round.judge_player_id === removedPlayerId) {
      const replacementJudge = this.selectNextJudge(connected, removedPlayerId);
      this.connection
        .prepare("UPDATE rounds SET judge_player_id = ? WHERE id = ?")
        .run(replacementJudge.player_id, round.id);
    }

    if (round.status === GAME_STATUS.SUBMIT) {
      const judgePlayerId = (
        this.connection
          .prepare("SELECT judge_player_id FROM rounds WHERE id = ? LIMIT 1")
          .get(round.id) as { judge_player_id: string }
      ).judge_player_id;
      this.transitionToPickIfReady(roomId, game.id, round.id, judgePlayerId);
    }
  }

  private transitionToPickIfReady(
    roomId: string,
    gameId: string,
    roundId: string,
    judgePlayerId: string
  ): void {
    const requiredCount = (
      this.connection
        .prepare(
          `SELECT COUNT(*) AS count
           FROM room_players
           WHERE room_id = ? AND connected = 1 AND player_id != ?`
        )
        .get(roomId, judgePlayerId) as { count: number }
    ).count;

    const submittedCount = (
      this.connection
        .prepare(
          `SELECT COUNT(DISTINCT submission_group_id) AS count
           FROM round_submissions
           WHERE round_id = ?`
        )
        .get(roundId) as { count: number }
    ).count;

    if (requiredCount === 0 || submittedCount < requiredCount) {
      return;
    }

    const rows = this.connection
      .prepare(
        `SELECT DISTINCT submission_group_id
         FROM round_submissions
         WHERE round_id = ?
         ORDER BY submission_group_id ASC`
      )
      .all(roundId) as Array<{ submission_group_id: string }>;

    const ordered = shuffle(rows);
    const updateOrder = this.connection.prepare(
      "UPDATE round_submissions SET reveal_order = ? WHERE round_id = ? AND submission_group_id = ?"
    );

    ordered.forEach((item, index) => {
      updateOrder.run(index + 1, roundId, item.submission_group_id);
    });

    this.connection
      .prepare("UPDATE rounds SET status = ? WHERE id = ?")
      .run(GAME_STATUS.PICK_WINNER, roundId);

    this.connection
      .prepare("UPDATE games SET status = ? WHERE id = ?")
      .run(GAME_STATUS.PICK_WINNER, gameId);
  }

  private finishGame(
    roomId: string,
    gameId: string,
    winnerPlayerId: string | null,
    endedReason: string
  ): void {
    this.connection
      .prepare(
        `UPDATE games
         SET status = ?, winner_player_id = ?, ended_at = ?, ended_reason = ?
         WHERE id = ?`
      )
      .run(GAME_STATUS.OVER, winnerPlayerId, nowIso(), endedReason, gameId);

    this.connection
      .prepare("UPDATE rooms SET status = ? WHERE id = ?")
      .run(ROOM_STATUS.OPEN, roomId);

    this.connection.prepare("UPDATE room_players SET is_ready = 0 WHERE room_id = ?").run(roomId);
  }

  private getActiveGame(roomId: string): ActiveGameRow {
    const game = this.getActiveGameOrNull(roomId);
    if (!game) {
      throw new ApiError(409, "INVALID_STATE", "No active game for room");
    }
    return game;
  }

  private getActiveGameOrNull(roomId: string): ActiveGameRow | null {
    const game = this.connection
      .prepare(
        `SELECT id, status, current_round, target_score
         FROM games
         WHERE room_id = ?
         ORDER BY rowid DESC
         LIMIT 1`
      )
      .get(roomId) as ActiveGameRow | undefined;

    if (!game || game.status === GAME_STATUS.OVER) {
      return null;
    }

    return game;
  }

  private getCurrentRound(gameId: string): ActiveRoundRow {
    const round = this.connection
      .prepare(
        `SELECT id, round_number, judge_player_id, pick_count_required, status
         FROM rounds
         WHERE game_id = ?
         ORDER BY round_number DESC
         LIMIT 1`
      )
      .get(gameId) as ActiveRoundRow | undefined;

    if (!round) {
      throw new ApiError(409, "INVALID_STATE", "No active round for game");
    }

    return round;
  }

  private getConnectedMembers(roomId: string): MemberRow[] {
    return this.connection
      .prepare(
        `SELECT player_id, join_order, score
         FROM room_players
         WHERE room_id = ? AND connected = 1
         ORDER BY join_order ASC`
      )
      .all(roomId) as MemberRow[];
  }

  private selectNextJudge(connected: MemberRow[], currentJudgeId: string): MemberRow {
    const currentIndex = connected.findIndex((row) => row.player_id === currentJudgeId);
    if (currentIndex === -1) {
      return connected[0];
    }

    const nextIndex = (currentIndex + 1) % connected.length;
    return connected[nextIndex];
  }

  private ensureHands(roomId: string, playerIds: string[]): void {
    for (const playerId of playerIds) {
      const count = (
        this.connection
          .prepare("SELECT COUNT(*) AS count FROM player_hands WHERE room_id = ? AND player_id = ?")
          .get(roomId, playerId) as { count: number }
      ).count;

      const needed = LIMITS.handSize - count;
      if (needed <= 0) {
        continue;
      }

      const cards = this.connection
        .prepare(
          `SELECT id
           FROM white_cards
           WHERE is_active = 1
             AND id NOT IN (
               SELECT white_card_id FROM player_hands WHERE room_id = ? AND player_id = ?
             )
           ORDER BY RANDOM()
           LIMIT ?`
        )
        .all(roomId, playerId, needed) as Array<{ id: string }>;

      const insertHand = this.connection.prepare(
        `INSERT INTO player_hands (id, room_id, player_id, white_card_id, dealt_at)
         VALUES (?, ?, ?, ?, ?)`
      );

      cards.forEach((card) => {
        insertHand.run(createId("hand"), roomId, playerId, card.id, nowIso());
      });
    }
  }

  private pickPlayableBlackPrompt(): { id: string; pickCountRequired: number } {
    const cards = this.connection
      .prepare("SELECT id, text FROM black_cards WHERE is_active = 1 ORDER BY RANDOM()")
      .all() as BlackCardRow[];

    for (const card of cards) {
      const inferredPickCount = inferPromptPickCount(card.text);
      if (!inferredPickCount) {
        continue;
      }

      return {
        id: card.id,
        pickCountRequired: inferredPickCount
      };
    }

    throw new ApiError(
      409,
      "INVALID_STATE",
      "No playable black cards available for current blank-count rules"
    );
  }

  private assertCardPoolAvailable(): void {
    const whiteCount = (
      this.connection
        .prepare("SELECT COUNT(*) AS count FROM white_cards WHERE is_active = 1")
        .get() as { count: number }
    ).count;

    const blackCount = (
      this.connection
        .prepare("SELECT COUNT(*) AS count FROM black_cards WHERE is_active = 1")
        .get() as { count: number }
    ).count;

    if (whiteCount === 0 || blackCount === 0) {
      throw new ApiError(
        409,
        "INVALID_STATE",
        "Card pool is empty. Run the populator before starting a game"
      );
    }
  }
}
