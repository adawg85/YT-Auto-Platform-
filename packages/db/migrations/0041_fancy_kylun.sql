ALTER TYPE "public"."production_status" ADD VALUE 'superseded';--> statement-breakpoint
ALTER TABLE "productions" ADD COLUMN "supersedes_production_id" text;--> statement-breakpoint
ALTER TABLE "productions" ADD COLUMN "supersede_delete_old" boolean DEFAULT false NOT NULL;