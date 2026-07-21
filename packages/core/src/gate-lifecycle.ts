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
