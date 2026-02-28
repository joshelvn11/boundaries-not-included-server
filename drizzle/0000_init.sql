CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY NOT NULL,
  code TEXT NOT NULL UNIQUE,
  host_player_id TEXT NOT NULL,
  status TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS room_players (
  room_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  is_host INTEGER NOT NULL DEFAULT 0,
  is_ready INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  join_order INTEGER NOT NULL,
  connected INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(room_id, player_id),
  FOREIGN KEY (room_id) REFERENCES rooms(id),
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL,
  status TEXT NOT NULL,
  current_round INTEGER NOT NULL DEFAULT 0,
  winner_player_id TEXT,
  started_at TEXT,
  ended_at TEXT,
  FOREIGN KEY (room_id) REFERENCES rooms(id),
  FOREIGN KEY (winner_player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS rounds (
  id TEXT PRIMARY KEY NOT NULL,
  game_id TEXT NOT NULL,
  round_number INTEGER NOT NULL,
  judge_player_id TEXT NOT NULL,
  black_card_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  FOREIGN KEY (game_id) REFERENCES games(id),
  FOREIGN KEY (judge_player_id) REFERENCES players(id),
  FOREIGN KEY (black_card_id) REFERENCES black_cards(id)
);

CREATE TABLE IF NOT EXISTS round_submissions (
  id TEXT PRIMARY KEY NOT NULL,
  round_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  white_card_id TEXT NOT NULL,
  is_winner INTEGER NOT NULL DEFAULT 0,
  submitted_at TEXT NOT NULL,
  FOREIGN KEY (round_id) REFERENCES rounds(id),
  FOREIGN KEY (player_id) REFERENCES players(id),
  FOREIGN KEY (white_card_id) REFERENCES white_cards(id)
);

CREATE TABLE IF NOT EXISTS white_cards (
  id TEXT PRIMARY KEY NOT NULL,
  text TEXT NOT NULL,
  pack TEXT NOT NULL,
  source_id TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS black_cards (
  id TEXT PRIMARY KEY NOT NULL,
  text TEXT NOT NULL,
  pick_count INTEGER NOT NULL DEFAULT 1,
  pack TEXT NOT NULL,
  source_id TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1
);
