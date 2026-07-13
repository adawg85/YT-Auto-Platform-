import { and, eq } from "drizzle-orm";
import { patterns, ulid, type Db } from "@ytauto/db";

/**
 * Rolling, retention-weighted upsert into the shared pattern store. Same
 * (kind, niche, format, label) folds into one row whose performanceScore is the
 * running mean of the observed signal — so the store self-corrects as more
 * videos are observed, whether they're our own published videos (build #3.2,
 * source="own") or scouted external content (build #4, source="external").
 *
 * Read-modify-write is safe because both the analysis and market-scan workers
 * run with concurrency 1; the unique index is the correctness backstop.
 */
export async function upsertPattern(
  db: Db,
  p: {
    kind: "hook" | "script_structure" | "topic_signal" | "thumbnail";
    label: string;
    niche: string;
    format: string;
    detail: Record<string, unknown>;
    sampleRef: string;
    signal: number | null;
    source?: "own" | "external";
    now?: Date;
  },
): Promise<void> {
  const signal = p.signal ?? 0;
  const source = p.source ?? "own";
  const now = p.now ?? new Date();

  const [existing] = await db
    .select()
    .from(patterns)
    .where(
      and(
        eq(patterns.kind, p.kind),
        eq(patterns.niche, p.niche),
        eq(patterns.format, p.format),
        eq(patterns.label, p.label),
      ),
    );

  if (existing) {
    const obs = existing.observations + 1;
    const score = (existing.performanceScore * existing.observations + signal) / obs;
    const refs = existing.sampleRefs.includes(p.sampleRef)
      ? existing.sampleRefs
      : [...existing.sampleRefs, p.sampleRef].slice(-25);
    // an external observation of a previously own-only pattern (or vice versa)
    // promotes it to a merged view — surface that both saw it
    const mergedSource = existing.source === source ? existing.source : "external";
    await db
      .update(patterns)
      .set({
        performanceScore: Math.round(score * 10) / 10,
        observations: obs,
        sampleRefs: refs,
        detail: p.detail,
        source: mergedSource,
        lastSeen: now,
      })
      .where(eq(patterns.id, existing.id));
    return;
  }

  await db
    .insert(patterns)
    .values({
      id: ulid(),
      kind: p.kind,
      label: p.label,
      niche: p.niche,
      format: p.format,
      source,
      detail: p.detail,
      sampleRefs: [p.sampleRef],
      performanceScore: Math.round(signal * 10) / 10,
      observations: 1,
      lastSeen: now,
    })
    .onConflictDoNothing();
}
