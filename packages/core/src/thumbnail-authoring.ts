/**
 * Thumbnail authoring rules (2026-08-08 operator request: "I want via MCP for
 * an episode's thumbnail to be created at any time, not just after the video's
 * been put together").
 *
 * The thumbnail generator never needed the assembled video — it composes from
 * the idea's title/angle and the channel's DNA (thumbnailSpec / visualStyle /
 * productionProfile), all of which exist from greenlight. The "after assembly
 * only" behaviour was a status whitelist on the MCP tool. These rules replace
 * it, and they are pure — no DB, no I/O — so the two decisions that matter
 * (may the operator author now? must the pipeline still generate its own
 * candidates?) are unit-testable.
 */

/**
 * Statuses where authoring a thumbnail is refused: the production is dead and
 * a candidate could never be used. Everything else — including in-flight,
 * held, halted and failed productions — is allowed: the candidate is stored
 * against the production and offered when (if) it reaches the gate.
 */
export const THUMBNAIL_BLOCKED_STATUSES: ReadonlySet<string> = new Set([
  "rejected",
  "superseded",
  "retired",
]);

export function canAuthorThumbnail(status: string): { ok: true } | { ok: false; reason: string } {
  if (THUMBNAIL_BLOCKED_STATUSES.has(status)) {
    return {
      ok: false,
      reason: `This production is ${status} — terminal, so a thumbnail candidate could never be used. Pick a live production (list_productions), or replace/restore the episode first.`,
    };
  }
  return { ok: true };
}

/**
 * Statuses at/after the pipeline's own thumbnail stage (step 7b runs just
 * before the thumbnail_review gate opens). A candidate authored in any OTHER
 * status is an EARLY candidate: it predates the pipeline's generation and is
 * stamped `meta.early = <status>` so it can be told apart from pipeline
 * output — provenance for the gate/cockpit, and the key the pipeline's
 * reuse check turns on.
 */
const AT_OR_PAST_THUMBNAIL_STAGE: ReadonlySet<string> = new Set([
  "thumbnail_review",
  "ready",
  "scheduled",
  "published",
  "published_unverified",
  "analysing",
]);

export function isEarlyThumbnailStatus(status: string): boolean {
  return !AT_OR_PAST_THUMBNAIL_STAGE.has(status);
}

/**
 * The pipeline's reuse/dedupe decision at its generate-thumbnails step.
 *
 * Historically: any existing candidate → skip generation (resume/replay must
 * not double-bill). With early authoring that rule would let one operator
 * candidate SUPPRESS the spec/winner-pattern-grounded pipeline candidates,
 * so the gate would offer less than it used to. The rule is therefore:
 * generate unless a NON-early candidate exists.
 *
 *  - no candidates                        → generate (first run)
 *  - any candidate without `meta.early`   → skip (pipeline output from a
 *    resume/replay, or gate-time operator additions; legacy rows predating
 *    the `early` stamp also land here — exactly today's behaviour, so no
 *    replay of an old production ever re-bills)
 *  - only `meta.early` candidates         → generate and APPEND; the gate
 *    offers both the operator's early picks and the pipeline's own
 */
export function shouldGeneratePipelineThumbnails(
  existing: Array<{ meta?: Record<string, unknown> | null }>,
): boolean {
  if (existing.length === 0) return true;
  return existing.every((t) => Boolean(t.meta && (t.meta as Record<string, unknown>).early));
}
