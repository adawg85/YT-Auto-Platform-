import { and, eq, inArray } from "drizzle-orm";
import { reviewGates, type Db } from "@ytauto/db";

/**
 * Gate lifecycle invariant (ticket 01KY1SWM…): a review gate must never outlive
 * its production. When a production leaves an active state — retired, deleted,
 * failed, halted, superseded, rejected — every gate still awaiting a decision
 * on it is stale work that pollutes the operator's batch-review queue.
 *
 * This is enforced in three layers:
 *  1. DATA LAYER (authoritative): a Postgres trigger expires pending gates
 *     whenever a production's status transitions into a dead state, so no
 *     future code path can reintroduce the leak (migration 0053).
 *  2. WRITE PATH: terminal-transition handlers also call `cancelPendingGates`
 *     for an immediate, in-request effect (and so the intent is explicit).
 *  3. READ PATH: `list_gates` and the cockpit queue exclude gates whose
 *     production is in a dead state, so even a missed cancellation never shows
 *     phantom work.
 */

/** Production statuses in which a pending review gate is stale, not real work. */
export const GATE_DEAD_PRODUCTION_STATUSES = [
  "rejected",
  "failed",
  "halted",
  "superseded",
  "retired",
] as const;

export type GateDeadProductionStatus = (typeof GATE_DEAD_PRODUCTION_STATUSES)[number];

/** True when a production in this status should have no pending gates. */
export function productionIsGateDead(status: string): boolean {
  return (GATE_DEAD_PRODUCTION_STATUSES as readonly string[]).includes(status);
}

/**
 * Keep only gates whose production is still in an active state. Shared by the
 * read paths (MCP `list_gates`, the cockpit queue) so the "active only" rule is
 * defined once. Rows must carry the joined `productionStatus`.
 */
export function activeGatesOnly<T extends { productionStatus: string }>(rows: T[]): T[] {
  return rows.filter((r) => !productionIsGateDead(r.productionStatus));
}

/**
 * Expire every pending gate for a production. Call from any handler that moves a
 * production into a terminal/dead state (retire, delete, fail, halt, supersede,
 * reject). Idempotent and safe to call even when there are no pending gates. The
 * DB trigger is the backstop; this makes the effect immediate in-request.
 */
export async function cancelPendingGates(db: Db, productionId: string): Promise<void> {
  await db
    .update(reviewGates)
    .set({ status: "expired" })
    .where(and(eq(reviewGates.productionId, productionId), eq(reviewGates.status, "pending")));
}

/**
 * #81: the DB patch for a production status transition, so `failureReason` is
 * kept consistent with `status` on EVERY write. The rule: a transition CLEARS any
 * prior failureReason unless a new one is supplied. A forward/success move
 * (…→published, →ready, →assembling, a gate-approval resume) therefore drops a
 * stale reason automatically, and only an off-ramp that actually passes a reason
 * (on_hold/failed/rejected + the gate-timeout handlers) carries one.
 *
 * This is the fix for a production that timed out at a gate (→ on_hold +
 * "visuals_review gate timed out"), was then approved and published, yet kept the
 * terminal-looking reason because the publish step wrote `status:"published"`
 * without ever clearing it. Pure + unit-tested so the invariant is locked without
 * a DB. Callers spread the result into their `.set({...})`.
 */
export function productionStatusPatch<S extends string>(
  status: S,
  failureReason?: string | null,
): { status: S; failureReason: string | null } {
  // Truthiness (not ??): an empty reason is treated as "no reason" and clears the
  // column, so a zero-length failureReason never persists. Matches the prior
  // `failureReason ? {failureReason} : {}` set-only behaviour, but also clearing.
  return { status, failureReason: failureReason ? failureReason : null };
}

/**
 * One-shot sweep: expire all pending gates whose production is already in a dead
 * state. Used by the maintenance path; the migration does the same in SQL for
 * prod. `db` any so callers can pass a transaction.
 */
export async function sweepOrphanedGates(
  db: Db,
  deadProductionIds: string[],
): Promise<void> {
  if (deadProductionIds.length === 0) return;
  await db
    .update(reviewGates)
    .set({ status: "expired" })
    .where(
      and(eq(reviewGates.status, "pending"), inArray(reviewGates.productionId, deadProductionIds)),
    );
}

/**
 * The mirror-image leak (#94): a gate that outlives its production is stale work
 * — but a production that outlives its GATE is *invisible* work. A production
 * parked in a `*_review` status with no PENDING gate row is waiting for a human
 * decision that can never be made: `list_gates` only returns pending gates, so
 * nothing surfaces it, and `get_diagnostics` only reported failed/on_hold. The
 * reported case sat at `profile_review` with no gate while the operator was told
 * "voiceover appears stuck" — voiceover had not been reached.
 *
 * It can arrive several ways (a gate decided while the pipeline run was no longer
 * alive to receive the event, a gate expired by a path that didn't move the
 * status, a status write that outlived its gate insert), so this detects the
 * STATE rather than any one cause. `force_forward` is the operator's unblock.
 */
export const REVIEW_STATUSES = [
  "script_review",
  "profile_review",
  "voiceover_recording",
  "visuals_review",
  "thumbnail_review",
] as const;

export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** True when this status means "parked, waiting on a human decision". */
export function isReviewStatus(status: string): boolean {
  return (REVIEW_STATUSES as readonly string[]).includes(status);
}

export type ReviewStateRow = {
  id: string;
  channelId: string;
  status: string;
  updatedAt: Date | string | null;
  /** how many PENDING gate rows this production has right now */
  pendingGates: number;
};

export type OrphanedReviewState = {
  productionId: string;
  channelId: string;
  status: string;
  stuckSinceMinutes: number | null;
  reason: string;
};

/**
 * Productions parked in a review status with no pending gate. `now` is injected
 * so this stays pure and testable. `minMinutes` avoids flagging the natural
 * split-second between a gate decision and the pipeline advancing the status —
 * only a state that has PERSISTED is a defect.
 */
export function orphanedReviewStates(
  rows: ReviewStateRow[],
  now: Date,
  minMinutes = 15,
): OrphanedReviewState[] {
  const out: OrphanedReviewState[] = [];
  for (const r of rows) {
    if (!isReviewStatus(r.status) || r.pendingGates > 0) continue;
    const at = r.updatedAt ? new Date(r.updatedAt) : null;
    const mins =
      at && !Number.isNaN(at.getTime())
        ? Math.floor((now.getTime() - at.getTime()) / 60_000)
        : null;
    // an unknown age is reported (it can't be shown to be recent), a known-recent
    // one is not — the transition window is legitimate
    if (mins !== null && mins < minMinutes) continue;
    out.push({
      productionId: r.id,
      channelId: r.channelId,
      status: r.status,
      stuckSinceMinutes: mins,
      reason:
        `Parked at ${r.status} with NO pending gate row — list_gates cannot show it and it cannot be approved. ` +
        `It will sit here until the pipeline's gate timeout strands it. Use force_forward to drive it on, or retry_production to re-enter the stage.`,
    });
  }
  return out.sort((a, b) => (b.stuckSinceMinutes ?? 0) - (a.stuckSinceMinutes ?? 0));
}
