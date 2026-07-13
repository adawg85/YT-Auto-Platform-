CREATE TYPE "public"."visual_style_status" AS ENUM('draft', 'active', 'testing', 'retired');--> statement-breakpoint
CREATE TABLE "visual_style_refs" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"source" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visual_styles" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"parent_id" text,
	"status" "visual_style_status" DEFAULT 'draft' NOT NULL,
	"created_by" "persona_creator" DEFAULT 'operator' NOT NULL,
	"doc" jsonb NOT NULL,
	"rationale" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_dna" ADD COLUMN "active_style_id" text;--> statement-breakpoint
ALTER TABLE "productions" ADD COLUMN "style_id" text;--> statement-breakpoint
ALTER TABLE "productions" ADD COLUMN "style_version" integer;--> statement-breakpoint
ALTER TABLE "visual_style_refs" ADD CONSTRAINT "visual_style_refs_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visual_styles" ADD CONSTRAINT "visual_styles_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "visual_style_refs_channel_id_idx" ON "visual_style_refs" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "visual_styles_channel_id_idx" ON "visual_styles" USING btree ("channel_id");