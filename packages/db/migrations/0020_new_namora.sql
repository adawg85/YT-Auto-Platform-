ALTER TYPE "public"."alert_kind" ADD VALUE 'capacity';--> statement-breakpoint
ALTER TABLE "alerts" ALTER COLUMN "channel_id" DROP NOT NULL;