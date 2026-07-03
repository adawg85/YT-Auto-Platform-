CREATE TYPE "public"."asset_kind" AS ENUM('voiceover', 'image', 'render', 'caption_track', 'thumbnail');--> statement-breakpoint
CREATE TYPE "public"."channel_status" AS ENUM('active', 'paused', 'archived');--> statement-breakpoint
CREATE TYPE "public"."cost_category" AS ENUM('llm', 'voice', 'media', 'research', 'publish', 'render');--> statement-breakpoint
CREATE TYPE "public"."gate_decision" AS ENUM('approved', 'rejected', 'revise');--> statement-breakpoint
CREATE TYPE "public"."gate_kind" AS ENUM('script_review', 'thumbnail_review');--> statement-breakpoint
CREATE TYPE "public"."gate_status" AS ENUM('pending', 'decided', 'expired');--> statement-breakpoint
CREATE TYPE "public"."idea_source" AS ENUM('agent', 'manual', 'research');--> statement-breakpoint
CREATE TYPE "public"."idea_status" AS ENUM('inbox', 'scored', 'greenlit', 'rejected', 'archived');--> statement-breakpoint
CREATE TYPE "public"."production_status" AS ENUM('proposed', 'scored', 'greenlit', 'scripting', 'script_review', 'producing_assets', 'assembling', 'thumbnail_review', 'ready', 'scheduled', 'published', 'analysing', 'rejected', 'failed', 'on_hold');--> statement-breakpoint
CREATE TABLE "agent_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_name" text NOT NULL,
	"tier" text,
	"model" text,
	"channel_id" text,
	"idea_id" text,
	"production_id" text,
	"input_summary" text NOT NULL,
	"output" jsonb,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"publication_id" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"avg_view_duration_sec" real,
	"ctr" real,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" text PRIMARY KEY NOT NULL,
	"production_id" text NOT NULL,
	"kind" "asset_kind" NOT NULL,
	"idx" integer DEFAULT 0 NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"duration_sec" real,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_dna" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"tone" text NOT NULL,
	"audience_persona" text NOT NULL,
	"hook_styles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"forbidden_topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"visual_style" jsonb NOT NULL,
	"voice_id" text NOT NULL,
	"cta_template" text NOT NULL,
	"target_length_sec" integer DEFAULT 45 NOT NULL,
	"cadence_per_week" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"handle" text NOT NULL,
	"niche" text NOT NULL,
	"status" "channel_status" DEFAULT 'active' NOT NULL,
	"autonomy_tier" integer DEFAULT 0 NOT NULL,
	"youtube_channel_id" text,
	"oauth_token_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_records" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"production_id" text,
	"category" "cost_category" NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"units" jsonb NOT NULL,
	"cost_usd" numeric(10, 6) NOT NULL,
	"agent_action_id" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ideas" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"title" text NOT NULL,
	"angle" text NOT NULL,
	"source_type" "idea_source" DEFAULT 'manual' NOT NULL,
	"research_refs" jsonb,
	"status" "idea_status" DEFAULT 'inbox' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "productions" (
	"id" text PRIMARY KEY NOT NULL,
	"idea_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"status" "production_status" DEFAULT 'greenlit' NOT NULL,
	"current_gate_id" text,
	"revision_count" integer DEFAULT 0 NOT NULL,
	"substance_fingerprint" text,
	"failure_reason" text,
	"inngest_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publications" (
	"id" text PRIMARY KEY NOT NULL,
	"production_id" text NOT NULL,
	"provider" text DEFAULT 'youtube' NOT NULL,
	"provider_video_id" text NOT NULL,
	"url" text NOT NULL,
	"privacy_status" text DEFAULT 'private' NOT NULL,
	"ai_disclosure" boolean DEFAULT true NOT NULL,
	"published_at" timestamp with time zone,
	"scheduled_for" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_gates" (
	"id" text PRIMARY KEY NOT NULL,
	"production_id" text NOT NULL,
	"kind" "gate_kind" NOT NULL,
	"status" "gate_status" DEFAULT 'pending' NOT NULL,
	"decision" "gate_decision",
	"notes" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"payload_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scores" (
	"id" text PRIMARY KEY NOT NULL,
	"idea_id" text NOT NULL,
	"rubric" jsonb NOT NULL,
	"weighted_total" real NOT NULL,
	"model_used" text NOT NULL,
	"agent_action_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "script_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"production_id" text NOT NULL,
	"version" integer NOT NULL,
	"hook_text" text NOT NULL,
	"beats" jsonb NOT NULL,
	"full_text" text NOT NULL,
	"word_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thumbnails" (
	"id" text PRIMARY KEY NOT NULL,
	"production_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"selected" boolean DEFAULT false NOT NULL,
	"predicted_ctr" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ADD CONSTRAINT "analytics_snapshots_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_production_id_productions_id_fk" FOREIGN KEY ("production_id") REFERENCES "public"."productions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_dna" ADD CONSTRAINT "channel_dna_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "productions" ADD CONSTRAINT "productions_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "productions" ADD CONSTRAINT "productions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_production_id_productions_id_fk" FOREIGN KEY ("production_id") REFERENCES "public"."productions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_gates" ADD CONSTRAINT "review_gates_production_id_productions_id_fk" FOREIGN KEY ("production_id") REFERENCES "public"."productions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_drafts" ADD CONSTRAINT "script_drafts_production_id_productions_id_fk" FOREIGN KEY ("production_id") REFERENCES "public"."productions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thumbnails" ADD CONSTRAINT "thumbnails_production_id_productions_id_fk" FOREIGN KEY ("production_id") REFERENCES "public"."productions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assets_production_kind_idx_uq" ON "assets" USING btree ("production_id","kind","idx");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_dna_channel_id_uq" ON "channel_dna" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "script_drafts_production_version_uq" ON "script_drafts" USING btree ("production_id","version");