-- Tickets #126 + #127. Hand-written (enum value + data repair + trigger —
-- drizzle-kit only diffs schema).

-- #126: a new alert kind for "the platform's publication record disagrees with
-- YouTube". First user: a scheduled video observed PUBLIC before its slot.
-- ADD VALUE is transaction-safe on PG12+ as long as the value is not USED in the
-- same transaction — nothing below uses it.
ALTER TYPE "alert_kind" ADD VALUE IF NOT EXISTS 'publish_drift';
--> statement-breakpoint

-- #127 (1/2) — repair: collapse duplicate PENDING gates to the newest one per
-- production. Two reopen_stage calls on the same stage raced two pipeline runs
-- into minting two live gates for one production, and the review booth rendered
-- the video twice with its own Approve/Revise/Reject buttons on each. The newest
-- gate is the surviving one: it reflects the most recent reopen (and its mode).
UPDATE "review_gates" g
SET "status" = 'expired', "updated_at" = now()
WHERE g."status" = 'pending'
  AND EXISTS (
    SELECT 1 FROM "review_gates" newer
    WHERE newer."production_id" = g."production_id"
      AND newer."status" = 'pending'
      AND (newer."created_at" > g."created_at"
           OR (newer."created_at" = g."created_at" AND newer."id" > g."id"))
  );
--> statement-breakpoint

-- #127 (2/2) — data-layer enforcement: ONE pending gate per production. Creating
-- a gate means "the production is waiting HERE" (every creation site writes
-- productions.current_gate_id in the same breath), so any other pending gate is
-- already unreachable from the production row. Expiring on INSERT closes the race
-- that expiring at reopen time cannot: the first reopen's run had not yet created
-- its gate when the second reopen swept.
CREATE OR REPLACE FUNCTION "supersede_pending_gates_on_insert"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'pending' THEN
    UPDATE "review_gates"
    SET "status" = 'expired', "updated_at" = now()
    WHERE "production_id" = NEW."production_id"
      AND "status" = 'pending'
      AND "id" <> NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "trg_supersede_pending_gates_on_insert" ON "review_gates";
--> statement-breakpoint

CREATE TRIGGER "trg_supersede_pending_gates_on_insert"
AFTER INSERT ON "review_gates"
FOR EACH ROW EXECUTE FUNCTION "supersede_pending_gates_on_insert"();
