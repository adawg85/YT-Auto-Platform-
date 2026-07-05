import { and, desc, eq } from "drizzle-orm";
import { generateObject } from "ai";
import {
  assets,
  hookAnalyses,
  patterns,
  scriptAnalyses,
  scriptDrafts,
  ulid,
  type ScriptBeat,
  type ScriptBeatAnalysis,
  type WordTimestamp,
} from "@ytauto/db";
import {
  hookAnalysisSchema,
  retentionAtSec,
  scriptAnalysisSchema,
  videoPerformance,
  type VideoPerformance,
} from "@ytauto/core";
import { runAgent, type AgentCtx } from "./run-agent";

/**
 * Distribute beats across the runtime. When we have word-level voiceover
 * timings we slice consecutive word ranges proportional to each beat's word
 * count; otherwise we fall back to an even proportional split over durationSec.
 */
function beatTimings(
  beats: ScriptBeat[],
  words: WordTimestamp[] | null,
  durationSec: number | null,
): { startSec: number; endSec: number }[] {
  const counts = beats.map((b) => Math.max(1, b.text.trim().split(/\s+/).length));
  const totalWords = counts.reduce((a, b) => a + b, 0);
  const round = (n: number) => Math.round(n * 10) / 10;

  if (words && words.length > 0) {
    let wi = 0;
    return beats.map((_, i) => {
      const share = counts[i]! / totalWords;
      const span = Math.max(1, Math.round(share * words.length));
      const start = words[Math.min(wi, words.length - 1)]!.startSec;
      const endIdx = Math.min(wi + span - 1, words.length - 1);
      const end = words[endIdx]!.endSec;
      wi += span;
      return { startSec: round(start), endSec: round(end) };
    });
  }

  const d = durationSec ?? beats.length * 6;
  let acc = 0;
  return beats.map((_, i) => {
    const start = acc;
    acc += (counts[i]! / totalWords) * d;
    return { startSec: round(start), endSec: round(acc) };
  });
}

/**
 * Rolling, retention-weighted upsert into the shared pattern store. Same
 * (kind, niche, format, label) folds into one row whose performanceScore is the
 * running mean of the observed signal — so the store self-corrects as more of
 * our videos publish (and, later, as build #4 writes external observations).
 *
 * Read-modify-write is safe here because the analysis worker runs with
 * concurrency 1; the unique index is the correctness backstop.
 */
async function upsertPattern(
  db: AgentCtx["db"],
  p: {
    kind: "hook" | "script_structure" | "topic_signal";
    label: string;
    niche: string;
    format: string;
    detail: Record<string, unknown>;
    sampleRef: string;
    signal: number | null;
  },
): Promise<void> {
  const signal = p.signal ?? 0;
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
    await db
      .update(patterns)
      .set({
        performanceScore: Math.round(score * 10) / 10,
        observations: obs,
        sampleRefs: refs,
        detail: p.detail,
        lastSeen: new Date(),
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
      source: "own",
      detail: p.detail,
      sampleRefs: [p.sampleRef],
      performanceScore: Math.round(signal * 10) / 10,
      observations: 1,
      lastSeen: new Date(),
    })
    .onConflictDoNothing();
}

/**
 * Per-video AI analysis (build #3.2). Reads a published video's script +
 * retention snapshot and produces a hook analysis and a beat-by-beat script
 * analysis, persists both, and folds the learnings into the shared pattern
 * store. Numeric hold metrics come from the retention curve in code; the model
 * supplies the classification, tags, and narrative.
 *
 * Returns null if the publication has no analytics or no script yet.
 */
