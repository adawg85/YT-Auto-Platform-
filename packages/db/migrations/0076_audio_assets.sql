-- #110 (feature request): platform-wide audio asset library with licence
-- provenance. audio_assets is PLATFORM-scoped (no channel FK) — a track licensed
-- once is usable everywhere; channel beds and productions REFERENCE it.
-- channel_music.audio_asset_id is a soft pointer back to the library row.
-- production_music gains attribution/license columns so the copy paths stop
-- DROPPING provenance (a bed track's licence used to vanish the moment it was
-- selected for a video — the silent CC-BY-without-credit breach).
CREATE TABLE "audio_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"duration_sec" real,
	"title" text NOT NULL,
	"creator" text,
	"creator_url" text,
	"source_url" text,
	"licence" text,
	"licence_version" text,
	"licence_url" text,
	"modified" boolean DEFAULT false NOT NULL,
	"commercial_use" boolean,
	"mood" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "audio_assets_storage_key_uq" ON "audio_assets" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "audio_assets_licence_idx" ON "audio_assets" USING btree ("licence");--> statement-breakpoint
ALTER TABLE "channel_music" ADD COLUMN "audio_asset_id" text;--> statement-breakpoint
ALTER TABLE "production_music" ADD COLUMN "attribution" text;--> statement-breakpoint
ALTER TABLE "production_music" ADD COLUMN "license" text;--> statement-breakpoint
ALTER TABLE "production_music" ADD COLUMN "license_url" text;
