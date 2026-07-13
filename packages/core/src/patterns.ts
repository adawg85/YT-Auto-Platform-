/**
 * Shared pattern-store read + ranking (build #4). The `patterns` table is the
 * unified knowledge base: build #3.2 folds our own published videos into it and
 * build #4's meta-analysis engine folds in scouted external content. Both write
 * via the same rolling upsert; everything reads through here.
 *
 * A pattern's usefulness = how well it performed × how fresh it is. Raw
 * performanceScore alone would keep surfacing stale winners, so we decay by
 * recency (a trend that broke out last week beats one from last quarter).
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { patterns, type Db } from "@ytauto/db";

export type PatternKind = "hook" | "script_structure" | "topic_signal" | "thumbnail";
export type PatternSource = "own" | "external";
export type PatternRow = typeof patterns.$inferSelect;

/** Half-life of a pattern's freshness, in days. */
export const PATTERN_FRESHNESS_HALF_LIFE_DAYS = 21;

/**
 * Recency multiplier in (0, 1]: 1.0 when just seen, 0.5 at one half-life, etc.
 * Clamped so an ancient-but-strong pattern never ranks entirely to zero.
 */
export function patternFreshness(
  lastSeen: Date | string,
  now: Date = new Date(),
): number {
  const ageMs = now.getTime() - new Date(lastSeen).getTime();
  const ageDays = Math.max(0, ageMs / 86_400_000);
  const decay = Math.pow(0.5, ageDays / PATTERN_FRESHNESS_HALF_LIFE_DAYS);
  return Math.max(0.05, decay);
}

/** Freshness-weighted rank score for a pattern (higher = surface sooner). */
export function patternRank(p: PatternRow, now: Date = new Date()): number {
  return p.performanceScore * patternFreshness(p.lastSeen, now);
}

/** Sort a copy of the rows by freshness-weighted rank, best first. */
export function rankPatterns(rows: PatternRow[], now: Date = new Date()): PatternRow[] {
  return [...rows].sort((a, b) => patternRank(b, now) - patternRank(a, now));
}

/**
 * Top patterns for a niche/format, freshness-ranked. Used as grounding for
 * ideation/scoring/scriptwriter and as the cockpit "what's working" data.
 */
export async function topPatternsForNiche(
  db: Db,
  opts: {
    niche: string;
    format?: string;
    kind?: PatternKind;
    source?: PatternSource;
    limit?: number;
    now?: Date;
  },
): Promise<PatternRow[]> {
  const { niche, format = "shorts", kind, source, limit = 5, now = new Date() } = opts;
  const conds = [eq(patterns.niche, niche), eq(patterns.format, format)];
  if (kind) conds.push(eq(patterns.kind, kind));
  if (source) conds.push(eq(patterns.source, source));

  const rows = await db
    .select()
    .from(patterns)
    .where(and(...conds))
    // pull a generous slab ordered by raw score, then freshness-rank in code
    .orderBy(desc(patterns.performanceScore))
    .limit(Math.max(limit * 4, 20));

  return rankPatterns(rows, now).slice(0, limit);
}

/** Same, but across several kinds in one round-trip (grouped by kind). */
export async function patternGrounding(
  db: Db,
  opts: { niche: string; format?: string; perKind?: number; now?: Date },
): Promise<{ hooks: PatternRow[]; structures: PatternRow[]; topics: PatternRow[] }> {
  const { niche, format = "shorts", perKind = 3, now = new Date() } = opts;
  const rows = await db
    .select()
    .from(patterns)
    .where(and(eq(patterns.niche, niche), eq(patterns.format, format)))
    .orderBy(desc(patterns.performanceScore))
    .limit(120);
  const ranked = rankPatterns(rows, now);
  const take = (k: PatternKind) => ranked.filter((r) => r.kind === k).slice(0, perKind);
  return { hooks: take("hook"), structures: take("script_structure"), topics: take("topic_signal") };
}

/** Compact one-line-per-pattern text for LLM grounding prompts. */
export function patternsToPromptLines(rows: PatternRow[], now: Date = new Date()): string[] {
  return rows.map((r) => {
    const fresh = r.source === "external" ? "external" : "own";
    return `- [${fresh}] ${r.label} (score ${Math.round(patternRank(r, now))}, seen in ${r.observations})`;
  });
}

/** Resolve display metadata for a set of pattern ids (cockpit helpers). */
export async function patternsByIds(db: Db, ids: string[]): Promise<PatternRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(patterns).where(inArray(patterns.id, ids));
}