export async function analyzeVideo(
  ctx: AgentCtx,
  publicationId: string,
): Promise<{ perf: VideoPerformance } | null> {
  const perf = await videoPerformance(ctx.db, publicationId);
  if (!perf || !perf.hasAnalytics) return null;

  const [draft] = await ctx.db
    .select()
    .from(scriptDrafts)
    .where(eq(scriptDrafts.productionId, perf.productionId))
    .orderBy(desc(scriptDrafts.version))
    .limit(1);
  if (!draft) return null;

  const [voice] = await ctx.db
    .select({ meta: assets.meta })
    .from(assets)
    .where(and(eq(assets.productionId, perf.productionId), eq(assets.kind, "voiceover")));
  const words = (voice?.meta?.words as WordTimestamp[] | undefined) ?? null;

  const timings = beatTimings(draft.beats, words, perf.durationSec);
  const structure: ScriptBeatAnalysis[] = draft.beats.map((b, i) => ({
    type: b.type,
    summary: b.text.slice(0, 120),
    startSec: timings[i]!.startSec,
    endSec: timings[i]!.endSec,
    retentionAtStartPct: retentionAtSec(perf.retentionCurve, timings[i]!.startSec, perf.durationSec),
    working: false, // set from the model below
  }));

  const ctxWithProd: AgentCtx = { ...ctx, channelId: perf.channelId, productionId: perf.productionId };
  const curveSummary = perf.retentionCurve
    ? perf.retentionCurve.map((v) => Math.round(v)).join(", ")
    : "unavailable";

  // ── Hook analysis ──────────────────────────────────────────────────────
  const hookPrompt = [
    `HOOK LINE: ${draft.hookText}`,
    `NICHE: ${perf.niche}`,
    `3-SECOND HOLD: ${perf.threeSecondHoldPct != null ? `${Math.round(perf.threeSecondHoldPct)}%` : "unknown"}`,
    `CHANNEL AVG % VIEWED: ${perf.channelAvgViewPct != null ? `${Math.round(perf.channelAvgViewPct)}%` : "unknown"}`,
    `THIS VIDEO % VIEWED: ${perf.avgViewPct != null ? `${Math.round(perf.avgViewPct)}%` : "unknown"}`,
    `SWIPE-AWAY (0-3s): ${perf.swipeAwayPct != null ? `${Math.round(perf.swipeAwayPct)}%` : "unknown"}`,
    `RETENTION CURVE (%): ${curveSummary}`,
  ].join("\n");

  const hook = await runAgent(
    "hook_analysis",
    "agentic",
    ctxWithProd,
    `analyze hook: ${draft.hookText.slice(0, 60)}`,
    async (model) => {
      const res = await generateObject({
        model,
        schema: hookAnalysisSchema,
        system:
          "TASK:hook-analysis — Classify this Shorts hook's archetype, tag its technique, and assess in 2-3 sentences how it held through the first-3-seconds cliff versus the channel average. Base the judgement on the retention curve and hold numbers provided.",
        prompt: hookPrompt,
      });
      return { object: res.object, usage: res.usage };
    },
  );

  // ── Script analysis ────────────────────────────────────────────────────
  const scriptPrompt = [
    `NICHE: ${perf.niche}`,
    `DURATION: ${perf.durationSec != null ? `${Math.round(perf.durationSec)}s` : "unknown"}`,
    `AVG % VIEWED: ${perf.avgViewPct != null ? `${Math.round(perf.avgViewPct)}%` : "unknown"}`,
    "BEATS (type @ start-end, retention% at start):",
    ...structure.map(
      (b, i) =>
        `  ${i}. ${b.type} @ ${b.startSec}-${b.endSec}s (ret ${b.retentionAtStartPct != null ? `${Math.round(b.retentionAtStartPct)}%` : "?"}): ${b.summary}`,
    ),
  ].join("\n");

  const script = await runAgent(
    "script_analysis",
    "agentic",
    ctxWithProd,
    `analyze script: ${perf.title.slice(0, 60)}`,
    async (model) => {
      const res = await generateObject({
        model,
        schema: scriptAnalysisSchema,
        system:
          "TASK:script-analysis — Assess this Shorts script beat-by-beat against its retention curve. Flag each beat working=true/false based on whether retention holds through it, note overall strengths, and give ONE concrete trim/tighten suggestion tied to where retention dips.",
        prompt: scriptPrompt,
      });
      return { object: res.object, usage: res.usage };
    },
  );

  // fold the model's per-beat working flags back onto the timed structure
  script.beats.forEach((b, i) => {
    if (structure[i]) structure[i]!.working = b.working;
  });
  const dipAtSec =
    script.dipBeatIndex != null && structure[script.dipBeatIndex]
      ? structure[script.dipBeatIndex]!.startSec
      : null;

  // ── Persist (idempotent per publication) ─────────────────────────────────
  await ctx.db
    .insert(hookAnalyses)
    .values({
      id: ulid(),
      publicationId,
      productionId: perf.productionId,
      hookText: draft.hookText,
      archetype: hook.archetype,
      threeSecondHoldPct: perf.threeSecondHoldPct,
      vsChannelAvgPct: perf.vsChannelAvgPct,
      tags: hook.tags,
      assessment: hook.assessment,
    })
    .onConflictDoUpdate({
      target: hookAnalyses.publicationId,
      set: {
        hookText: draft.hookText,
        archetype: hook.archetype,
        threeSecondHoldPct: perf.threeSecondHoldPct,
        vsChannelAvgPct: perf.vsChannelAvgPct,
        tags: hook.tags,
        assessment: hook.assessment,
        updatedAt: new Date(),
      },
    });

  await ctx.db
    .insert(scriptAnalyses)
    .values({
      id: ulid(),
      publicationId,
      productionId: perf.productionId,
      structure,
      strengths: script.strengths,
      trimSuggestion: script.trimSuggestion,
      dipAtSec,
    })
    .onConflictDoUpdate({
      target: scriptAnalyses.publicationId,
      set: {
        structure,
        strengths: script.strengths,
        trimSuggestion: script.trimSuggestion,
        dipAtSec,
        updatedAt: new Date(),
      },
    });

  // ── Fold into the shared pattern store ───────────────────────────────────
  await upsertPattern(ctx.db, {
    kind: "hook",
    label: hook.archetype,
    niche: perf.niche,
    format: "shorts",
    detail: { archetype: hook.archetype, tags: hook.tags, opener: draft.hookText.slice(0, 120) },
    sampleRef: publicationId,
    signal: perf.threeSecondHoldPct ?? perf.avgViewPct,
  });
  await upsertPattern(ctx.db, {
    kind: "script_structure",
    label: draft.beats.map((b) => b.type).join("→"),
    niche: perf.niche,
    format: "shorts",
    detail: { beatSequence: draft.beats.map((b) => b.type) },
    sampleRef: publicationId,
    signal: perf.avgViewPct,
  });

  return { perf };
}
