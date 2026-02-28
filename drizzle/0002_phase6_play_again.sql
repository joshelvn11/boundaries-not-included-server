ALTER TABLE games ADD COLUMN archived_at TEXT;

CREATE INDEX IF NOT EXISTS idx_games_room_archived_rowid ON games(room_id, archived_at);
