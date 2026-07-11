CREATE TABLE "channel_competitors" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"external_id" text DEFAULT '' NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"source" text DEFAULT 'operator' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "intel_cadence" text DEFAULT 'daily' NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_competitors" ADD CONSTRAINT "channel_competitors_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_competitors_channel_name_uq" ON "channel_competitors" USING btree ("channel_id","name");