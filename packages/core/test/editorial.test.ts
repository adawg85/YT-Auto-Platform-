import { describe, expect, it } from "vitest";
import { decideClaimStatus } from "../src/editorial";

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
