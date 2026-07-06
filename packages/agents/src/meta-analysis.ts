import { and, desc, eq, isNull } from "drizzle-orm";
import { generateObject } from "ai";
import { externalVideos, ulid, type Db } from "@ytauto/db";
import {
  metaHookSchema,
  metaScriptStructureSchema,
  topicClusterSchema,
} from "@ytauto/core";
import type { ResearchProvider } from "@ytauto/providers";
import { runAgent, type AgentCtx } from "./run-agent";
import { upsertPattern } from "./pattern-store";

/** How many un-analysed external videos to deep-read per niche per run. */
const MAX_ANALYSE_PER_RUN = 6;

/**
 * Normalise a scouted video's raw stats into a 0-100 performance signal
 * comparable with our own retention-weighted scores, so external and own
 * observations blend sensibly in the shared pattern store.
 */
export function externalSignal(v: {
  outlierFactor?: number | null;
  viewsPerHour?: number | null;
  engagementRate?: number | null;
}): number {
  const parts: number[] = [];
  if (v.outlierFactor) parts.push(Math.min(100, v.outlierFactor * 4));
  if (v.engagementRate) parts.push(Math.min(100, v.engagementRate * 6));
  if (v.viewsPerHour) parts.push(Math.min(100, v.viewsPerHour / 200));
  if (parts.length === 0) return 30;
  return Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);
}

type Candidate = {
  source: "outlier" | "breakout" | "trending";
  externalId: string;
  title: string;
  channelName: string;
  url: string | null;
  views: number;
  viewsPerHour: number | null;
  outlierFactor: number | null;
  engagementRate: number | null;
  publishedAt: string | null;
  format: string;
};

/** Pull the three research feeds and normalise them into ingest candidates. */
async function gatherCandidates(
  research: ResearchProvider,
  niche: string,
): Promise<Candidate[]> {
  const [outliers, breakout, trending] = await Promise.all([
    research.outliers(niche),
    research.breakoutChannels(niche),
    research.trendingVideos(niche),
  ]);

  const candidates: Candidate[] = [];
  for (const o of outliers) {
    candidates.push({
      source: "outlier",
      externalId: o.externalId,
      title: o.title,
      channelName: o.channelName,
      url: o.url ?? null,
      views: o.views,
      viewsPerHour: o.viewsPerHour ?? null,
      outlierFactor: o.outlierFactor,
      engagementRate: null,
      publishedAt: o.publishedAt,
      format: "shorts",
    });
  }
  for (const b of breakout) {
    candidates.push({
      source: "breakout",
      externalId: b.topVideo.externalId,
      title: b.topVideo.title,
      channelName: b.channelName,
      url: null,
      views: b.topVideo.views,
      viewsPerHour: b.topVideo.viewsPerHour,
      outlierFactor: null,
      engagementRate: null,
      publishedAt: b.topVideo.publishedAt,
      format: "shorts",
    });
  }
  for (const t of trending) {
    candidates.push({
      source: "trending",
      externalId: t.externalId,
      title: t.title,
      channelName: t.channelName,
      url: null,
      views: t.views,
      viewsPerHour: t.viewsPerHour,
      outlierFactor: null,
      engagementRate: t.engagementRate,
      publishedAt: t.publishedAt,
      format: t.format,
    });
  }
  // de-dupe within this run (a video can surface in more than one feed)
  const seen = new Set<string>();
  return candidates.filter((c) => (seen.has(c.externalId) ? false : (seen.add(c.externalId), true)));
}

async function ingestCandidates(db: Db, niche: string, candidates: Candidate[], now: Date) {
  for (const c of candidates) {
    await db
      .insert(externalVideos)
      .values({
        id: ulid(),
        source: c.source,
        externalId: c.externalId,
        niche,
        format: c.format,
        title: c.title,
        channelName: c.channelName,
        url: c.url,
        views: c.views,
        viewsPerHour: c.viewsPerHour,
        outlierFactor: c.outlierFactor,
        engagementRate: c.engagementRate,
        publishedAt: c.publishedAt ? new Date(c.publishedAt) : null,
        capturedAt: now,
      })
      // refresh stats on re-scan; never clobber transcript/analyzedAt
      .onConflictDoUpdate({
        target: [externalVideos.niche, externalVideos.externalId],
        set: {
          views: c.views,
          viewsPerHour: c.viewsPerHour,
          outlierFactor: c.outlierFactor,
          engagementRate: c.engagementRate,
          capturedAt: now,
          updatedAt: now,
        },
      });
  }
}

/**
 * Meta-analysis engine (build #4) for a single niche. Ingests over-performing
 * external content (outliers + breakout channels + trending) into
 * external_videos, deep-reads the highest-signal un-analysed transcripts into
 * hook + script-structure patterns (source="external"), and clusters the batch
 * into topic signals — all folded into the SAME shared pattern store our own
 * post-publish analysis writes to. This is the market-facing half of "what's
 * working"; ideation/scoring/scriptwriter read the merged view.
 */
