-- P6: split externalScript's three implicit behaviours into explicit intentions.
--
-- One boolean silently governed three unrelated things: whether the human script
-- gate is skipped, whether the image-prompt BUILDER is skipped (authored
-- imagePrompts used verbatim), and whether authored motionPrompts are honoured.
-- When resume_production dropped the flag (#94), an operator-authored production
-- silently became a generated one — the script gate reappeared, the builder
-- rewrote 126 authored prompts, and the motion prompts were ignored. Nothing
-- said so, because the three consequences had no names.
--
-- Nullable and derived: a null column falls back to externalScript, so every
-- existing row keeps its exact behaviour and externalScript stays the
-- back-compatible source of truth until all writers set these explicitly.
ALTER TABLE "productions" ADD COLUMN IF NOT EXISTS "script_authored" boolean;--> statement-breakpoint
ALTER TABLE "productions" ADD COLUMN IF NOT EXISTS "prompts_authored" boolean;--> statement-breakpoint
ALTER TABLE "productions" ADD COLUMN IF NOT EXISTS "motion_authored" boolean;
