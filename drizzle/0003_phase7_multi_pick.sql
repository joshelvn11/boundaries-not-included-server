ALTER TABLE rounds ADD COLUMN pick_count_required INTEGER NOT NULL DEFAULT 1;

ALTER TABLE round_submissions ADD COLUMN submission_group_id TEXT;
ALTER TABLE round_submissions ADD COLUMN card_order INTEGER NOT NULL DEFAULT 1;

UPDATE round_submissions
SET submission_group_id = id
WHERE submission_group_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_round_submissions_round_group
  ON round_submissions(round_id, submission_group_id);

CREATE INDEX IF NOT EXISTS idx_round_submissions_round_group_order
  ON round_submissions(round_id, submission_group_id, card_order);
