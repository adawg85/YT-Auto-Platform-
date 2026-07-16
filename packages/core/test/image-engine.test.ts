import { describe, expect, it } from "vitest";
import { imageEngineFor, imageEngineForRole, imageEnginePreference } from "../src/production-profile";

describe("imageEngineFor (fal retired 2026-07-14)", () => {
  it("never returns fal — default is Qwen bulk with hero pinned to nano", () => {
    expect(imageEngineFor({}, "standard")).toBe("qwen");
    expect(imageEngineFor({})).toBe("qwen");
    expect(imageEngineFor({}, "hero")).toBe("nano-banana");
  });

  it("legacy stored fal/mixed values (from DB jsonb) resolve to the qwen default", () => {
    // fal removed 2026-07-16 — old rows may still hold "fal"/"mixed" strings
    const legacy = (v: string) => ({ imageEngine: v }) as unknown as Parameters<typeof imageEngineFor>[0];
    expect(imageEngineFor(legacy("fal"), "standard")).toBe("qwen");
    expect(imageEngineFor(legacy("fal"), "hero")).toBe("nano-banana");
    expect(imageEngineFor(legacy("mixed"), "standard")).toBe("qwen");
    expect(imageEngineFor(legacy("mixed"), "hero")).toBe("nano-banana");
  });

  it("nano-banana → everything Google-direct", () => {
    expect(imageEngineFor({ imageEngine: "nano-banana" }, "standard")).toBe("nano-banana");
    expect(imageEngineFor({ imageEngine: "nano-banana" }, "hero")).toBe("nano-banana");
  });

  it("qwen → Qwen bulk, hero stays pinned to nano", () => {
    expect(imageEngineFor({ imageEngine: "qwen" }, "standard")).toBe("qwen");
    expect(imageEngineFor({ imageEngine: "qwen" }, "hero")).toBe("nano-banana");
  });

  it("seedream → Seedream bulk, hero stays pinned to nano", () => {
    expect(imageEngineFor({ imageEngine: "seedream" }, "standard")).toBe("seedream");
    expect(imageEngineFor({ imageEngine: "seedream" })).toBe("seedream");
    expect(imageEngineFor({ imageEngine: "seedream" }, "hero")).toBe("nano-banana");
  });
});

describe("imageEngineForRole (per-role, 2026-07-16)", () => {
  it("defaults preserve prior behaviour: bulk→qwen, hero/character/thumbnail→nano", () => {
    expect(imageEngineForRole({}, "bulk")).toBe("qwen");
    expect(imageEngineForRole({}, "hero")).toBe("nano-banana");
    expect(imageEngineForRole({}, "character")).toBe("nano-banana");
    expect(imageEngineForRole({}, "thumbnail")).toBe("nano-banana");
  });

  it("bulk follows imageEngine", () => {
    expect(imageEngineForRole({ imageEngine: "seedream" }, "bulk")).toBe("seedream");
    expect(imageEngineForRole({ imageEngine: "nano-banana" }, "bulk")).toBe("nano-banana");
  });

  it("each role can be routed independently", () => {
    const p = {
      imageEngine: "qwen" as const,
      heroImageEngine: "seedream" as const,
      characterImageEngine: "nano-banana" as const,
      thumbnailImageEngine: "seedream" as const,
    };
    expect(imageEngineForRole(p, "bulk")).toBe("qwen");
    expect(imageEngineForRole(p, "hero")).toBe("seedream");
    expect(imageEngineForRole(p, "character")).toBe("nano-banana");
    expect(imageEngineForRole(p, "thumbnail")).toBe("seedream");
  });

  it("character can be moved off Nano to a cheaper engine", () => {
    expect(imageEngineForRole({ characterImageEngine: "qwen" }, "character")).toBe("qwen");
  });
});

describe("imageEnginePreference — fallback follows the Style tab (2026-07-16)", () => {
  it("a failed hero degrades to the operator's seedream bulk, NEVER a hardcoded qwen", () => {
    // Operator: bulk=seedream, hero=nano (default). The old factory degraded a
    // failed nano hero to qwen (hardcoded order) — the reported bug. Now the
    // preference lists only Style-tab engines: nano first, seedream next.
    const p = { imageEngine: "seedream" as const };
    const pref = imageEnginePreference(p, "hero");
    expect(pref[0]).toBe("nano-banana"); // the role's own engine = the primary
    expect(pref).toContain("seedream"); // its bulk engine is the fallback
    expect(pref).not.toContain("qwen"); // the operator never chose qwn → never used
  });

  it("is deduped and primary-first for every role", () => {
    const p = {
      imageEngine: "qwen" as const,
      heroImageEngine: "seedream" as const,
      characterImageEngine: "nano-banana" as const,
      thumbnailImageEngine: "seedream" as const,
    };
    // hero primary = seedream (heroImageEngine); rest of the configured set follows
    const hero = imageEnginePreference(p, "hero");
    expect(hero[0]).toBe("seedream");
    expect(new Set(hero).size).toBe(hero.length); // no duplicates
    expect([...hero].sort()).toEqual(["nano-banana", "qwen", "seedream"]); // all three chosen
    // bulk primary = qwen
    expect(imageEnginePreference(p, "bulk")[0]).toBe("qwen");
  });

  it("collapses to a single engine when the whole Style tab uses one", () => {
    const p = {
      imageEngine: "nano-banana" as const,
      heroImageEngine: "nano-banana" as const,
      characterImageEngine: "nano-banana" as const,
      thumbnailImageEngine: "nano-banana" as const,
    };
    expect(imageEnginePreference(p, "hero")).toEqual(["nano-banana"]);
  });
});
