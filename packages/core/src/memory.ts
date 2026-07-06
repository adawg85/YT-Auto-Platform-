/**
 * Per-channel memory (build #5), split by type per BACKLOG #5:
 * - CANONICAL memory (charter, decisions, coverage ledger) stays first-class
 *   Postgres rows read with exact SQL — `channelStateSummary` below distills it
 *   into the always-injected "state of the world" prompt block.
 * - SEMANTIC memory (source docs, transcripts, notes) lives in the pgvector
 *   `memory_chunks` table — `ingestMemory`/`retrieveMemory` below.
 *
 * Scope tiers prevent cross-video contamination: retrieval for episode N sees
 * channel carry-over + episode N's own chunks, never another episode's dump.
 */
import { and, desc, eq, or, sql, cosineDistance } from "drizzle-orm";
import {
  channelCharters,
  channelDecisions,
  episodes,
  memoryChunks,
  series,
  ulid,
  type Db,
} from "@ytauto/db";

/** Structural mirror of the providers' EmbeddingProvider (avoids a core→providers dep). */
export type Embedder = {
  embed(texts: string[], ctx?: { channelId?: string }): Promise<number[][]>;
};

export const MEMORY_CHUNK_TARGET_CHARS = 1200;

/**
 * Sentence-boundary chunking to ~target characters. A pathological sentence
 * longer than 2× target is hard-split so no chunk grows unbounded.
 */
export function chunkText(text: string, targetChars = MEMORY_CHUNK_TARGET_CHARS): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const sentence of sentences) {
    if (sentence.length > targetChars * 2) {
      push();
      for (let i = 0; i < sentence.length; i += targetChars) {
        chunks.push(sentence.slice(i, i + targetChars).trim());
      }
      continue;
    }
    if (current && current.length + sentence.length + 1 > targetChars) push();
    current = current ? `${current} ${sentence}` : sentence;
  }
  push();
  return chunks;
}

export type MemoryKindValue =
  | "source_doc"
  | "transcript"
  | "coverage_summary"
  | "decision_note"
  | "research_note";

/**
 * Chunk + embed + insert one document into semantic memory. Defaults to
 * episode scope (conservative — promotion to channel scope is an explicit,
 * classified step). Returns the inserted chunk ids.
 */
export async function ingestMemory(
  db: Db,
  embedder: Embedder,
  doc: {
    channelId: string;
    episodeId?: string | null;
    scope?: "episode" | "channel";
    kind: MemoryKindValue;
    title: string;
    content: string;
    sourceUrl?: string;
    meta?: Record<string, unknown>;
  },
): Promise<string[]> {
  const parts = chunkText(doc.content);
  if (parts.length === 0) return [];
  const vectors = await embedder.embed(parts, { channelId: doc.channelId });
  const rows = parts.map((content, i) => ({
    id: ulid(),
    channelId: doc.channelId,
    episodeId: doc.episodeId ?? null,
    scope: doc.scope ?? ("episode" as const),
    kind: doc.kind,
    title: parts.length > 1 ? `${doc.title} (${i + 1}/${parts.length})` : doc.title,
    content,
    sourceUrl: doc.sourceUrl,
    embedding: vectors[i]!,
    meta: doc.meta,
  }));
  await db.insert(memoryChunks).values(rows);
  return rows.map((r) => r.id);
}

export type MemoryHit = typeof memoryChunks.$inferSelect & { similarity: number };

/**
 * Top-k semantic retrieval, scope-tiered: channel carry-over ∪ (optionally)
 * one episode's own chunks. Passing no episodeId retrieves channel scope only.
 */
export async function retrieveMemory(
  db: Db,
  embedder: Embedder,
  opts: { channelId: string; episodeId?: string; query: string; k?: number },
): Promise<MemoryHit[]> {
  const [queryVec] = await embedder.embed([opts.query], { channelId: opts.channelId });
  if (!queryVec) return [];
  const scopeCond = opts.episodeId
    ? or(eq(memoryChunks.scope, "channel"), eq(memoryChunks.episodeId, opts.episodeId))
    : eq(memoryChunks.scope, "channel");
  const distance = cosineDistance(memoryChunks.embedding, queryVec);
  const rows = await db
    .select({
      chunk: memoryChunks,
      distance: sql<number>`${distance}`.as("distance"),
    })
    .from(memoryChunks)
    .where(and(eq(memoryChunks.channelId, opts.channelId), scopeCond))
    .orderBy(distance)
    .limit(opts.k ?? 8);
  return rows.map((r) => ({ ...r.chunk, similarity: 1 - Number(r.distance) }));
}

/** Statuses that count as "covered or committed" in the coverage ledger. */
const COVERED_STATUSES = ["briefed", "queued", "produced", "published"] as const;

/**
 * The always-injected "state of the world" for a channel: charter mission +
 * objectives, the recent decisions ledger, and the coverage ledger. Exact SQL
 * over canonical rows — dedup questions are lookups, never similarity search.
 * Returns null when the channel has no charter (legacy channel).
 */
export async function channelStateSummary(
  db: Db,
  channelId: string,
): Promise<string | null> {
  const [charter] = await db
    .select()
    .from(channelCharters)
    .where(eq(channelCharters.channelId, channelId))
    .limit(1);
  if (!charter) return null;

  const decisions = await db
    .select()
    .from(channelDecisions)
    .where(eq(channelDecisions.channelId, channelId))
    .orderBy(desc(channelDecisions.createdAt))
    .limit(10);

  const covered = await db
    .select({
      title: episodes.title,
      status: episodes.status,
      seriesTitle: series.title,
      coverageSummary: episodes.coverageSummary,
    })
    .from(episodes)
    .innerJoin(series, eq(episodes.seriesId, series.id))
    .where(
      and(
        eq(episodes.channelId, channelId),
        sql`${episodes.status} in (${sql.join(
          COVERED_STATUSES.map((s) => sql`${s}`),
          sql`, `,
        )})`,
      ),
    )
    .orderBy(desc(episodes.updatedAt))
    .limit(50);

  const lines: string[] = [
    `MISSION: ${charter.mission}`,
    `OBJECTIVES: ${(charter.objectives ?? []).join("; ")}`,
  ];
  if (decisions.length > 0) {
    lines.push("RECENT DECISIONS:");
    for (const d of decisions) lines.push(`- [${d.kind}] ${d.summary}`);
  }
  if (covered.length > 0) {
    lines.push("ALREADY COVERED (do not duplicate):");
    for (const e of covered) {
      const summary = e.coverageSummary ? ` — ${e.coverageSummary}` : "";
      lines.push(`- ${e.title} (${e.seriesTitle}, ${e.status})${summary}`);
    }
  }
  return lines.join("\n");
}
