import { describe, expect, it } from "vitest";
import { imageSourceKind, regenShotMode } from "../src/shot-regen";

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
