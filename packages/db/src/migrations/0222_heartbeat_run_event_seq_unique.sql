-- Heartbeat run event sequences must be unique per run. Concurrent writers
-- allocated max(seq)+1 outside any lock, so two events could share seq=1
-- (observed historically on run 3c4112e2-0c4b-484c-833d-ea0efa7736ca).
-- Reassign later duplicates to the end of the run's sequence preserving id
-- order, then enforce uniqueness at the database level.
WITH duplicates AS (
  SELECT
    id,
    run_id,
    row_number() OVER (PARTITION BY run_id, seq ORDER BY id) AS duplicate_index
  FROM "heartbeat_run_events"
),
reassignments AS (
  SELECT
    d.id,
    (
      SELECT COALESCE(MAX(h.seq), 0)
      FROM "heartbeat_run_events" h
      WHERE h.run_id = d.run_id
    ) + row_number() OVER (PARTITION BY d.run_id ORDER BY d.id) AS new_seq
  FROM duplicates d
  WHERE d.duplicate_index > 1
)
UPDATE "heartbeat_run_events" h
SET seq = r.new_seq
FROM reassignments r
WHERE h.id = r.id;
--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: heartbeat_run_events holds ~11k rows in this deployment and the migration runner wraps each file in a transaction, where CREATE INDEX CONCURRENTLY is unavailable; the exclusive-lock window is milliseconds.
-- IF NOT EXISTS keeps this idempotent: a partial application by an out-of-band
-- watcher can create the index without recording the journal entry.
CREATE UNIQUE INDEX IF NOT EXISTS "heartbeat_run_events_run_seq_uniq" ON "heartbeat_run_events" ("run_id","seq");
