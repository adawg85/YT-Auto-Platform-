-- #110 Content ID follow-up (a claim from Sentric Music Publishing blocked a
-- video globally): the rights-holder's REQUIRED credit format (emitted verbatim
-- in the published description in preference to the generated T.A.S.L. line),
-- the claim-release URL (the remedy, stored on the asset instead of
-- rediscovered per claim), and the Content-ID-registered flag (attach paths
-- surface "expect an automatic claim" so a global block on a scheduled video is
-- expected rather than a surprise).
ALTER TABLE "audio_assets" ADD COLUMN "required_credit_format" text;
--> statement-breakpoint
ALTER TABLE "audio_assets" ADD COLUMN "claim_release_url" text;
--> statement-breakpoint
ALTER TABLE "audio_assets" ADD COLUMN "content_id_registered" boolean DEFAULT false NOT NULL;
