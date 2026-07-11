/**
 * DB capacity thresholds (BACKLOG #21.7). Pure so the janitor's alerting is
 * unit-testable: storage % of the plan quota → warn at 70%, critical at 85%;
 * a sustained cache-hit ratio under 95% is the "vector index no longer fits
 * in RAM" signal → suggest the next instance tier.
 */

export const STORAGE_WARN_PCT = 70;
export const STORAGE_CRIT_PCT = 85;
export const CACHE_HIT_MIN = 0.95;

export type CapacityStatus = {
  usedGb: number;
  quotaGb: number;
  usedPct: number;
  cacheHitRatio: number | null;
  level: "ok" | "warning" | "critical";
  message: string | null;
};

export function capacityStatus(input: {
  usedBytes: number;
  quotaGb: number;
  /** blks_hit / (blks_hit + blks_read), null when stats are empty */
  cacheHitRatio: number | null;
}): CapacityStatus {
  const quotaGb = Math.max(0.1, input.quotaGb);
  const usedGb = input.usedBytes / 1024 ** 3;
  const usedPct = Math.round((usedGb / quotaGb) * 1000) / 10;
  const lowCache = input.cacheHitRatio != null && input.cacheHitRatio < CACHE_HIT_MIN;

  let level: CapacityStatus["level"] = "ok";
  if (usedPct >= STORAGE_CRIT_PCT) level = "critical";
  else if (usedPct >= STORAGE_WARN_PCT || lowCache) level = "warning";

  const parts: string[] = [];
  if (usedPct >= STORAGE_WARN_PCT) {
    parts.push(
      `Database storage at ${usedPct}% of the ${quotaGb}GB plan (${usedGb.toFixed(2)}GB used) — ` +
        `bump the Render plan or add storage ($0.30/GB/mo) before it fills.`,
    );
  }
  if (lowCache) {
    parts.push(
      `Postgres cache-hit ratio ${(input.cacheHitRatio! * 100).toFixed(1)}% (<95%) — the working set ` +
        `no longer fits in RAM; memory retrieval will slow. Consider the next instance tier.`,
    );
  }
  return {
    usedGb: Math.round(usedGb * 100) / 100,
    quotaGb,
    usedPct,
    cacheHitRatio: input.cacheHitRatio,
    level,
    message: parts.length ? parts.join(" ") : null,
  };
}
