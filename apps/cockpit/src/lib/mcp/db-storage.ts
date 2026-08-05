import { sql } from "drizzle-orm";
import { capacityStatus } from "@ytauto/core";
import type { Db } from "@ytauto/db";

/**
 * Where the Postgres disk is actually going (2026-08-05 cost review).
 *
 * The nightly data-janitor already measured `pg_database_size` for its capacity
 * ALERT, but the number was only ever written into agent_actions and an alert
 * that fires at 80% — so "how big is the DB, and what is making it big?" had no
 * answer short of opening psql. That is fine at a desk and impossible from a
 * phone, which is exactly when the question gets asked (the operator was
 * travelling and could not run psql to size the $23.44/mo ytauto-db line).
 *
 * Read-only, and every part is best-effort: a permissions or stats failure
 * degrades to nulls rather than breaking the whole diagnostic it is embedded in.
 */

export type TableSize = { table: string; totalBytes: number; totalPretty: string };

export type DbStorage = {
  usedBytes: number | null;
  usedPretty: string | null;
  /** DB_STORAGE_GB — the PLAN quota the janitor's alert thresholds key on. */
  quotaGb: number;
  usedPct: number | null;
  cacheHitRatio: number | null;
  level: "ok" | "warning" | "critical" | null;
  message: string | null;
  largestTables: TableSize[];
  note: string;
};

export async function dbStorage(db: Db, quotaGbEnv?: string): Promise<DbStorage> {
  // DB_STORAGE_GB is the janitor's quota input and defaults to 10 in both
  // places. It is NOT read from Render, so if the provisioned disk differs the
  // percentages below are relative to what is configured, not what exists.
  const quotaGb = Number(quotaGbEnv ?? 10) || 10;

  let usedBytes: number | null = null;
  let cacheHitRatio: number | null = null;
  let largestTables: TableSize[] = [];

  try {
    const rows = (await db.execute(
      sql`SELECT pg_database_size(current_database())::bigint AS bytes`,
    )) as unknown as { bytes: string | number }[];
    const bytes = Number(rows[0]?.bytes ?? NaN);
    if (Number.isFinite(bytes)) usedBytes = bytes;
  } catch {
    // leave null — the caller renders "unavailable", never throws
  }

  try {
    const rows = (await db.execute(sql`
      SELECT CASE WHEN sum(blks_hit) + sum(blks_read) = 0 THEN NULL
             ELSE sum(blks_hit)::float / (sum(blks_hit) + sum(blks_read)) END AS ratio
      FROM pg_stat_database WHERE datname = current_database()
    `)) as unknown as { ratio: number | null }[];
    const ratio = rows[0]?.ratio;
    cacheHitRatio = ratio == null ? null : Number(ratio);
  } catch {
    /* ignore */
  }

  try {
    // total_relation_size = heap + indexes + TOAST, i.e. what the disk actually
    // holds for that table. Ordered so the top of the list IS the thing to fix.
    const rows = (await db.execute(sql`
      SELECT c.relname AS table,
             pg_total_relation_size(c.oid)::bigint AS total_bytes,
             pg_size_pretty(pg_total_relation_size(c.oid)) AS total_pretty
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY pg_total_relation_size(c.oid) DESC
      LIMIT 15
    `)) as unknown as { table: string; total_bytes: string | number; total_pretty: string }[];
    largestTables = rows.map((r) => ({
      table: r.table,
      totalBytes: Number(r.total_bytes),
      totalPretty: r.total_pretty,
    }));
  } catch {
    /* ignore */
  }

  const status =
    usedBytes == null ? null : capacityStatus({ usedBytes, quotaGb, cacheHitRatio });

  return {
    usedBytes,
    usedPretty: usedBytes == null ? null : prettyBytes(usedBytes),
    quotaGb,
    usedPct: status?.usedPct ?? null,
    cacheHitRatio,
    level: status?.level ?? null,
    message: status?.message ?? null,
    largestTables,
    note:
      "Live Postgres sizing, same query the nightly data-janitor uses for its capacity alert — read it to decide whether the ytauto-db plan/disk is right-sized. `usedPct` is against DB_STORAGE_GB (default 10), which is a CONFIGURED number, not one read from Render: if the provisioned disk differs, set DB_STORAGE_GB to match or the percentage and the janitor's alert thresholds are both off. `largestTables` includes indexes and TOAST, so the top entry is where retention work pays.",
  };
}

function prettyBytes(n: number): string {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${Math.round(v * 100) / 100} ${units[u]}`;
}
