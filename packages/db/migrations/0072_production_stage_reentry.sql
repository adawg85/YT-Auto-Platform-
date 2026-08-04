-- Stage re-entry (2026-08-04 operator design session).
--
-- The standing complaint was "every time we hit an issue, it pushes me way back
-- to the start". That was structurally true: force_forward and retry_production
-- both re-fire production/greenlit and lean on skip-if-present, so every
-- recovery LOOKED like a restart, and resume_production went further and minted
-- a whole new production row (the sibling lineage behind #94, #96 and #97).
--
-- These two columns are the whole state needed for in-place re-entry. When a
-- stage is REOPENED we record which one and how; everything downstream of it is
-- then derivable (packages/core/src/production-stages.ts) rather than stored, so
-- the staleness rules live in one tested place instead of in the data.
--
-- Deletion is deferred: reopening marks downstream work stale and shows it as
-- such, and the artifacts are destroyed only when the reopened stage actually
-- produces new output. Until then the operator can cancel the reopen and get
-- the production back untouched — reopening is frequently diagnostic, and a
-- diagnostic action must not be destructive.
ALTER TABLE "productions" ADD COLUMN IF NOT EXISTS "reopened_stage" text;--> statement-breakpoint
ALTER TABLE "productions" ADD COLUMN IF NOT EXISTS "reopen_mode" text;--> statement-breakpoint
ALTER TABLE "productions" ADD COLUMN IF NOT EXISTS "reopened_at" timestamp with time zone;
