CREATE TABLE "style_test_scenes" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"style_id" text NOT NULL,
	"character_id" text,
	"prompt" text NOT NULL,
	"last_comments" text,
	"image_key" text NOT NULL,
	"mime_type" text DEFAULT 'image/png' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "style_test_scenes" ADD CONSTRAINT "style_test_scenes_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "style_test_scenes" ADD CONSTRAINT "style_test_scenes_style_id_visual_styles_id_fk" FOREIGN KEY ("style_id") REFERENCES "public"."visual_styles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "style_test_scenes" ADD CONSTRAINT "style_test_scenes_character_id_channel_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."channel_characters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "style_test_scenes_channel_id_idx" ON "style_test_scenes" USING btree ("channel_id");