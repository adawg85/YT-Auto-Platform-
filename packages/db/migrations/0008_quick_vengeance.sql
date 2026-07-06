CREATE TYPE "public"."briefing_status" AS ENUM('open', 'acknowledged');--> statement-breakpoint
CREATE TYPE "public"."experiment_result" AS ENUM('win', 'loss', 'inconclusive');--> statement-breakpoint
CREATE TYPE "public"."experiment_status" AS ENUM('proposed', 'active', 'concluded', 'abandoned');--> statement-breakpoint
ALTER TYPE "public"."decision_kind" ADD VALUE 'briefing_response';--> statement-breakpoint
ALTER TYPE "public"."decision_kind" ADD VALUE 'experiment_started';--> statement-breakpoint
ALTER TYPE "public"."decision_kind" ADD VALUE 'experiment_concluded';--> statement-breakpoint
CREATE TABLE "channel_briefings" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"body" jsonb NOT NULL,
	"suggestions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "briefing_status" DEFAULT 'open' NOT NULL,
	"responses" jsonb,
	"operator_note" text,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"variable" text NOT NULL,
	"hypothesis" text NOT NULL,
	"baseline" text NOT NULL,
	"variant" text NOT NULL,
	"directive" text NOT NULL,
	"status" "experiment_status" DEFAULT 'proposed' NOT NULL,
	"target_sample_size" integer DEFAULT 3 NOT NULL,
	"started_at" timestamp with time zone,
	"concluded_at" timestamp with time zone,
	"result" "experiment_result",
	"outcome" text,
	"briefing_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "productions" ADD COLUMN "experiment_id" text;--> statement-breakpoint
ALTER TABLE "channel_briefings" ADD CONSTRAINT "channel_briefings_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "experiments_one_active_per_channel_uq" ON "experiments" USING btree ("channel_id") WHERE "experiments"."status" = 'active';