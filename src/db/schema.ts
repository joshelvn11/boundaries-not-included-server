import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const rooms = sqliteTable("rooms", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  hostPlayerId: text("host_player_id").notNull(),
  status: text("status").notNull(),
  settingsJson: text("settings_json").notNull(),
  createdAt: text("created_at").notNull()
});

export const players = sqliteTable("players", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  createdAt: text("created_at").notNull()
});

export const roomPlayers = sqliteTable(
  "room_players",
  {
    roomId: text("room_id").notNull(),
    playerId: text("player_id").notNull(),
    isHost: integer("is_host", { mode: "boolean" }).notNull().default(false),
    isReady: integer("is_ready", { mode: "boolean" }).notNull().default(false),
    score: integer("score").notNull().default(0),
    joinOrder: integer("join_order").notNull(),
    connected: integer("connected", { mode: "boolean" }).notNull().default(true)
  },
  (table) => ({
    pk: primaryKey({ columns: [table.roomId, table.playerId] }),
    roomConnectedJoinOrderIdx: index("idx_room_players_room_connected_join_order").on(
      table.roomId,
      table.connected,
      table.joinOrder
    )
  })
);

export const games = sqliteTable("games", {
  id: text("id").primaryKey(),
  roomId: text("room_id").notNull(),
  status: text("status").notNull(),
  currentRound: integer("current_round").notNull().default(0),
  winnerPlayerId: text("winner_player_id"),
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
  targetScore: integer("target_score").notNull().default(7),
  endedReason: text("ended_reason"),
  archivedAt: text("archived_at")
});

export const rounds = sqliteTable("rounds", {
  id: text("id").primaryKey(),
  gameId: text("game_id").notNull(),
  roundNumber: integer("round_number").notNull(),
  judgePlayerId: text("judge_player_id").notNull(),
  blackCardId: text("black_card_id").notNull(),
  pickCountRequired: integer("pick_count_required").notNull().default(1),
  status: text("status").notNull(),
  startedAt: text("started_at"),
  endedAt: text("ended_at")
});

export const roundSubmissions = sqliteTable(
  "round_submissions",
  {
    id: text("id").primaryKey(),
    roundId: text("round_id").notNull(),
    playerId: text("player_id").notNull(),
    whiteCardId: text("white_card_id").notNull(),
    submissionGroupId: text("submission_group_id"),
    cardOrder: integer("card_order").notNull().default(1),
    isWinner: integer("is_winner", { mode: "boolean" }).notNull().default(false),
    revealOrder: integer("reveal_order"),
    submittedAt: text("submitted_at").notNull()
  },
  (table) => ({
    roundRevealOrderIdx: index("idx_round_submissions_round_reveal_order").on(
      table.roundId,
      table.revealOrder
    ),
    roundGroupIdx: index("idx_round_submissions_round_group").on(
      table.roundId,
      table.submissionGroupId
    ),
    roundGroupOrderIdx: index("idx_round_submissions_round_group_order").on(
      table.roundId,
      table.submissionGroupId,
      table.cardOrder
    )
  })
);

export const roomSessions = sqliteTable(
  "room_sessions",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id").notNull(),
    playerId: text("player_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
    revokedAt: text("revoked_at")
  },
  (table) => ({
    roomPlayerIdx: index("idx_room_sessions_room_player_revoked").on(
      table.roomId,
      table.playerId,
      table.revokedAt
    )
  })
);

export const playerHands = sqliteTable(
  "player_hands",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id").notNull(),
    playerId: text("player_id").notNull(),
    whiteCardId: text("white_card_id").notNull(),
    dealtAt: text("dealt_at").notNull()
  },
  (table) => ({
    roomPlayerIdx: index("idx_player_hands_room_player").on(table.roomId, table.playerId)
  })
);

export const whiteCards = sqliteTable("white_cards", {
  id: text("id").primaryKey(),
  text: text("text").notNull(),
  pack: text("pack").notNull(),
  sourceId: text("source_id").notNull().unique(),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true)
});

export const blackCards = sqliteTable("black_cards", {
  id: text("id").primaryKey(),
  text: text("text").notNull(),
  pickCount: integer("pick_count").notNull().default(1),
  pack: text("pack").notNull(),
  sourceId: text("source_id").notNull().unique(),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true)
});
