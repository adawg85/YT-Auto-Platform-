CREATE TABLE "channel_characters" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"name" text NOT NULL,
	"brief" text NOT NULL,
	"description" text NOT NULL,
	"image_key" text NOT NULL,
	"mime_type" text DEFAULT 'image/png' NOT NULL,
	"role" text DEFAULT 'main' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_characters" ADD CONSTRAINT "channel_characters_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_characters_channel_id_idx" ON "channel_characters" USING btree ("channel_id");