import { describe, expect, it } from "vitest";
import { runReviewLoop } from "../src/review-loop";

// A finding is just a string key here; state is a "structure" string.
const cfg = (over: Partial<Parameters<typeof runReviewLoop>[1]> = {}) => ({
  fingerprint: (s: unknown) => String(s),
  findingKey: (f: unknown) => String(f),
  ...over,
});

describe("runReviewLoop termination controls (ticket 01KY1YCQ…)", () => {
  it("passes immediately when the first review has no blocking findings", async () => {
    const res = await runReviewLoop("v1", cfg({
      review: async () => ({ blockingFindings: [], advisoryFindings: ["nit"] }),
      revise: async (s) => ({ state: s }),
    }) as never);
    expect(res.termination).toBe("passed");
    expect(res.passed).toBe(true);
    expect(res.rounds).toHaveLength(1);
  });

  it("converges: blocking findings strictly decrease then pass", async () => {
    let round = 0;
    const res = await runReviewLoop("v0", cfg({
      review: async () => {
        round++;
        const blocking = round === 1 ? ["a", "b"] : round === 2 ? ["a"] : [];
        return { blockingFindings: blocking, advisoryFindings: [] };
      },
      revise: async (_s: unknown, _b: unknown, r: number) => ({ state: `v${r}` }),
    }) as never);
    expect(res.termination).toBe("passed");
    expect(res.rounds.length).toBe(3);
  });

  it("terminates on NON-CONVERGENCE when blocking count doesn't drop", async () => {
    const res = await runReviewLoop("v0", cfg({
      review: async () => ({ blockingFindings: ["a", "b"], advisoryFindings: [] }), // never shrinks
      revise: async (_s: unknown, _b: unknown, r: number) => ({ state: `v${r}` }),
    }) as never);
    expect(res.termination).toBe("non_convergence");
    expect(res.passed).toBe(false);
  });

  it("terminates on OSCILLATION when a structure repeats two rounds back", async () => {
    // Force strictly-decreasing counts so convergence doesn't fire first, but
    // the STRUCTURE flip-flops A → B → A.
    const states = ["A", "B", "A", "B"];
    let round = 0;
    const res = await runReviewLoop("A", cfg({
      review: async () => {
        round++;
        // 3,2,1… decreasing so convergence passes; structure set by revise
        const n = Math.max(1, 4 - round);
        return { blockingFindings: Array.from({ length: n }, (_, i) => `f${round}_${i}`), advisoryFindings: [] };
      },
      revise: async (_s: unknown, _b: unknown, r: number) => ({ state: states[r] ?? "A" }),
      maxRounds: 6,
    }) as never);
    expect(res.termination).toBe("oscillation");
  });

  it("terminates on UNSATISFIABLE when the same finding survives two revisions", async () => {
    let round = 0;
    const res = await runReviewLoop("v0", cfg({
      review: async () => {
        round++;
        // decreasing count, but 'stuck' persists across all rounds
        const extra = round === 1 ? ["x", "y"] : round === 2 ? ["x"] : [];
        return { blockingFindings: ["stuck", ...extra], advisoryFindings: [] };
      },
      revise: async (_s: unknown, _b: unknown, r: number) => ({ state: `v${r}` }),
      maxRounds: 6,
    }) as never);
    expect(res.termination).toBe("unsatisfiable");
  });

  it("terminates on the ROUND CAP", async () => {
    let round = 0;
    const res = await runReviewLoop("v0", cfg({
      review: async () => {
        round++;
        // strictly decreasing but never reaching zero within the cap
        return { blockingFindings: Array.from({ length: Math.max(1, 5 - round) }, (_, i) => `f${round}_${i}`), advisoryFindings: [] };
      },
      revise: async (_s: unknown, _b: unknown, r: number) => ({ state: `v${r}` }),
      maxRounds: 3,
    }) as never);
    expect(res.termination).toBe("cap");
    expect(res.rounds.length).toBe(3);
  });

  it("terminates on the COST ceiling and keeps the BEST (fewest-blocking) round", async () => {
    let round = 0;
    const res = await runReviewLoop("v0", cfg({
      review: async () => {
        round++;
        const n = round === 1 ? 3 : 1; // round 2 is the best
        return { blockingFindings: Array.from({ length: n }, (_, i) => `f${i}`), advisoryFindings: [], costUsd: 1 };
      },
      revise: async (_s: unknown, _b: unknown, r: number) => ({ state: `v${r}` }),
      costCeilingUsd: 2,
      maxRounds: 10,
    }) as never);
    expect(res.termination).toBe("cost");
    expect(res.best.blockingFindings.length).toBe(1); // kept round 2, not round 1
  });
});
