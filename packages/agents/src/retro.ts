import { generateObject } from "ai";
import {
  retroProposalSchema,
  type MaturityPhase,
  type RetroProposal,
} from "@ytauto/core";
import { temperatureFor } from "@ytauto/providers";
import { runAgent, repairDoubleEncodedJson, type AgentCtx } from "./run-agent";

export type RetroVideoInput = {
  publicationId: string;
  title: string;
  views: number;
  avgViewPct: number | null;
  /** this video's 3s-hold vs the channel average (percentage points) */
  vsChannelAvgPct: number | null;
  hookArchetype: string | null;
  hookTags: string[];
  hookAssessment: string | null;
  strengths: string | null;
  trimSuggestion: string | null;
};

/**
 * Channel retro agent (#21.5) — the learning loop's decision engine. Reads
 * MATURED post-publish analyses vs the channel baseline and proposes playbook
 * adoptions/retirements + experiment candidates. The model proposes; code
 * disposes: validateRetroProposal enforces ≥3-video evidence, bounded counts,
 * and warming channels are observe-only regardless of what it returns.
 */
export async function channelRetro(
  ctx: AgentCtx,
  input: {
    maturity: MaturityPhase;
    baseline: { medianViews: number; avgViewPct: number | null; publishedCount: number };
    videos: RetroVideoInput[];
    playbook: { id: string; scope: string; directive: string; status: string; why: string }[];
  },
): Promise<RetroProposal> {
  const system =
    "TASK:retro — You are a channel retrospective analyst deciding what THIS channel's own " +
    "published results prove. You may propose: (a) ADOPTIONS — small standing directives the " +
    "evidence REPEATS across at least 3 matured videos (cite their publication ids; 'worked once' " +
    "is not a rule); (b) RETIREMENTS — existing playbook entries whose evidence decayed or " +
    "reversed; (c) EXPERIMENT CANDIDATES — bigger single-variable swings that deserve a " +
    "controlled test, not a standing rule. Be conservative: small-channel data is noisy, an " +
    "empty proposal is a valid answer, and never propose a directive that duplicates an " +
    "existing playbook entry. Directives steer STYLE and STRUCTURE only — never facts or topics' " +
    "truthfulness. Always fill `observations` with what the data is starting to show.";

  const prompt = [
    `CHANNEL MATURITY: ${input.maturity}${input.maturity === "warming" ? " (observe-only — proposals will be logged, not applied)" : ""}`,
    `BASELINE: ${input.baseline.publishedCount} published · median views ${input.baseline.medianViews} · avg retention ${input.baseline.avgViewPct?.toFixed(1) ?? "n/a"}%`,
    input.playbook.length
      ? `CURRENT PLAYBOOK:\n${input.playbook.map((p) => `- [${p.id}] (${p.status}/${p.scope}) ${p.directive} — ${p.why}`).join("\n")}`
      : "CURRENT PLAYBOOK: empty",
    "MATURED VIDEOS (the ONLY evidence you may cite):",
    ...input.videos.map(
      (v) =>
        `- [${v.publicationId}] "${v.title}" · ${v.views} views · retention ${v.avgViewPct?.toFixed(1) ?? "?"}% · 3s-hold vs channel ${v.vsChannelAvgPct == null ? "?" : (v.vsChannelAvgPct >= 0 ? "+" : "") + v.vsChannelAvgPct.toFixed(1)}pp · hook ${v.hookArchetype ?? "?"} [${v.hookTags.join(", ")}]${v.hookAssessment ? ` · ${v.hookAssessment}` : ""}${v.strengths ? ` · strengths: ${v.strengths}` : ""}${v.trimSuggestion ? ` · trim: ${v.trimSuggestion}` : ""}`,
    ),
  ]
    .filter(Boolean)
    .join("\n");

  return runAgent(
    "channel_retro",
    "agentic",
    ctx,
    `retro over ${input.videos.length} matured videos (${input.maturity})`,
    async (model, modelId) => {
      const res = await generateObject({
        model,
        schema: retroProposalSchema,
        experimental_repairText: repairDoubleEncodedJson,
        temperature: temperatureFor(modelId, "judge"),
        system,
        prompt,
      });
      return { object: res.object, usage: res.usage };
    },
  );
}
