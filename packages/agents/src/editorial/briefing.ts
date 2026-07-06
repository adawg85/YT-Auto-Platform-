import { generateObject } from "ai";
import {
  briefingComposeSchema,
  experimentConcludeSchema,
  type BriefingCompose,
  type ExperimentEvaluation,
} from "@ytauto/core";
import { runAgent, type AgentCtx } from "../run-agent";

export type BriefingFacts = {
  channelName: string;
  niche: string;
  cadence: string;
  periodStart: Date;
  periodEnd: Date;
  /** the always-injected canonical state (charter + decisions + coverage) */
  stateSummary: string | null;
  published: number;
  avgPctViewed: number | null;
  totalViews: number;
  openGates: number;
  openAlerts: number;
  costUsd: number;
  activeSeries: { title: string; remaining: number } | null;
  /** pattern-store lines — what's working in the niche right now */
  patternLines: string[];
  activeExperiment: { variable: string; variant: string; sampleSize: number } | null;
  /** experiments concluded this period (result + readout) */
  concludedExperiments: { variable: string; variant: string; result: string; readout: string }[];
};

/**
 * Compose the operator check-in (build #5.2): "what happened / direction /
 * suggestions / do you agree?". Suggestions may include AT MOST ONE proposed
 * experiment, and only when none is active — one variable at a time is the
 * whole point.
 */
export async function composeBriefing(ctx: AgentCtx, facts: BriefingFacts): Promise<BriefingCompose> {
  const lines = [
    `CHANNEL: ${facts.channelName} (niche: ${facts.niche}, cadence: ${facts.cadence})`,
    `PERIOD: ${facts.periodStart.toISOString().slice(0, 10)} → ${facts.periodEnd.toISOString().slice(0, 10)}`,
    `PUBLISHED: ${facts.published} videos, ${facts.totalViews} views${facts.avgPctViewed != null ? `, avg ${facts.avgPctViewed.toFixed(0)}% viewed` : ""}`,
    `OPEN: ${facts.openGates} review gates, ${facts.openAlerts} alerts`,
    `SPEND: $${facts.costUsd.toFixed(2)} this period`,
    facts.activeSeries
      ? `ACTIVE SERIES: "${facts.activeSeries.title}" (${facts.activeSeries.remaining} episodes remaining)`
      : "ACTIVE SERIES: none",
    facts.activeExperiment
      ? `ACTIVE EXPERIMENT: ${facts.activeExperiment.variable} → ${facts.activeExperiment.variant} (n=${facts.activeExperiment.sampleSize} so far)`
      : "ACTIVE EXPERIMENT: none",
    ...facts.concludedExperiments.map(
      (e) => `CONCLUDED EXPERIMENT: ${e.variable} → ${e.variant}: ${e.result} (${e.readout})`,
    ),
    facts.patternLines.length ? `PATTERNS (market):\n${facts.patternLines.join("\n")}` : "",
    facts.stateSummary ? `STATE:\n${facts.stateSummary}` : "",
  ].filter(Boolean);

  return runAgent(
    "briefing_compose",
    "agentic",
    ctx,
    `compose ${facts.cadence} briefing for ${facts.channelName}`,
    async (model) => {
      const res = await generateObject({
        model,
        schema: briefingComposeSchema,
        system:
          "TASK:briefing — You write the operator check-in for an autonomous YouTube channel: " +
          "what happened this period, the direction you propose next, up to 3 concrete suggestions, " +
          "and one direct question for the operator. Suggestions are actionable steers; include at " +
          "most ONE kind='experiment' suggestion (a single-variable test with a hypothesis and a " +
          "one-line production directive) and ONLY if no experiment is currently active.",
        prompt: lines.join("\n"),
      });
      return { object: res.object, usage: res.usage };
    },
  );
}

/**
 * Narrate a concluded experiment. The verdict is computed deterministically
 * (evaluateExperimentOutcome) — the LLM only writes the story of what the
 * numbers mean for this channel.
 */
export async function narrateExperimentOutcome(
  ctx: AgentCtx,
  input: {
    variable: string;
    hypothesis: string;
    baseline: string;
    variant: string;
    evaluation: ExperimentEvaluation;
  },
): Promise<string> {
  const out = await runAgent(
    "experiment_conclude",
    "agentic",
    ctx,
    `conclude experiment: ${input.variable}`,
    async (model) => {
      const res = await generateObject({
        model,
        schema: experimentConcludeSchema,
        system:
          "TASK:experiment-conclude — Summarize a concluded one-variable experiment for the " +
          "channel's decision ledger: what was tested, what the numbers showed, and what to do next. " +
          "The verdict is already decided — do not contradict it.",
        prompt: [
          `VARIABLE: ${input.variable}`,
          `HYPOTHESIS: ${input.hypothesis}`,
          `BASELINE: ${input.baseline}`,
          `VARIANT: ${input.variant}`,
          `VERDICT: ${input.evaluation.result}`,
          `READOUT: ${input.evaluation.readout}`,
        ].join("\n"),
      });
      return { object: res.object, usage: res.usage };
    },
  );
  return out.outcome;
}
