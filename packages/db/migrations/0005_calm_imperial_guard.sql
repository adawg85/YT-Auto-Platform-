CREATE TYPE "public"."research_source" AS ENUM('outlier', 'breakout', 'trending');--> statement-breakpoint
CREATE TABLE "external_videos" (
	"id" text PRIMARY KEY NOT NULL,
	"source" "research_source" NOT NULL,
	"external_id" text NOT NULL,
	"niche" text NOT NULL,
	"format" text DEFAULT 'shorts' NOT NULL,
	"title" text NOT NULL,
	"channel_name" text NOT NULL,
	"url" text,
	"views" integer DEFAULT 0 NOT NULL,
	"views_per_hour" real,
	"outlier_factor" real,
	"engagement_rate" real,
	"transcript" text,
	"published_at" timestamp with time zone,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"analyzed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "external_videos_niche_external_uq" ON "external_videos" USING btree ("niche","external_id");