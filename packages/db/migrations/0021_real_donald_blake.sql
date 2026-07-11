CREATE TYPE "public"."opportunity_kind" AS ENUM('niche', 'topic', 'style');--> statement-breakpoint
CREATE TYPE "public"."opportunity_status" AS ENUM('new', 'shortlisted', 'dismissed', 'actioned');--> statement-breakpoint
CREATE TABLE "market_opportunities" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "opportunity_kind" NOT NULL,
	"label" text NOT NULL,
	"summary" text NOT NULL,
	"suggested_niche" text,
	"suggested_intent" text,
	"momentum" integer DEFAULT 50 NOT NULL,
	"evidence" jsonb,
	"status" "opportunity_status" DEFAULT 'new' NOT NULL,
	"source" text DEFAULT 'market_scan' NOT NULL,
	"observations" integer DEFAULT 1 NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "market_opportunities_identity_uq" ON "market_opportunities" USING btree ("kind","label");