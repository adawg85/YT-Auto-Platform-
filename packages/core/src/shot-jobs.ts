/**
 * Stall detection for operator-queued shot work (`shot_jobs`).
 *
 * Every operator-queued shot operation — a prompt rewrite, an image regenerate,
 * and (from 2026-08-26) an Animate — writes a durable `shot_jobs` row so the
 * queue survives the browser. The row is closed by the worker: `done` on
 * success, `failed` from the in-function guard or the function's `onFailure`.
 *
 * There is one path that closes NEITHER: an Inngest run that is CANCELLED
 * rather than failed. `onFailure` does not fire for a cancellation, so the row
 * is left at `queued`/`running` with nothing coming to move it. That is not
 * hypothetical here — the worker redeploys on every push to `main`, which is
 * exactly when in-flight and queued runs get dropped, and it is what the
 * operator sees as "they say they are queuing but sometimes will stop and
 * perhaps I get the first one only": the first clip had time to land, the rest
 * were queued behind it (clips run one-at-a-time per production) and died in
 * the queue, leaving the cockpit polling forever on work that no longer exists.
 *
 * Rather than depend on a sweeper (the janitor runs daily — far too slow for a
 * queue the operator is watching), staleness is DERIVED on read, here, so the
 * cockpit and the status strip agree and the rule is unit-testable.
 */

/** A `running` job whose worker has said nothing for this long is presumed dead.
 * Generous: the vendor poll for a single clip is minutes, never this. */
export const SHOT_JOB_RUNNING_STALL_MS = 45 * 60 * 1000;

/** A `queued` job this old with NOTHING running on its production is presumed
 * dead. The "nothing running" half is what makes this safe: clips are
 * serialised one-at-a-time per production, so a long legitimate wait always has
 * a running sibling ahead of it. Age alone would false-flag a deep queue. */
export const SHOT_JOB_QUEUED_STALL_MS = 20 * 60 * 1000;

/** The fields stall detection needs — a subset of the `shot_jobs` row. */
export type ShotJobLike = {
  productionId: string;
  op: string;
  /** queued | running | done | failed | cancelled */
  status: string;
  startedAt?: Date | string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

const ms = (d: Date | string | null | undefined): number | null => {
  if (!d) return null;
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Number.isFinite(t) ? t : null;
};

/** Jobs that are still, as far as the DB knows, work in progress. */
export function isShotJobActive(job: Pick<ShotJobLike, "status">): boolean {
  return job.status === "queued" || job.status === "running";
}

/**
 * Is this job abandoned — active in the DB, but with no worker run behind it?
 *
 * `now` is injected so callers (and tests) are deterministic. `siblings` is the
 * set of jobs to judge "is anything actually running on this production"
 * against; pass the production's active jobs (passing them all is fine — only
 * same-production rows are consulted).
 */
export function isShotJobStalled(job: ShotJobLike, siblings: readonly ShotJobLike[], now: number): boolean {
  if (!isShotJobActive(job)) return false;
  if (job.status === "running") {
    // no startedAt on a running row is itself a broken row — fall back to when
    // it was created so it can still age out rather than hang forever
    const since = ms(job.startedAt) ?? ms(job.createdAt);
    if (since === null) return false;
    return now - since >= SHOT_JOB_RUNNING_STALL_MS;
  }
  // queued: only stalled once nothing on this production is running to feed it
  const created = ms(job.createdAt);
  if (created === null) return false;
  if (now - created < SHOT_JOB_QUEUED_STALL_MS) return false;
  const busy = siblings.some(
    (s) =>
      s.productionId === job.productionId &&
      s.status === "running" &&
      !isShotJobStalled(s, [], now), // a stalled runner is not feeding anything
  );
  return !busy;
}

/** Split active jobs into the ones genuinely in flight and the abandoned ones. */
export function partitionShotJobs<T extends ShotJobLike>(
  jobs: readonly T[],
  now: number,
): { live: T[]; stalled: T[] } {
  const active = jobs.filter(isShotJobActive);
  const live: T[] = [];
  const stalled: T[] = [];
  for (const j of active) (isShotJobStalled(j, active, now) ? stalled : live).push(j);
  return { live, stalled };
}
