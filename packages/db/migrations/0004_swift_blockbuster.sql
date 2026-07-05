CREATE TYPE "public"."pattern_kind" AS ENUM('hook', 'script_structure', 'topic_signal');--> statement-breakpoint
CREATE TYPE "public"."pattern_source" AS ENUM('own', 'external');--> statement-breakpoint
CREATE TABLE "hook_analyses" (
	"id" text PRIMARY KEY NOT NULL,
	"publication_id" text NOT NULL,
	"production_id" text NOT NULL,
	"hook_text" text NOT NULL,
	"archetype" "hook_archetype" NOT NULL,
	"three_second_hold_pct" real,
	"vs_channel_avg_pct" real,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assessment" text NOT NULL,
	"agent_action_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patterns" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "pattern_kind" NOT NULL,
	"label" text NOT NULL,
	"niche" text NOT NULL,
	"format" text DEFAULT 'shorts' NOT NULL,
	"source" "pattern_source" DEFAULT 'own' NOT NULL,
	"detail" jsonb NOT NULL,
	"sample_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"performance_score" real DEFAULT 0 NOT NULL,
	"observations" integer DEFAULT 1 NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "script_analyses" (
	"id" text PRIMARY KEY NOT NULL,
	"publication_id" text NOT NULL,
	"production_id" text NOT NULL,
	"structure" jsonb NOT NULL,
	"strengths" text NOT NULL,
	"trim_suggestion" text NOT NULL,
	"dip_at_sec" real,
	"agent_action_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ADD COLUMN "retention_curve" jsonb;--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ADD COLUMN "swipe_away_pct" real;--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ADD COLUMN "returning_viewer_pct" real;--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ADD COLUMN "subs_gained" integer;--> statement-breakpoint
ALTER TABLE "hook_analyses" ADD CONSTRAINT "hook_analyses_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hook_analyses" ADD CONSTRAINT "hook_analyses_production_id_productions_id_fk" FOREIGN KEY ("production_id") REFERENCES "public"."productions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_analyses" ADD CONSTRAINT "script_analyses_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_analyses" ADD CONSTRAINT "script_analyses_production_id_productions_id_fk" FOREIGN KEY ("production_id") REFERENCES "public"."productions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hook_analyses_publication_uq" ON "hook_analyses" USING btree ("publication_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patterns_identity_uq" ON "patterns" USING btree ("kind","niche","format","label");--> statement-breakpoint
CREATE UNIQUE INDEX "script_analyses_publication_uq" ON "script_analyses" USING btree ("publication_id");