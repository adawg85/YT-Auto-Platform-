CREATE TABLE "beat_maps" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"production_id" text,
	"title" text NOT NULL,
	"map" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"verdict" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "beat_maps" ADD CONSTRAINT "beat_maps_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "beat_maps_channel_id_idx" ON "beat_maps" USING btree ("channel_id");