import { and, eq, inArray, sql } from "drizzle-orm";
import { productions, shotJobs } from "@ytauto/db";
import type { Db } from "@ytauto/db";
import { partitionShotJobs } from "@ytauto/core";
import { WAITING_STATUSES, WORKING_STATUSES, type StatusSummary } from "./status";

/**
 * Portfolio-wide system-status counts (task #21) — one cheap grouped query.
 * Optionally scoped to a channel. Powers the topbar strip (via
 * /api/status/summary) and the Overview strip.
 */
export async function loadStatusSummary(db: Db, channelId?: string): Promise<StatusSummary> {
  const rows = await db
    .select({ status: productions.status, n: sql<number>`count(*)::int` })
    .from(productions)
    .where(
      and(
        channelId ? eq(productions.channelId, channelId) : undefined,
        inArray(productions.status, [...WORKING_STATUSES, ...WAITING_STATUSES, "scheduled", "failed"]),
      ),
    )
    .groupBy(productions.status);

  // queued/running operator jobs — a durable count that survives a refresh, so
  // "I clicked regenerate and nothing seems to be happening" has an answer.
  // ABANDONED rows are excluded (2026-08-26): an Inngest run cancelled by a
  // worker redeploy never closes its row, and counting those forever would turn
  // this number into permanent noise — the exact opposite of its job. The
  // production page surfaces them separately, where they can be re-queued.
  const jobRows = await db
    .select({
      productionId: shotJobs.productionId,
      op: shotJobs.op,
      status: shotJobs.status,
      startedAt: shotJobs.startedAt,
      createdAt: shotJobs.createdAt,
    })
    .from(shotJobs)
    .where(
      and(
        channelId ? eq(shotJobs.channelId, channelId) : undefined,
        inArray(shotJobs.status, ["queued", "running"]),
      ),
    );
  const { live: liveJobs } = partitionShotJobs(jobRows, Date.now());

  const byStatus = new Map(rows.map((r) => [r.status as string, r.n]));
  const sum = (keys: readonly string[]) => keys.reduce((a, k) => a + (byStatus.get(k) ?? 0), 0);
  return {
    working: sum(WORKING_STATUSES),
    waiting: sum(WAITING_STATUSES),
    scheduled: byStatus.get("scheduled") ?? 0,
    failed: byStatus.get("failed") ?? 0,
    queued: liveJobs.length,
  };
}
