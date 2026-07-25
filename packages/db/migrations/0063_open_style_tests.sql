-- Style test scenes: usable BEFORE a style is distilled, and castable with
-- SEVERAL characters (2026-07-25 operator: "the test scene does not have a
-- prompt section to create scenes or allow me to test scenes with inject one of
-- many characters").
--
-- 1. style_id becomes nullable — a test scene can now render against the
--    channel's plain house style (or no style at all) instead of requiring a
--    distilled version first. That gate is why a fresh channel had no prompt box.
-- 2. character_ids holds the full cast injected into the scene; the existing
--    single character_id is kept and mirrors the FIRST character so old rows and
--    the reference-image path keep working.
ALTER TABLE "style_test_scenes" ALTER COLUMN "style_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "style_test_scenes" ADD COLUMN "character_ids" jsonb;
