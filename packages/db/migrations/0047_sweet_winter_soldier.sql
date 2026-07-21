CREATE TYPE "public"."ticket_severity" AS ENUM('info', 'warn', 'error');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('open', 'acknowledged', 'closed');--> statement-breakpoint
CREATE TABLE "agent_tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text,
	"production_id" text,
	"source" text DEFAULT 'mcp' NOT NULL,
	"severity" "ticket_severity" DEFAULT 'info' NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"status" "ticket_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_tickets_status_idx" ON "agent_tickets" USING btree ("status");