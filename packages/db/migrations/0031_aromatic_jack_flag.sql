ALTER TYPE "public"."pattern_kind" ADD VALUE 'thumbnail';--> statement-breakpoint
ALTER TABLE "thumbnails" ADD COLUMN "meta" jsonb;