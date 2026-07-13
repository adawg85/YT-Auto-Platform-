CREATE TYPE "public"."playbook_origin" AS ENUM('analysis', 'experiment', 'operator');--> statement-breakpoint
CREATE TYPE "public"."playbook_scope" AS ENUM('hook', 'pacing', 'structure', 'visual', 'topic', 'title');--> statement-breakpoint
CREATE TYPE "public"."playbook_status" AS ENUM('trial', 'adopted', 'retired');--> statement-breakpoint
CREATE TABLE "channel_playbook" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"directive" text NOT NULL,
	"scope" "playbook_scope" NOT NULL,
	"origin" "playbook_origin" NOT NULL,
	"status" "playbook_status" DEFAULT 'trial' NOT NULL,
	"why" text NOT NULL,
	"evidence" jsonb,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"adopted_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "maturity_override" text;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "priority" integer;--> statement-breakpoint
ALTER TABLE "channel_playbook" ADD CONSTRAINT "channel_playbook_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_playbook_channel_id_idx" ON "channel_playbook" USING btree ("channel_id");