-- Durable operator-job queue (2026-07-25 operator: "all things should queue
-- prompts or images, and there should be a persistent count on the queue at the
-- top always").
--
-- Queued shot work now has a ROW, not just an in-flight Inngest event, so the
-- cockpit can show a truthful "N queued" count that survives a refresh and a
-- browser restart — and so a job that fails on the worker leaves evidence
-- instead of vanishing.
CREATE TABLE "shot_jobs" (
  "id" text PRIMARY KEY NOT NULL,
  "production_id" text NOT NULL,
  "channel_id" text,
  "op" text NOT NULL,
  "asset_id" text,
  "status" text DEFAULT 'queued' NOT NULL,
  "detail" jsonb,
  "error" text,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "shot_jobs_production_id_idx" ON "shot_jobs" ("production_id");--> statement-breakpoint
CREATE INDEX "shot_jobs_status_idx" ON "shot_jobs" ("status");
