-- #119: the bed's least-recently-used rotation had no sort key — lastUsedAt was
-- only written by the pipeline's automatic pick, never by operator/agent
-- selections, so every bed track read null and the same track landed on
-- consecutive videos (which also concentrated the Content ID exposure on one
-- track). used_count is the deterministic tie-break for fresh beds and the
-- audit field get_music now reports.
ALTER TABLE "channel_music" ADD COLUMN "used_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Backfill from real selection history: any production_music row that is the
-- selected track and shares a storage key with a bed row on the production's
-- channel counts as a use. The first post-fix rotation starts from actual
-- history rather than a flat null set.
UPDATE "channel_music" cm
SET
  "last_used_at" = COALESCE(cm."last_used_at", s.last_at),
  "used_count" = GREATEST(cm."used_count", s.cnt)
FROM (
  SELECT p."channel_id" AS channel_id, pm."storage_key" AS storage_key,
         MAX(pm."created_at") AS last_at, COUNT(*)::int AS cnt
  FROM "production_music" pm
  JOIN "productions" p ON p."id" = pm."production_id"
  WHERE pm."selected" = true
  GROUP BY p."channel_id", pm."storage_key"
) s
WHERE s.channel_id = cm."channel_id" AND s.storage_key = cm."storage_key";
