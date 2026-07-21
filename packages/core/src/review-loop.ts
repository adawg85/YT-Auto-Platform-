/**
 * Reusable agent-to-agent review-loop controls (ticket 01KY1YCQ…). Any
 * "produce → review → revise → re-review" loop can run forever — oscillating,
 * never converging, or grinding on an unsatisfiable block — and the cost only
 * surfaces on the bill. This wrapper bounds ANY such loop: a hard round cap, a
 * strict-convergence requirement, oscillation detection (structural, not string
 * equality), a cost ceiling, and unsatisfiable-block escape. It keeps the BEST
 * revision (fewest blocking findings), not the most recent, and returns the full
 * exchange so the caller can log why it stopped.
 *
 * Pure orchestration: the caller supplies `review`, `revise`, and a structural
 * `fingerprint`; this module owns only the termination logic (which is what's
 * hard to get right and easy to test).
 */

export type LoopRound<TState, TFinding> = {
  round: number;
  state: TState;
  blockingFindings: TFinding[];
  advisoryFindings: TFinding[];
  costUsd: number;
};

export type LoopTermination =
  | "passed" // no blocking findings — clean pass
  | "cap" // hit the max round count
  | "non_convergence" // blocking count didn't strictly decrease
  | "oscillation" // a round structurally resembles one two rounds back
  | "unsatisfiable" // the same blocking finding survived two revisions
  | "cost"; // hit the spend ceiling

export type LoopResult<TState, TFinding> = {
  termination: LoopTermination;
  passed: boolean;
  /** the round with the fewest blocking findings (ties → earliest) */
  best: LoopRound<TState, TFinding>;
  rounds: LoopRound<TState, TFinding>[];
  totalCostUsd: number;
  /** human-readable reason, for failureReason / get_diagnostics */
  reason: string;
};

export type LoopConfig<TState, TFinding> = {
  /** hard iteration cap (default 3; configurable, never hardcoded downstream) */
  maxRounds?: number;
  /** optional hard spend cap across the whole loop */
  costCeilingUsd?: number;
  /** structural fingerprint of a state — MUST ignore surface text, capture shape */
  fingerprint: (state: TState) => string;
  /** stable key for a finding, so "the same finding survived" is detectable */
  findingKey: (finding: TFinding) => string;
  /** run the reviewer on a state → findings + the cost of doing so */
  review: (state: TState, round: number) => Promise<{
    blockingFindings: TFinding[];
    advisoryFindings: TFinding[];
    costUsd?: number;
  }>;
  /** revise a state given its blocking findings → the next state + cost */
  revise: (state: TState, blocking: TFinding[], round: number) => Promise<{ state: TState; costUsd?: number }>;
};

function pickBest<TState, TFinding>(rounds: LoopRound<TState, TFinding>[]): LoopRound<TState, TFinding> {
  return rounds.reduce((best, r) => (r.blockingFindings.length < best.blockingFindings.length ? r : best), rounds[0]!);
}

const REASONS: Record<LoopTermination, string> = {
  passed: "Passed review — no blocking findings.",
  cap: "Hit the review round cap without passing.",
  non_convergence: "Blocking findings stopped decreasing — motion without progress.",
  oscillation: "The revision loop is oscillating between structures.",
  unsatisfiable: "A blocking finding survived repeated revision — likely unsatisfiable for this topic.",
  cost: "Hit the review-loop spend ceiling.",
};

/**
 * Drive a bounded review loop. Returns as soon as a round passes, or when any
 * control fires — never spinning past the guarantees above.
 */
export async function runReviewLoop<TState, TFinding>(
  initial: TState,
  config: LoopConfig<TState, TFinding>,
): Promise<LoopResult<TState, TFinding>> {
  const maxRounds = Math.max(1, config.maxRounds ?? 3);
  const rounds: LoopRound<TState, TFinding>[] = [];
  const fingerprints: string[] = [];
  let state = initial;
  let totalCost = 0;

  const finish = (termination: LoopTermination): LoopResult<TState, TFinding> => ({
    termination,
    passed: termination === "passed",
    best: pickBest(rounds),
    rounds,
    totalCostUsd: totalCost,
    reason: REASONS[termination],
  });

  for (let round = 1; round <= maxRounds; round++) {
    const rev = await config.review(state, round);
    const cost = rev.costUsd ?? 0;
    totalCost += cost;
    const current: LoopRound<TState, TFinding> = {
      round,
      state,
      blockingFindings: rev.blockingFindings,
      advisoryFindings: rev.advisoryFindings,
      costUsd: cost,
    };
    rounds.push(current);
    fingerprints.push(config.fingerprint(state));

    // Clean pass.
    if (current.blockingFindings.length === 0) return finish("passed");

    // Cost ceiling (checked after logging the round so it's visible).
    if (config.costCeilingUsd != null && totalCost >= config.costCeilingUsd) return finish("cost");

    // Convergence: from round 2 on, blocking must STRICTLY decrease.
    if (rounds.length >= 2) {
      const prev = rounds[rounds.length - 2]!;
      if (current.blockingFindings.length >= prev.blockingFindings.length) return finish("non_convergence");
    }

    // Unsatisfiable: the same blocking finding survived TWO consecutive
    // revisions → present in three consecutive rounds. Escalate rather than grind.
    if (rounds.length >= 3) {
      const k = (r: LoopRound<TState, TFinding>) => new Set(r.blockingFindings.map(config.findingKey));
      const a = k(rounds[rounds.length - 1]!);
      const b = k(rounds[rounds.length - 2]!);
      const c = k(rounds[rounds.length - 3]!);
      if ([...a].some((key) => b.has(key) && c.has(key))) return finish("unsatisfiable");
    }

    // Oscillation: this state structurally matches one from two rounds back.
    const fp = fingerprints[fingerprints.length - 1]!;
    if (fingerprints.length >= 3 && fingerprints[fingerprints.length - 3] === fp) return finish("oscillation");

    // Last allowed round — don't revise past the cap.
    if (round === maxRounds) return finish("cap");

    // Revise for the next round.
    const revised = await config.revise(state, current.blockingFindings, round);
    totalCost += revised.costUsd ?? 0;
    state = revised.state;
  }

  return finish("cap");
}
