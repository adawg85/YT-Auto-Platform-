-- cast_mode already shipped in 0037 (its drizzle snapshot was hand-applied, so
-- the generator re-diffed it against 0036 and re-emitted the line — dropped here
-- so this migration only adds the new cast_target column on top of 0037).
ALTER TABLE "channel_characters" ADD COLUMN "cast_target" integer DEFAULT 55 NOT NULL;