export async function runMetaAnalysisForNiche(
  ctx: AgentCtx,
  research: ResearchProvider,
  opts: { niche: string; format?: string; now?: Date },
): Promise<{
  niche: string;
  ingested: number;
  analysed: number;
  hookPatterns: number;
  structurePatterns: number;
  topicSignals: number;
}> {
  const { niche } = opts;
  const format = opts.format ?? "shorts";
  const now = opts.now ?? new Date();

  const candidates = await gatherCandidates(research, niche);
  await ingestCandidates(ctx.db, niche, candidates, now);

  // deep-read the highest-signal un-analysed videos this run
  const pending = await ctx.db
    .select()
    .from(externalVideos)
    .where(and(eq(externalVideos.niche, niche), isNull(externalVideos.analyzedAt)))
    .orderBy(desc(externalVideos.outlierFactor), desc(externalVideos.viewsPerHour))
    .limit(MAX_ANALYSE_PER_RUN);

  let analysed = 0;
  let hookPatterns = 0;
  let structurePatterns = 0;

  for (const v of pending) {
    const transcript = await research.transcript(v.externalId);
    if (!transcript) {
      // nothing to read — mark analysed so we don't retry every scan
      await ctx.db
        .update(externalVideos)
        .set({ analyzedAt: now })
        .where(eq(externalVideos.id, v.id));
      continue;
    }

    const signal = externalSignal(v);
    const analysisPrompt = [
      `NICHE: ${niche}`,
      `TITLE: ${v.title}`,
      `TRANSCRIPT: ${transcript}`,
    ].join("\n");

    // ── Hook extraction ──────────────────────────────────────────────────
    const hook = await runAgent(
      "meta_hook",
      "cheap",
      ctx,
      `meta-hook: ${v.title.slice(0, 50)}`,
      async (model) => {
        const res = await generateObject({
          model,
          schema: metaHookSchema,
          system:
            "TASK:meta-hook — This is a scouted competitor video that over-performed. Isolate its opening hook, classify the archetype, and give a short kebab-case label + tags. Abstract the SHAPE only — never store verbatim substance.",
          prompt: analysisPrompt,
        });
        return { object: res.object, usage: res.usage };
      },
    );

    // ── Script-structure extraction ──────────────────────────────────────
    const structure = await runAgent(
      "meta_script",
      "cheap",
      ctx,
      `meta-script: ${v.title.slice(0, 50)}`,
      async (model) => {
        const res = await generateObject({
          model,
          schema: metaScriptStructureSchema,
          system:
            "TASK:meta-script — Segment this scouted transcript into its beat structure (hook/stat/insight/cta). Return the beat sequence and a label. Structure only — no verbatim content.",
          prompt: analysisPrompt,
        });
        return { object: res.object, usage: res.usage };
      },
    );

    await upsertPattern(ctx.db, {
      kind: "hook",
      label: hook.label,
      niche,
      format,
      source: "external",
      detail: { archetype: hook.archetype, opener: hook.opener, tags: hook.tags },
      sampleRef: v.externalId,
      signal,
      now,
    });
    hookPatterns++;

    await upsertPattern(ctx.db, {
      kind: "script_structure",
      label: structure.label,
      niche,
      format,
      source: "external",
      detail: { beatSequence: structure.beatSequence, notes: structure.notes },
      sampleRef: v.externalId,
      signal,
      now,
    });
    structurePatterns++;

    await ctx.db
      .update(externalVideos)
      .set({ transcript, analyzedAt: now })
      .where(eq(externalVideos.id, v.id));
    analysed++;
  }

  // ── Topic/niche clustering over the whole batch ────────────────────────
  let topicSignals = 0;
  if (candidates.length > 0) {
    const clusterPrompt = [
      `NICHE: ${niche}`,
      "RISING TITLES:",
      ...candidates.slice(0, 12).map((c) => `- ${c.title}`),
    ].join("\n");
    const cluster = await runAgent(
      "meta_topics",
      "cheap",
      ctx,
      `topic cluster: ${niche}`,
      async (model) => {
        const res = await generateObject({
          model,
          schema: topicClusterSchema,
          system:
            "TASK:topic-cluster — Roll these rising videos up into the angles heating up in this niche right now. Each signal gets a terse label, a one-sentence angle, and a 0-100 momentum.",
          prompt: clusterPrompt,
        });
        return { object: res.object, usage: res.usage };
      },
    );
    for (const s of cluster.signals) {
      await upsertPattern(ctx.db, {
        kind: "topic_signal",
        label: s.label,
        niche,
        format,
        source: "external",
        detail: { angle: s.angle, momentum: s.momentum },
        sampleRef: candidates[0]!.externalId,
        signal: s.momentum,
        now,
      });
      topicSignals++;
    }
  }

  return {
    niche,
    ingested: candidates.length,
    analysed,
    hookPatterns,
    structurePatterns,
    topicSignals,
  };
}
