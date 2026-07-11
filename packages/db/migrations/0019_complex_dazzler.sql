CREATE TYPE "public"."persona_creator" AS ENUM('operator', 'agent');--> statement-breakpoint
CREATE TYPE "public"."persona_status" AS ENUM('draft', 'active', 'testing', 'retired');--> statement-breakpoint
ALTER TYPE "public"."claim_status" ADD VALUE 'conjecture' BEFORE 'cut';--> statement-breakpoint
CREATE TABLE "personas" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text,
	"name" text NOT NULL,
	"archetype" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"parent_id" text,
	"status" "persona_status" DEFAULT 'draft' NOT NULL,
	"created_by" "persona_creator" DEFAULT 'operator' NOT NULL,
	"doc" jsonb NOT NULL,
	"rationale" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_dna" ADD COLUMN "active_persona_id" text;--> statement-breakpoint
ALTER TABLE "productions" ADD COLUMN "persona_id" text;--> statement-breakpoint
ALTER TABLE "productions" ADD COLUMN "persona_version" integer;--> statement-breakpoint
ALTER TABLE "personas" ADD CONSTRAINT "personas_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personas_channel_id_idx" ON "personas" USING btree ("channel_id");