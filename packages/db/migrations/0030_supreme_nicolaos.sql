ALTER TYPE "public"."asset_kind" ADD VALUE 'voiceover_take' BEFORE 'image';--> statement-breakpoint
ALTER TYPE "public"."gate_kind" ADD VALUE 'voiceover_recording' BEFORE 'visuals_review';--> statement-breakpoint
ALTER TYPE "public"."production_status" ADD VALUE 'voiceover_recording' BEFORE 'producing_assets';--> statement-breakpoint
ALTER TABLE "productions" ADD COLUMN "voice_source" text DEFAULT 'tts' NOT NULL;