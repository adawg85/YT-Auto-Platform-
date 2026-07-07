CREATE TYPE "public"."charter_archetype" AS ENUM('evergreen_series', 'monitor_digest', 'reactive');--> statement-breakpoint
CREATE TYPE "public"."claim_status" AS ENUM('unverified', 'verified', 'attributed', 'cut');--> statement-breakpoint
CREATE TYPE "public"."claim_tier" AS ENUM('established', 'emerging', 'contested');--> statement-breakpoint
CREATE TYPE "public"."decision_actor" AS ENUM('operator', 'agent');--> statement-breakpoint
CREATE TYPE "public"."decision_kind" AS ENUM('charter_created', 'charter_updated', 'series_planned', 'episode_cut', 'operator_steer', 'gate_summary');--> statement-breakpoint
CREATE TYPE "public"."episode_status" AS ENUM('planned', 'researching', 'verifying', 'briefed', 'queued', 'produced', 'published', 'cut');--> statement-breakpoint
CREATE TYPE "public"."format_policy" AS ENUM('shorts_only', 'long_only', 'long_plus_shorts');--> statement-breakpoint
CREATE TYPE "public"."memory_kind" AS ENUM('source_doc', 'transcript', 'coverage_summary', 'decision_note', 'research_note');--> statement-breakpoint
CREATE TYPE "public"."memory_scope" AS ENUM('episode', 'channel');--> statement-breakpoint
CREATE TYPE "public"."proposed_by" AS ENUM('agent', 'operator');--> statement-breakpoint
CREATE TYPE "public"."series_status" AS ENUM('proposed', 'active', 'completed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('rss', 'web', 'youtube');--> statement-breakpoint
CREATE TYPE "public"."source_status" AS ENUM('active', 'error', 'disabled');--> statement-breakpoint
ALTER TYPE "public"."idea_source" ADD VALUE 'editorial';--> statement-breakpoint
CREATE TABLE "channel_charters" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"mission" text NOT NULL,
	"objectives" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"archetype" charter_archetype DEFAULT 'evergreen_series' NOT NULL,
	"format_policy" "format_policy" DEFAULT 'shorts_only' NOT NULL,
	"source_strategy" jsonb NOT NULL,
	"verification_bar" jsonb NOT NULL,
	"identity_proposals" jsonb,
	"checkin_cadence" text DEFAULT 'weekly' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"kind" "decision_kind" NOT NULL,
	"summary" text NOT NULL,
	"detail" jsonb,
	"actor" "decision_actor" DEFAULT 'agent' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"kind" "source_kind" NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"status" "source_status" DEFAULT 'active' NOT NULL,
	"last_fetch_at" timestamp with time zone,
	"last_error" text,
	"error_count" integer DEFAULT 0 NOT NULL,
	"proposed_by" "proposed_by" DEFAULT 'agent' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "citations" (
	"id" text PRIMARY KEY NOT NULL,
	"claim_id" text NOT NULL,
	"channel_source_id" text,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"domain" text NOT NULL,
	"snippet" text NOT NULL,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" text PRIMARY KEY NOT NULL,
	"episode_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"text" text NOT NULL,
	"tier" "claim_tier" DEFAULT 'established' NOT NULL,
	"status" "claim_status" DEFAULT 'unverified' NOT NULL,
	"agent_action_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "episodes" (
	"id" text PRIMARY KEY NOT NULL,
	"series_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"angle" text NOT NULL,
	"status" "episode_status" DEFAULT 'planned' NOT NULL,
	"idea_id" text,
	"brief" jsonb,
	"coverage_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"episode_id" text,
	"scope" "memory_scope" DEFAULT 'episode' NOT NULL,
	"kind" "memory_kind" NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"source_url" text,
	"embedding" vector(1536) NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "series" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"status" "series_status" DEFAULT 'proposed' NOT NULL,
	"planned_episode_count" integer DEFAULT 0 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_charters" ADD CONSTRAINT "channel_charters_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_decisions" ADD CONSTRAINT "channel_decisions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_sources" ADD CONSTRAINT "channel_sources_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_chunks" ADD CONSTRAINT "memory_chunks_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_chunks" ADD CONSTRAINT "memory_chunks_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series" ADD CONSTRAINT "series_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_charters_channel_id_uq" ON "channel_charters" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "episodes_series_position_uq" ON "episodes" USING btree ("series_id","position");--> statement-breakpoint
CREATE INDEX "memory_chunks_embedding_idx" ON "memory_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "memory_chunks_channel_scope_idx" ON "memory_chunks" USING btree ("channel_id","scope");