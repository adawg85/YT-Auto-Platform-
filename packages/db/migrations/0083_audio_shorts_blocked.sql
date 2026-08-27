-- #132: mark an audio asset as OBSERVED to block YouTube Shorts.
--
-- YouTube blocks any Short over one minute that carries an active Content ID
-- claim, "regardless of the policy". When a claimant caps the usable duration of
-- a single track, every >60s Short using it is blocked globally on upload — and
-- a correct CC-BY credit does not release it, because the credit answers
-- attribution, not duration. Two Scott Buckley tracks hit this within three days
-- (Phoenix 2026-08-25, Aphelion 2026-08-27) while the rest of the same
-- catalogue kept publishing fine, so the flag is PER TRACK.
--
-- It is an observation rather than a prediction: Content ID membership is not
-- publicly queryable, so only an upload reveals a cap. Once set, the bed
-- rotation skips the track on short-format channels and the attach paths refuse
-- it, so the same block cannot be bought twice. Long-form is unaffected — there
-- a claim monetises instead of blocking.
ALTER TABLE "audio_assets" ADD COLUMN "shorts_blocked" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "audio_assets" ADD COLUMN "shorts_blocked_note" text;
