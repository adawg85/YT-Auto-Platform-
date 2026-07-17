CREATE TABLE "production_music" (
	"id" text PRIMARY KEY NOT NULL,
	"production_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"duration_sec" real,
	"mood" text,
	"prompt" text,
	"engine" text,
	"selected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "production_music" ADD CONSTRAINT "production_music_production_id_productions_id_fk" FOREIGN KEY ("production_id") REFERENCES "public"."productions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "production_music_production_id_idx" ON "production_music" USING btree ("production_id");