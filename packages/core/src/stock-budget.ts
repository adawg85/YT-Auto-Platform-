import { sql } from "drizzle-orm";
import { stockRateBudget, stockSearchCache, type Db } from "@ytauto/db";

/**
 * Global stock-API rate governor + 24h search cache.
 *
 * The worker runs productions for every channel concurrently, and each beat can
 * fire a stock lookup — so left alone the platform can burst well past a
 * provider's free-tier ceiling and get the API key flagged/disabled. Unsplash's
 * demo tier is 50 requests/HOUR for the WHOLE app; Coverr is similarly strict.
 *
 * We coordinate through Postgres (not an in-process counter — that wouldn't
 * survive a Render redeploy or coordinate across worker instances). Each
 * provider has one token-bucket row: `tokens` refills continuously toward
 * `capacity` at `refillPerSec`, and a request atomically refills-then-consumes
 * one token in a single UPDATE. When the bucket is empty the caller SKIPS that
 * provider (falls through to the next library or to generation) — it never
 * queues or sleeps, so sourcing degrades gracefully instead of spiking.
 *
 * The 24h cache collapses repeated-subject volume before it reaches the bucket
 * and also satisfies Pixabay's API term that mandates caching results for 24h.
 */

export type StockProvider = "pexels" | "pixabay" | "unsplash" | "coverr";

type Bucket = { capacity: number; refillPerSec: number };

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * Conservative defaults, well under each provider's real limit, all
 * env-overridable so caps can be raised once a higher tier is approved:
 *  - Unsplash: 40/hr   (demo is 50/hr app-wide; production 5000/hr)
 *  - Coverr:   30/hr   (undocumented — treat like Unsplash demo)
 *  - Pexels:   180/hr  (limit is 200/hr)
 *  - Pixabay:  90/min  (limit 100/min; the 24h cache carries most of the load)
 * `capacity` = burst allowance; we let it burst up to one hour's (or minute's)
 * worth so a batch isn't throttled below the sustained rate.
 */
export function bucketConfig(provider: StockProvider): Bucket {
  switch (provider) {
    case "unsplash": {
      const perHr = envNum("UNSPLASH_HOURLY_CAP", 40);
      return { capacity: perHr, refillPerSec: perHr / 3600 };
    }
    case "coverr": {
      const perHr = envNum("COVERR_HOURLY_CAP", 30);
      return { capacity: perHr, refillPerSec: perHr / 3600 };
    }
    case "pexels": {
      const perHr = envNum("PEXELS_HOURLY_CAP", 180);
      return { capacity: perHr, refillPerSec: perHr / 3600 };
    }
    case "pixabay": {
      const perMin = envNum("PIXABAY_PER_MIN_CAP", 90);
      return { capacity: perMin, refillPerSec: perMin / 60 };
    }
  }
}

/**
 * Atomically refill-by-elapsed-time then consume one token for `provider`.
 * Returns true if a token was granted (the caller may hit the API), false if
 * the bucket is empty (the caller must skip this provider). Any DB error fails
 * OPEN is deliberately avoided — on error we fail CLOSED (return false) so a
 * database hiccup can never cause a rate-limit breach; the beat simply falls
 * back to another source. The row is seeded on first use.
 */
export async function consumeStockToken(db: Db, provider: StockProvider): Promise<boolean> {
  const { capacity, refillPerSec } = bucketConfig(provider);
  try {
    // Seed the bucket full on first sight; the UPDATE below does the real work.
    await db
      .insert(stockRateBudget)
      .values({ provider, tokens: capacity, capacity, refillPerSec })
      .onConflictDoNothing();

    // Single-statement refill+consume: recompute available tokens from elapsed
    // time (capped at capacity), and only decrement when >= 1. `capacity` and
    // `refillPerSec` are taken from config each call so env changes take effect.
    const rows = await db.execute(sql`
      UPDATE ${stockRateBudget}
      SET tokens = LEAST(
            ${capacity}::real,
            ${stockRateBudget.tokens} + EXTRACT(EPOCH FROM (now() - ${stockRateBudget.updatedAt})) * ${refillPerSec}::real
          ) - 1,
          capacity = ${capacity}::real,
          refill_per_sec = ${refillPerSec}::real,
          updated_at = now()
      WHERE ${stockRateBudget.provider} = ${provider}
        AND LEAST(
            ${capacity}::real,
            ${stockRateBudget.tokens} + EXTRACT(EPOCH FROM (now() - ${stockRateBudget.updatedAt})) * ${refillPerSec}::real
          ) >= 1
      RETURNING ${stockRateBudget.tokens} AS tokens
    `);
    const granted = Array.isArray(rows) ? rows.length > 0 : ((rows as { rowCount?: number }).rowCount ?? 0) > 0;
    return granted;
  } catch {
    // Fail closed — never breach a provider's limit because the DB blipped.
    return false;
  }
}

const CACHE_TTL_MS = envNum("STOCK_CACHE_TTL_MS", 24 * 60 * 60 * 1000); // 24h (Pixabay mandate)

/** Read a cached search result (<24h old) for (provider, query), or null. */
export async function getStockCache<T>(db: Db, provider: string, query: string): Promise<T | null> {
  try {
    const [row] = await db
      .select({ candidates: stockSearchCache.candidates, fetchedAt: stockSearchCache.fetchedAt })
      .from(stockSearchCache)
      .where(sql`${stockSearchCache.provider} = ${provider} AND ${stockSearchCache.query} = ${query}`)
      .limit(1);
    if (!row) return null;
    if (Date.now() - new Date(row.fetchedAt).getTime() > CACHE_TTL_MS) return null;
    return row.candidates as T;
  } catch {
    return null;
  }
}

/** Upsert a search result for (provider, query), refreshing its 24h window. */
export async function putStockCache(db: Db, provider: string, query: string, candidates: unknown): Promise<void> {
  try {
    await db
      .insert(stockSearchCache)
      .values({ provider, query, candidates, fetchedAt: new Date() })
      .onConflictDoUpdate({
        target: [stockSearchCache.provider, stockSearchCache.query],
        set: { candidates, fetchedAt: new Date() },
      });
  } catch {
    // A cache write failure is harmless — the search just isn't memoized.
  }
}

/**
 * The gate object injected into the reference-image provider (which lives in
 * @ytauto/providers and must not depend on @ytauto/db). It closes over `db`.
 * `allow` consults the token bucket; `cacheGet`/`cachePut` back the 24h cache.
 */
export type StockGate = {
  allow(provider: StockProvider): Promise<boolean>;
  cacheGet<T>(provider: string, query: string): Promise<T | null>;
  cachePut(provider: string, query: string, candidates: unknown): Promise<void>;
};

export function createStockGate(db: Db): StockGate {
  return {
    allow: (provider) => consumeStockToken(db, provider),
    cacheGet: (provider, query) => getStockCache(db, provider, query),
    cachePut: (provider, query, candidates) => putStockCache(db, provider, query, candidates),
  };
}
