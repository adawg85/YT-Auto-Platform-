CREATE TABLE "channel_music" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"name" text,
	"mood" text,
	"source" text,
	"attribution" text,
	"license" text,
	"duration_sec" real,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_music" ADD CONSTRAINT "channel_music_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_music_channel_storage_uq" ON "channel_music" USING btree ("channel_id","storage_key");