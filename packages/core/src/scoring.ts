import type { Rubric } from "@ytauto/db";

/**
 * Rubric weights (sum to 1). Per-channel overrides can be layered in later —
 * the scorer takes weights as an argument.
 */
export const DEFAULT_SCORING_WEIGHTS: Record<keyof Rubric, number> = {
  demand: 0.2,
  saturation: 0.15,
  ghostNiche: 0.15,
  rpmPotential: 0.1,
  feasibilityCost: 0.1,
  complianceRisk: 0.15,
  dnaFit: 0.15,
};

export function weightedTotal(
  rubric: Rubric,
  weights: Record<keyof Rubric, number> = DEFAULT_SCORING_WEIGHTS,
): number {
  let total = 0;
  for (const key of Object.keys(weights) as (keyof Rubric)[]) {
    total += rubric[key].score * weights[key];
  }
  return Math.round(total * 100) / 100;
}
