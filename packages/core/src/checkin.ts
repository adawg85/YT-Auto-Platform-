/**
 * Operator check-ins + controlled experimentation (build #5.2).
 * Pure logic only: cadence math, briefing/experiment agent schemas, and the
 * deterministic experiment evaluator. The briefing composer agent lives in
 * @ytauto/agents; the cron lives in apps/worker (operator-briefing).
 */
import { z } from "zod";

// ── Check-in cadence ─────────────────────────────────────────────────────

export type CheckinCadence = "weekly" | "monthly";

export const CADENCE_DAYS: Record<CheckinCadence, number> = {
  weekly: 7,
  monthly: 28,
};

/** charters store free text; anything unrecognized falls back to weekly */
export function normalizeCadence(raw: string | null | undefined): CheckinCadence {
  return raw === "monthly" ? "monthly" : "weekly";
}

/** A briefing is due when none was ever sent, or the cadence window elapsed. */
export function briefingDue(
  cadence: string | null | undefined,
  lastBriefingAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (!lastBriefingAt) return true;
  const days = CADENCE_DAYS[normalizeCadence(cadence)];
  return now.getTime() - lastBriefingAt.getTime() >= days * 86_400_000;
}

// ── Briefing composer schema (TASK:briefing) ─────────────────────────────

export const briefingSuggestionSchema = z.object({
  kind: z.enum(["steer", "experiment"]),
  label: z.string(),
  detail: z.string(),
  /** present only when kind = "experiment" — the ONE variable under test */
  experiment: z
    .object({
      variable: z.string(),
      hypothesis: z.string(),
      baseline: z.string(),
      variant: z.string(),
      directive: z.string(),
    })
    .optional(),
});

export const briefingComposeSchema = z.object({
  whatHappened: z.string(),
  direction: z.string(),
  question: z.string(),
  suggestions: z.array(briefingSuggestionSchema).max(3),
});
export type BriefingCompose = z.infer<typeof briefingComposeSchema>;

// ── Experiment evaluation ────────────────────────────────────────────────

export const experimentConcludeSchema = z.object({
  outcome: z.string(),
});
export type ExperimentConclude = z.infer<typeof experimentConcludeSchema>;

export type ExperimentMetrics = {
  /** mean avg-%-viewed across the cohort's analytics snapshots */
  avgPctViewed: number | null;
  /** mean views across the cohort */
  avgViews: number | null;
  sampleSize: number;
};

export type ExperimentEvaluation = {
  result: "win" | "loss" | "inconclusive";
  /** relative delta on the metric that decided it, e.g. +0.14 = +14% */
  deltaPct: number | null;
  metric: "avgPctViewed" | "avgViews" | null;
  readout: string;
};

const WIN_THRESHOLD = 0.1;

/**
 * Deterministic experiment verdict — the LLM narrates, it never decides.
 * Retention (avg % viewed) is the primary metric; views are the fallback.
 * Win/loss needs a ≥10% relative move AND a full sample on both sides.
 */
export function evaluateExperimentOutcome(input: {
  baseline: ExperimentMetrics;
  variant: ExperimentMetrics;
  minSample?: number;
}): ExperimentEvaluation {
  const minSample = input.minSample ?? 3;
  if (input.variant.sampleSize < minSample || input.baseline.sampleSize < 1) {
    return {
      result: "inconclusive",
      deltaPct: null,
      metric: null,
      readout: `insufficient sample (variant ${input.variant.sampleSize}/${minSample}, baseline ${input.baseline.sampleSize})`,
    };
  }

  const pick = (m: ExperimentMetrics) =>
    m.avgPctViewed != null && m.avgPctViewed > 0
      ? { metric: "avgPctViewed" as const, value: m.avgPctViewed }
      : m.avgViews != null && m.avgViews > 0
        ? { metric: "avgViews" as const, value: m.avgViews }
        : null;

  const base = pick(input.baseline);
  const vari = pick(input.variant);
  if (!base || !vari || base.metric !== vari.metric) {
    return {
      result: "inconclusive",
      deltaPct: null,
      metric: null,
      readout: "no comparable metric on both cohorts",
    };
  }

  const delta = (vari.value - base.value) / base.value;
  const result = delta >= WIN_THRESHOLD ? "win" : delta <= -WIN_THRESHOLD ? "loss" : "inconclusive";
  const pct = (delta * 100).toFixed(1);
  return {
    result,
    deltaPct: delta,
    metric: base.metric,
    readout: `${base.metric} moved ${delta >= 0 ? "+" : ""}${pct}% vs baseline (${vari.value.toFixed(1)} vs ${base.value.toFixed(1)}, n=${input.variant.sampleSize})`,
  };
}
