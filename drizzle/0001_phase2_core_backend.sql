ALTER TABLE games ADD COLUMN target_score INTEGER NOT NULL DEFAULT 7;
ALTER TABLE games ADD COLUMN ended_reason TEXT;

ALTER TABLE round_submissions ADD COLUMN reveal_order INTEGER;

CREATE TABLE IF NOT EXISTS room_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (room_id) REFERENCES rooms(id),
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS player_hands (
  id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  white_card_id TEXT NOT NULL,
  dealt_at TEXT NOT NULL,
  FOREIGN KEY (room_id) REFERENCES rooms(id),
  FOREIGN KEY (player_id) REFERENCES players(id),
  FOREIGN KEY (white_card_id) REFERENCES white_cards(id)
);

CREATE INDEX IF NOT EXISTS idx_room_players_room_connected_join_order
  ON room_players(room_id, connected, join_order);

CREATE INDEX IF NOT EXISTS idx_round_submissions_round_reveal_order
  ON round_submissions(round_id, reveal_order);

CREATE INDEX IF NOT EXISTS idx_room_sessions_room_player_revoked
  ON room_sessions(room_id, player_id, revoked_at);

CREATE INDEX IF NOT EXISTS idx_player_hands_room_player
  ON player_hands(room_id, player_id);
