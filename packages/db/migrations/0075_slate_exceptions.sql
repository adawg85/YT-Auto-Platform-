-- #109: (1) persist the write-time titleTemplates-vs-forbiddenTopics consistency
-- verdict on channel_dna so get_channel_config replays it without re-billing an
-- LLM on every read; (2) a decision kind for one-off review_slate block
-- acceptances — an audit record of judgement being exercised, distinguishable
-- from a forbidden topic being loosened or deleted.
ALTER TABLE "channel_dna" ADD COLUMN "consistency_findings" jsonb;--> statement-breakpoint
ALTER TYPE "public"."decision_kind" ADD VALUE 'slate_exception';
