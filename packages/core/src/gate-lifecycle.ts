import { and, eq, inArray } from "drizzle-orm";
import { productions, reviewGates, type Db } from "@ytauto/db";

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
 * #127: ONE pending gate per production — the invariant, and the only way the
 * pipeline may mint a gate.
 *
 * The reported failure: two `reopen_stage` calls 21s apart (the second one being
 * the remedy the platform's own assemblyWarning recommends for the first) left
 * TWO pending `voiceover_recording` gates on one production, and the cockpit
 * rendered the video twice with its own Approve/Revise/Reject buttons on each.
 * `reopenStageAction` does expire pending gates — but it expires the ones that
 * exist AT THAT MOMENT, and the first reopen's pipeline run had not created its
 * gate yet (it landed 6s later). Expiring at reopen time can therefore never be
 * enough: the race is between a run that is about to open a gate and a reopen
 * that has already swept.
 *
 * So the invariant is enforced where gates are BORN instead. Creating a gate
 * means "this production is now waiting HERE" — every creation site immediately
 * writes `productions.currentGateId`, so any other pending gate is already
 * unreachable from the production row and is stale by construction. This
 * supersedes them in the same transaction as the insert.
 *
 * Layers, matching the orphan-gate doctrine above:
 *  1. DATA LAYER: a Postgres trigger supersedes older pending gates on INSERT
 *     (migration 0081) — no future code path can reintroduce the duplicate.
 *  2. WRITE PATH: this helper, used by every pipeline gate.
 *  3. READ PATH: `dedupePendingGates` on the queues, so even a row that predates
 *     the fix shows once.
 */
export async function openReviewGate(
  db: Db,
  opts: {
    /** caller-generated so the id can be returned to a memoized worker step */
    gateId: string;
    productionId: string;
    kind: typeof reviewGates.$inferInsert.kind;
    payloadSnapshot: Record<string, unknown>;
    /** the production status this gate parks the row in */
    productionStatus: typeof productions.$inferInsert.status;
  },
): Promise<{ gateId: string; supersededGateIds: string[] }> {
  return db.transaction(async (tx) => {
    const stale = await tx
      .select({ id: reviewGates.id })
      .from(reviewGates)
      .where(and(eq(reviewGates.productionId, opts.productionId), eq(reviewGates.status, "pending")));
    if (stale.length > 0) {
      await tx
        .update(reviewGates)
        .set({ status: "expired" })
        .where(
          and(eq(reviewGates.productionId, opts.productionId), eq(reviewGates.status, "pending")),
        );
    }
    await tx.insert(reviewGates).values({
      id: opts.gateId,
      productionId: opts.productionId,
      kind: opts.kind,
      payloadSnapshot: opts.payloadSnapshot,
    });
    await tx
      .update(productions)
      .set({ status: opts.productionStatus, currentGateId: opts.gateId })
      .where(eq(productions.id, opts.productionId));
    return { gateId: opts.gateId, supersededGateIds: stale.map((g) => g.id) };
  });
}

/**
 * #127 read path: collapse pending gates to ONE per (production, kind), newest
 * first. The write path + DB trigger stop new duplicates and the migration
 * repairs the existing ones; this is the belt that holds if a row ever slips
 * through, so no review queue can render the same decision twice. Pure.
 */
export function dedupePendingGates<
  T extends { gateId: string; productionId: string; kind: string; waitingSince?: unknown },
>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const key = `${r.productionId}::${r.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * #127: whether a parked run's gate TIMEOUT should still be applied.
 *
 * When a gate is superseded (a newer reopen minted a fresh one), the older
 * pipeline run stays parked in `waitForEvent` on a gate that can no longer be
 * decided. Seven days later its timeout handler fires and would drag the
 * production — by then living a different life under the newer gate — to
 * `on_hold`. That is the same class of stale-run clobber that migration 0080 had
 * to repair by hand.
 *
 * A timeout applies only when the production is STILL parked at that status AND
 * the gate that timed out is still the production's current gate. Pure.
 */
export function gateTimeoutApplies(input: {
  productionStatus: string | null | undefined;
  /** the status the timing-out gate parked the production in */
  stillAt: string;
  /** the production's currentGateId right now */
  currentGateId: string | null | undefined;
  /** the gate whose wait timed out (undefined on legacy callers → status-only) */
  gateId?: string | null;
}): boolean {
  if (!input.productionStatus || input.productionStatus !== input.stillAt) return false;
  // A gate id on both sides that DISAGREES means this run's gate was superseded.
  if (input.gateId && input.currentGateId && input.currentGateId !== input.gateId) return false;
  return true;
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

/**
 * #98: where a FORCE-FORWARDED production should present while the re-fired run
 * picks it back up.
 *
 * The re-fire mechanism is `production/greenlit` — the pipeline is idempotent
 * and skips every stage whose artifacts already exist — but writing `greenlit`
 * to the STATUS column made the cockpit show a fully-built, human-approved
 * production as if it were back at the start ("it kicked back to the script
 * gate"). That is upstream of scripting, producing_assets, assembling and the
 * visuals gate the operator had already approved, so it also mis-signals that
 * the approval no longer applies.
 *
 * The status should describe the work that EXISTS. The pipeline overwrites it as
 * it advances, so this is only what the operator sees in the gap — but that gap
 * is where they decide whether their approval survived.
 */
export function forceForwardStatus(have: {
  render?: boolean;
  images?: boolean;
  voiceover?: boolean;
  script?: boolean;
}): "assembling" | "producing_assets" | "scripting" | "greenlit" {
  if (have.render) return "assembling";
  if (have.images) return "producing_assets";
  if (have.voiceover || have.script) return "producing_assets";
  return "greenlit";
}

/**
 * #98: statuses from which NOTHING advances on its own. A production sitting in
 * any other non-terminal status is mid-flight and should be progressing; if it
 * has not moved for a long time, no worker is going to pick it up.
 *
 * `stuckReviewStates` (#94) only watched `*_review`, so a production stranded at
 * `greenlit` by a force-forward whose run never took was invisible to the exact
 * detector built to catch stranded productions.
 */
export const TERMINAL_PRODUCTION_STATUSES = [
  "published",
  "published_unverified",
  "analysing",
  "scheduled",
  "ready",
  "halted",
  "retired",
  "superseded",
  "rejected",
  "failed",
  "on_hold",
] as const;

/** Statuses where a HUMAN is legitimately the blocker — not "stuck". */
const AWAITING_HUMAN: readonly string[] = [...REVIEW_STATUSES];

export type StuckProductionRow = {
  id: string;
  channelId: string;
  status: string;
  updatedAt: Date | string | null;
  /** pending gate rows, so a legitimate wait is not reported as stuck */
  pendingGates: number;
};

export type StuckProduction = {
  productionId: string;
  channelId: string;
  status: string;
  stuckSinceMinutes: number | null;
  reason: string;
};

/**
 * Productions that are mid-pipeline but have not moved. Two shapes:
 *  - a `*_review` status with NO pending gate (the #94 case: unapprovable), and
 *  - any other non-terminal status (`greenlit`, `scripting`, `producing_assets`,
 *    `assembling`) sitting idle past the threshold — nothing is coming for it.
 *
 * Pure, so the threshold and the clock are injected and the rule is testable.
 */
export function stuckProductions(
  rows: StuckProductionRow[],
  now: Date,
  minMinutes = 30,
): StuckProduction[] {
  const out: StuckProduction[] = [];
  for (const r of rows) {
    if ((TERMINAL_PRODUCTION_STATUSES as readonly string[]).includes(r.status)) continue;
    // a review status with a live gate is waiting on the OPERATOR, not stuck
    if (AWAITING_HUMAN.includes(r.status) && r.pendingGates > 0) continue;
    const at = r.updatedAt ? new Date(r.updatedAt) : null;
    const mins =
      at && !Number.isNaN(at.getTime()) ? Math.floor((now.getTime() - at.getTime()) / 60_000) : null;
    if (mins !== null && mins < minMinutes) continue;
    const gateless = AWAITING_HUMAN.includes(r.status);
    out.push({
      productionId: r.id,
      channelId: r.channelId,
      status: r.status,
      stuckSinceMinutes: mins,
      reason: gateless
        ? `Parked at ${r.status} with NO pending gate row — list_gates cannot show it and it cannot be approved. Use force_forward to drive it on, or retry_production to re-enter the stage.`
        : `Sitting at ${r.status} with no pipeline activity — no worker run is advancing it (a re-fire that never took, or a run that died). Use force_forward to re-fire it, or retry_production(stage) to re-enter a specific stage.`,
    });
  }
  return out.sort((a, b) => (b.stuckSinceMinutes ?? 0) - (a.stuckSinceMinutes ?? 0));
}
