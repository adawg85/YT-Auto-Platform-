ALTER TYPE "public"."gate_kind" ADD VALUE 'profile_review' BEFORE 'thumbnail_review';--> statement-breakpoint
ALTER TYPE "public"."production_status" ADD VALUE 'profile_review' BEFORE 'producing_assets';--> statement-breakpoint
ALTER TABLE "productions" ADD COLUMN "production_profile" jsonb;