-- Operator report 2026-08-13: productions at the final gate never appear in the
-- Review queue. Root state: a gate that times out (7d) parks the production
-- on_hold and the queue lists only pending gates. Two data repairs ride the
-- code fix:
--
-- 1) A stale pipeline run's gate-timeout write CLOBBERED a production that had
--    already been published (live since 2026-07-27, marked on_hold 2026-08-02).
--    Restore `published` where a real publication exists — the worker now also
--    guards this path so it cannot recur.
UPDATE "productions" p
SET "status" = 'published', "failure_reason" = NULL, "halt_kind" = NULL
WHERE p."status" = 'on_hold'
  AND p."failure_reason" LIKE '%gate timed out%'
  AND EXISTS (
    SELECT 1 FROM "publications" pub
    WHERE pub."production_id" = p."id"
      AND pub."provider_video_id" IS NOT NULL
      AND pub."published_at" IS NOT NULL
  );
--> statement-breakpoint
-- 2) Timed-out rows written before migration 0073 added halt_kind carry the
--    timeout only in prose, so they classify as `precondition` — whose recovery
--    guidance is wrong for a timeout, and which makes force_forward REFUSE the
--    unblock. Backfill the class from the reason text.
UPDATE "productions"
SET "halt_kind" = 'gate_timeout'
WHERE "status" = 'on_hold'
  AND "halt_kind" IS NULL
  AND "failure_reason" LIKE '%gate timed out%';
