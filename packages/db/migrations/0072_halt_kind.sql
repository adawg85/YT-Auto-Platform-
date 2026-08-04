-- P1: type the halt.
--
-- Nineteen of the pipeline's twenty pre-publish failure exits wrote status
-- 'on_hold', distinguished only by a free-text failureReason. A reviewer
-- rejecting the visuals and YouTube exhausting its upload quota produced the
-- same row, so the operator had to read prose to pick between four recovery
-- verbs — one of which (retry visuals) re-bills every image.
--
-- haltKind names the CLASS, so the cockpit can render the right action, MCP can
-- return it, and an auto-retry loop can safely act on the one class that is
-- genuinely transient. Nullable: rows halted before this deploy keep a null and
-- degrade to the conservative 'precondition' policy.
CREATE TYPE "halt_kind" AS ENUM (
  'human_decision',
  'gate_timeout',
  'compliance_block',
  'external_retryable',
  'precondition'
);--> statement-breakpoint
ALTER TABLE "productions" ADD COLUMN IF NOT EXISTS "halt_kind" "halt_kind";
