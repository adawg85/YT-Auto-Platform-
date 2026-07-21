-- Ticket 01KY1SWM… — a review gate must never outlive its production.
-- Hand-written data + trigger migration (drizzle-kit only diffs schema).

-- 1) Sweep existing orphans: expire every pending gate whose production is
--    already in a dead state (retired/failed/halted/superseded/rejected).
UPDATE "review_gates" g
SET "status" = 'expired', "updated_at" = now()
FROM "productions" p
WHERE g."production_id" = p."id"
  AND g."status" = 'pending'
  AND p."status" IN ('rejected', 'failed', 'halted', 'superseded', 'retired');
--> statement-breakpoint

-- 2) Data-layer enforcement: whenever a production transitions INTO a dead
--    state, auto-expire its pending gates so no future code path can leak an
--    orphan. AFTER UPDATE OF status keeps it cheap (fires only on status change).
CREATE OR REPLACE FUNCTION "expire_gates_on_dead_production"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" IN ('rejected', 'failed', 'halted', 'superseded', 'retired')
     AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    UPDATE "review_gates"
    SET "status" = 'expired', "updated_at" = now()
    WHERE "production_id" = NEW."id" AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "trg_expire_gates_on_dead_production" ON "productions";
--> statement-breakpoint

CREATE TRIGGER "trg_expire_gates_on_dead_production"
AFTER UPDATE OF "status" ON "productions"
FOR EACH ROW EXECUTE FUNCTION "expire_gates_on_dead_production"();
