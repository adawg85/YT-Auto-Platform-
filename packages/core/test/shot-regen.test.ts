import { describe, expect, it } from "vitest";
import {
  duplicateRiskGroups,
  imageSourceKind,
  outstandingDuplicateShotCount,
  regenShotMode,
} from "../src/shot-regen";

describe("regenShotMode (ticket 01KY5W4T… / #38)", () => {
  it("a referenceEntity → re-source real footage", () => {
    expect(regenShotMode({ referenceEntity: "Bell X-1" })).toBe("real");
    expect(regenShotMode({ referenceEntity: "Bell X-1", heroShot: true })).toBe("real");
  });
  it("no entity → regenerate the still (hero engine for a hero shot, else standard)", () => {
    expect(regenShotMode({ heroShot: true })).toBe("hero");
    expect(regenShotMode({})).toBe("standard");
    expect(regenShotMode({ referenceEntity: "  " })).toBe("standard"); // blank entity ignored
  });
});

describe("imageSourceKind", () => {
  it("meta.source present → sourced; else generated", () => {
    expect(imageSourceKind({ source: "wikimedia:File:X.jpg" })).toBe("sourced");
    expect(imageSourceKind({ prompt: "a cinematic wide shot" })).toBe("generated");
    expect(imageSourceKind(null)).toBe("generated");
    expect(imageSourceKind({ source: "" })).toBe("generated");
  });
});

describe("duplicateRiskGroups (ticket 01KY6DCD… — shots sharing a referenceEntity)", () => {
  it("groups entities used by ≥2 shots, largest-first, and counts them", () => {
    const shots = [
      { idx: 0, entity: "SR-71" },
      { idx: 1, entity: "J58 engine" },
      { idx: 2, entity: "SR-71" },
      { idx: 3, entity: "J58 engine" },
      { idx: 4, entity: "J58 engine" },
      { idx: 5, entity: "one-off subject" }, // singleton — not a risk
      { idx: 6, entity: null }, // no entity — ignored
    ];
    const groups = duplicateRiskGroups(shots);
    expect(groups).toEqual([
      { entity: "J58 engine", idxs: [1, 3, 4] },
      { entity: "SR-71", idxs: [0, 2] },
    ]);
    expect(outstandingDuplicateShotCount(groups)).toBe(5); // 3 + 2
  });

  it("no shared entities → empty, zero count", () => {
    const groups = duplicateRiskGroups([
      { idx: 0, entity: "A" },
      { idx: 1, entity: "B" },
      { idx: 2, entity: null },
    ]);
    expect(groups).toEqual([]);
    expect(outstandingDuplicateShotCount(groups)).toBe(0);
  });

  it("treats blank/whitespace entities as no entity", () => {
    const groups = duplicateRiskGroups([
      { idx: 0, entity: "  " },
      { idx: 1, entity: "" },
    ]);
    expect(groups).toEqual([]);
  });
});
