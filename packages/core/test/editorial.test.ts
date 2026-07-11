import { describe, expect, it } from "vitest";
import { DEFAULT_MIN_FACTS_TO_SCRIPT, decideClaimStatus, minFactsToScript } from "../src/editorial";

const bar = { establishedMinSources: 2 };

describe("decideClaimStatus (tiered accuracy)", () => {
  it("verifies an established claim with >= 2 independent domains", () => {
    expect(decideClaimStatus("established", 2, bar)).toBe("verified");
    expect(decideClaimStatus("established", 3, bar)).toBe("verified");
  });

  it("cuts an established claim with fewer than the bar", () => {
    expect(decideClaimStatus("established", 1, bar)).toBe("cut");
    expect(decideClaimStatus("established", 0, bar)).toBe("cut");
  });

  it("respects a stricter per-channel bar", () => {
    expect(decideClaimStatus("established", 2, { establishedMinSources: 3 })).toBe("cut");
    expect(decideClaimStatus("established", 3, { establishedMinSources: 3 })).toBe("verified");
  });

  it("never allows a zero bar to auto-verify", () => {
    expect(decideClaimStatus("established", 0, { establishedMinSources: 0 })).toBe("cut");
    expect(decideClaimStatus("established", 1, { establishedMinSources: 0 })).toBe("verified");
  });

  it("attributes emerging/contested claims with >= 1 source, cuts with none", () => {
    expect(decideClaimStatus("emerging", 1, bar)).toBe("attributed");
    expect(decideClaimStatus("contested", 2, bar)).toBe("attributed");
    expect(decideClaimStatus("emerging", 0, bar)).toBe("cut");
    expect(decideClaimStatus("contested", 0, bar)).toBe("cut");
  });
});

describe("minFactsToScript (facts-gate bar)", () => {
  it("uses the per-channel value when set", () => {
    expect(minFactsToScript({ minFactsToScript: 6 })).toBe(6);
    expect(minFactsToScript({ minFactsToScript: 1 })).toBe(1);
  });

  it("falls back to the default for legacy/absent bars", () => {
    expect(minFactsToScript(undefined)).toBe(DEFAULT_MIN_FACTS_TO_SCRIPT);
    expect(minFactsToScript(null)).toBe(DEFAULT_MIN_FACTS_TO_SCRIPT);
    expect(minFactsToScript({})).toBe(DEFAULT_MIN_FACTS_TO_SCRIPT);
    // a nonsensical value (0 / negative) never lowers the floor below the default
    expect(minFactsToScript({ minFactsToScript: 0 })).toBe(DEFAULT_MIN_FACTS_TO_SCRIPT);
  });

  it("floors fractional values", () => {
    expect(minFactsToScript({ minFactsToScript: 4.9 })).toBe(4);
  });
});

describe("factuality modes (BACKLOG #21.3)", () => {
  const balanced = { establishedMinSources: 1, factualityMode: "balanced" as const };
  const fun = { establishedMinSources: 1, factualityMode: "entertainment" as const };
  const strict = { establishedMinSources: 1, factualityMode: "strict" as const };

  it("resolves legacy bars: deep rigor → strict, everything else → balanced", async () => {
    const { resolveFactualityMode } = await import("../src/editorial");
    expect(resolveFactualityMode({ establishedMinSources: 2 })).toBe("strict");
    expect(resolveFactualityMode({ establishedMinSources: 1 })).toBe("balanced");
    expect(resolveFactualityMode(null)).toBe("balanced");
    expect(resolveFactualityMode({ establishedMinSources: 2, factualityMode: "entertainment" })).toBe(
      "entertainment",
    );
  });

  it("strict keeps the binary behavior", () => {
    expect(decideClaimStatus("emerging", 0, strict)).toBe("cut");
    expect(decideClaimStatus("established", 0, strict)).toBe("cut");
  });

  it("balanced turns uncorroborated emerging/contested claims into conjecture, not cut", () => {
    expect(decideClaimStatus("emerging", 0, balanced)).toBe("conjecture");
    expect(decideClaimStatus("contested", 0, balanced)).toBe("conjecture");
    expect(decideClaimStatus("emerging", 1, balanced)).toBe("attributed");
  });

  it("balanced degrades an under-bar established claim to attributed instead of cutting", () => {
    const deepBalanced = { establishedMinSources: 2, factualityMode: "balanced" as const };
    expect(decideClaimStatus("established", 1, deepBalanced)).toBe("attributed");
    expect(decideClaimStatus("established", 0, deepBalanced)).toBe("cut");
  });

  it("entertainment never cuts for lack of corroboration", () => {
    expect(decideClaimStatus("established", 0, fun)).toBe("conjecture");
    expect(decideClaimStatus("emerging", 0, fun)).toBe("conjecture");
    expect(decideClaimStatus("established", 1, fun)).toBe("verified");
  });

  it("facts gate: applies except in entertainment; conjecture counts outside strict", async () => {
    const { factsGateApplies, countsTowardFactsGate } = await import("../src/editorial");
    expect(factsGateApplies("strict")).toBe(true);
    expect(factsGateApplies("balanced")).toBe(true);
    expect(factsGateApplies("entertainment")).toBe(false);
    expect(countsTowardFactsGate("conjecture", "balanced")).toBe(true);
    expect(countsTowardFactsGate("conjecture", "strict")).toBe(false);
    expect(countsTowardFactsGate("verified", "strict")).toBe(true);
    expect(countsTowardFactsGate("cut", "balanced")).toBe(false);
  });
});
