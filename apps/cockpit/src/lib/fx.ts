import { inArray } from "drizzle-orm";
import { fxRates } from "@ytauto/db";
import type { getAppContext } from "./context";

type Db = Awaited<ReturnType<typeof getAppContext>>["db"];

/**
 * USD→AUD spot rates by day (2026-07-19 operator: show costs in AUD at that
 * day's rate). Costs are stored in USD (the providers bill USD); the cockpit
 * converts each cost by the rate for ITS OWN date. Rates are cached in fx_rates
 * and fetched on demand from Frankfurter (ECB reference rates — free, no key).
 * Everything fails soft to a sane default so a cost surface never breaks on FX.
 */
const DEFAULT_USD_AUD = 1.53;

const ymd = (d: Date | string): string =>
  (typeof d === "string" ? d : d.toISOString()).slice(0, 10);

export type UsdAud = {
  /** 1 USD in AUD for the given cost date (nearest prior for weekends/holidays) */
  rateFor: (d: Date | string) => number;
  /** the most recent known rate — for headline "as of" display */
  latest: number;
};

export async function loadUsdAudRates(db: Db, dates: (Date | string)[]): Promise<UsdAud> {
  const want = [...new Set(dates.map(ymd))].sort();
  if (want.length === 0) return { rateFor: () => DEFAULT_USD_AUD, latest: DEFAULT_USD_AUD };

  const map = new Map<string, number>();
  try {
    const have = await db.select().from(fxRates).where(inArray(fxRates.date, want));
    for (const r of have) map.set(r.date, r.usdToAud);
  } catch {
    /* table missing / db error — fall through to fetch or default */
  }

  const missing = want.filter((d) => !map.has(d));
  if (missing.length) {
    // one range call covers every gap (ECB skips weekends/holidays — those days
    // resolve to the nearest prior rate below).
    const from = missing[0]!;
    const to = missing[missing.length - 1]!;
    try {
      const url =
        from === to
          ? `https://api.frankfurter.dev/v1/${from}?base=USD&symbols=AUD`
          : `https://api.frankfurter.dev/v1/${from}..${to}?base=USD&symbols=AUD`;
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const data = (await res.json()) as
          | { rates?: Record<string, { AUD?: number }> }
          | { rates?: { AUD?: number }; date?: string };
        const fetched: Record<string, number> = {};
        const rates = (data as { rates?: unknown }).rates;
        if (rates && typeof rates === "object") {
          // range form: { "2026-07-15": { AUD: 1.5 }, ... }
          const nested = rates as Record<string, { AUD?: number }>;
          const single = rates as { AUD?: number };
          if (typeof single.AUD === "number" && "date" in data && typeof data.date === "string") {
            fetched[data.date] = single.AUD;
          } else {
            for (const [d, r] of Object.entries(nested)) {
              if (r && typeof r.AUD === "number") fetched[d] = r.AUD;
            }
          }
        }
        const rows = Object.entries(fetched).map(([date, usdToAud]) => ({ date, usdToAud }));
        for (const row of rows) map.set(row.date, row.usdToAud);
        if (rows.length) {
          try {
            await db.insert(fxRates).values(rows).onConflictDoNothing();
          } catch {
            /* cache write is best-effort */
          }
        }
      }
    } catch {
      /* network/timeout — nearest-prior / default below */
    }
  }

  const known = [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const latest = known.length ? known[known.length - 1]![1] : DEFAULT_USD_AUD;
  const rateFor = (d: Date | string): number => {
    const key = ymd(d);
    const exact = map.get(key);
    if (exact != null) return exact;
    let prior: number | null = null;
    for (const [dd, rr] of known) {
      if (dd <= key) prior = rr;
      else break;
    }
    return prior ?? latest ?? DEFAULT_USD_AUD;
  };
  return { rateFor, latest };
}

// fmtAud lives in lib/format (pure, client-safe); re-export for server callers.
export { fmtAud } from "./format";
