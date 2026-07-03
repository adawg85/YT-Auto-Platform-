CREATE TYPE "public"."hook_archetype" AS ENUM('curiosity_gap', 'pattern_interrupt', 'stakes_first', 'contrarian');--> statement-breakpoint
CREATE TABLE "hook_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"archetype" "hook_archetype" NOT NULL,
	"skeleton" jsonb NOT NULL,
	"source_ref" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_dna" ADD COLUMN "thumbnail_spec" jsonb;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "fast_track" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "script_drafts" ADD COLUMN "hook_template_id" text;