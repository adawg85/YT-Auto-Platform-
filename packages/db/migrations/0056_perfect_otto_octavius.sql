ALTER TABLE "analytics_snapshots" ADD COLUMN "estimated_minutes_watched" real;--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ADD COLUMN "likes" integer;--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ADD COLUMN "comments" integer;--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ADD COLUMN "shares" integer;--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ADD COLUMN "traffic_sources" jsonb;