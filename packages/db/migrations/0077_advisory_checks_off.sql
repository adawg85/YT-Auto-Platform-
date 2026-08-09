-- #113: per-channel opt-out for the ADVISORY consistency checks
-- (consistencyWarnings on read; the #109 temporal-qualifier + semantic
-- titleTemplates-vs-forbiddenTopics checks on write). DELIBERATELY NARROW:
-- this flag never reaches the load-bearing enforcement — review_slate's
-- forbiddenTopics blocks, the variation/anti-clone checks, or the human
-- approval gates — which are the channels' actual protection under the
-- inauthentic-content policy.
ALTER TABLE "channel_dna" ADD COLUMN "advisory_checks_disabled" boolean DEFAULT false NOT NULL;
