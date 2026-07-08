import { generateObject } from "ai";
import {
  coverageSummarySchema,
  memoryPromotionSchema,
  type CoverageSummary,
  type MemoryPromotion,
} from "@ytauto/core";
import { runAgent, type AgentCtx, repairDoubleEncodedJson } from "../run-agent";

/** Post-publish: transcript → the lean coverage summary that carries over (cheap tier). */
export async function summarizeCoverage(
  ctx: AgentCtx,
  input: { topic: string; transcript: string },
): Promise<CoverageSummary> {
  const prompt = [`TOPIC: ${input.topic}`, `TRANSCRIPT: ${input.transcript}`].join("\n");
  return runAgent("coverage_summary", "cheap", ctx, `coverage summary for ${input.topic}`, async (model) => {
    const res = await generateObject({
      model,
      schema: coverageSummarySchema,
      experimental_repairText: repairDoubleEncodedJson,
      system:
        "TASK:coverage — Compress the published transcript into 2-3 sentences: what we said and how it " +
        "was framed. This feeds continuity, callbacks, and dedup — substance over style.",
      prompt,
    });
    return { object: res.object, usage: res.usage };
  });
}

/**
 * Which episode-scoped research chunks are clearly channel-general? Default is
 * episode scope; promotion is conservative by design (cheap tier).
 */
export async function classifyMemoryScope(
  ctx: AgentCtx,
  input: { chunks: { index: number; text: string }[] },
): Promise<MemoryPromotion> {
  const prompt = input.chunks
    .map((c) => `CHUNK ${c.index}: ${c.text.slice(0, 400)}`)
    .join("\n");
  return runAgent("memory_scope", "cheap", ctx, `classify ${input.chunks.length} chunks`, async (model) => {
    const res = await generateObject({
      model,
      schema: memoryPromotionSchema,
      experimental_repairText: repairDoubleEncodedJson,
      system:
        "TASK:memory-promote — Promote a chunk to channel scope ONLY if it is clearly general knowledge " +
        "useful across many future episodes. When in doubt, do NOT promote (episode scope is the default).",
      prompt,
    });
    return { object: res.object, usage: res.usage };
  });
}
