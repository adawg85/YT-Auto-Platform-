ALTER TYPE "public"."alert_kind" ADD VALUE 'viability';--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ADD COLUMN "impressions" integer;