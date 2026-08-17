import { describe, it, expect } from "vitest";
import {
  isBlankPrompt,
  isPlaceholderImage,
  narrationScenePrompt,
  placeholderShotIndexes,
  resolveShotPrompt,
} from "../src/shot-prompt";
import { projectShotPlan } from "../src/shot-projection";
import { resolveProductionProfile } from "../src/production-profile";

describe("#122 empty image prompt never reaches the engine", () => {
  it("keeps the shot's own prompt when it has one", () => {
    const r = resolveShotPrompt({
      prompt: "A rusted bomber fuselage half-buried in mangrove silt, low sun.",
      beatImagePrompt: "beat level",
      narration: "No wreckage from that day has ever been found.",
    });
    expect(r.source).toBe("shot");
    expect(r.prompt).toContain("rusted bomber");
  });

  it("falls back to the beat's singular imagePrompt first", () => {
    const r = resolveShotPrompt({
      prompt: "   ",
      beatImagePrompt: "Empty grey Atlantic seen from a search plane's window.",
      beatImagePrompts: ["sibling a", "sibling b"],
      shotOrdinal: 2,
      narration: "No wreckage from that day has ever been found.",
    });
    expect(r.source).toBe("beat_prompt");
    expect(r.prompt).toBe("Empty grey Atlantic seen from a search plane's window.");
  });

  it("borrows the NEAREST sibling of the beat's imagePrompts[] — the reported shape", () => {
    // a beat authored with imagePrompts:["a","b"] and an EMPTY singular
    // imagePrompt, cut into 3 shots: shot 2 has nothing of its own
    const r = resolveShotPrompt({
      prompt: "",
      beatImagePrompt: "",
      beatImagePrompts: ["prompt a", "prompt b"],
      shotOrdinal: 2,
      narration: "No wreckage from that day has ever been found.",
    });
    expect(r.source).toBe("sibling_prompt");
    expect(r.prompt).toBe("prompt b"); // idx 1 is nearer to ordinal 2 than idx 0
  });

  it("never borrows the shot's OWN (blank) slot back", () => {
    const r = resolveShotPrompt({
      prompt: "",
      beatImagePrompts: [null, "only usable one"],
      shotOrdinal: 1,
      narration: "line",
      visualBrief: "a brief",
    });
    // its own slot (1) is excluded even though it holds text, so this falls to the brief
    expect(r.source).toBe("visual_brief");
    expect(r.prompt).toBe("a brief");
  });

  it("falls back to the visualBrief before the narration derivation", () => {
    const r = resolveShotPrompt({
      prompt: "",
      beatImagePrompts: [],
      visualBrief: "A wall of missing-aircraft posters in a naval archive.",
      narration: "No wreckage from that day has ever been found.",
    });
    expect(r.source).toBe("visual_brief");
  });

  it("last resort: derives a scene prompt from the narration, never an empty string", () => {
    const r = resolveShotPrompt({
      prompt: "",
      beatImagePrompt: "",
      beatImagePrompts: null,
      visualBrief: null,
      narration: "No wreckage from that day has ever been found.",
      styleRegister: "Style: muted 1950s archival grade.",
    });
    expect(r.source).toBe("narration");
    expect(isBlankPrompt(r.prompt)).toBe(false);
    expect(r.prompt).toContain("No wreckage from that day has ever been found");
    expect(r.prompt).toContain("muted 1950s archival grade");
    // the register is not double-labelled when it already reads "Style: …"
    expect(r.prompt).not.toContain("Style: Style:");
  });

  it("derives something usable even when the narration is empty too", () => {
    const r = resolveShotPrompt({ prompt: "", narration: "   " });
    expect(r.source).toBe("narration");
    expect(isBlankPrompt(r.prompt)).toBe(false);
  });

  it("leads the derivation with a referenceEntity when the shot names one", () => {
    const p = narrationScenePrompt({
      narration: "The rescue plane vanished the same night.",
      referenceEntity: "Martin PBM Mariner",
    });
    expect(p.startsWith("Martin PBM Mariner.")).toBe(true);
  });
});

describe("#122 placeholder detection", () => {
  it("flags the provider's placeholder stamp", () => {
    expect(isPlaceholderImage({ placeholder: true }, "productions/p/beat-7.png")).toBe(true);
  });

  it("flags engineServed mock-media", () => {
    expect(isPlaceholderImage({ engineRequested: "seedream", engineServed: "mock-media" })).toBe(true);
  });

  it("flags a .svg shot image — the only tell on shots generated before the stamp", () => {
    expect(isPlaceholderImage({ engineRequested: "seedream" }, "productions/p/beat-7.svg")).toBe(true);
  });

  it("does NOT flag a real generated or sourced shot", () => {
    expect(isPlaceholderImage({ engineRequested: "seedream", engineServed: "seedream" }, "a/beat-3.png")).toBe(false);
    expect(isPlaceholderImage({ source: "https://commons.example/x" }, "a/ref-3.jpg")).toBe(false);
    expect(isPlaceholderImage(null, null)).toBe(false);
  });

  it("lists placeholder shot indexes in ascending order", () => {
    expect(
      placeholderShotIndexes([
        { idx: 23, meta: { engineServed: "mock-media" } },
        { idx: 4, meta: { engineServed: "seedream" }, storageKey: "a/beat-4.png" },
        { idx: 7, meta: {}, storageKey: "a/beat-7.svg" },
      ]),
    ).toEqual([7, 23]);
  });
});

describe("#122 authoring-time warning", () => {
  const profile = resolveProductionProfile({ rhythm: "sentence", imageDensity: "busy", motion: "static" });
  const beat = (over: Record<string, unknown>) => ({
    type: "insight" as const,
    text: "One sentence about the wreck. A second sentence about the search. A third about the silence.",
    imagePrompt: "",
    ...over,
  });

  it("names a beat that supplies imagePrompts[] but leaves the singular imagePrompt EMPTY", () => {
    const p = projectShotPlan([beat({ imagePrompts: ["a", "b"] })], profile, { isLong: false });
    const note = p.notes.find((n) => n.includes("leaves the singular imagePrompt EMPTY"));
    expect(note).toBeDefined();
    expect(p.perBeat[0]!.singularPromptEmpty).toBe(true);
  });

  it("keeps the old duplicate-image wording when the singular prompt HAS content", () => {
    const p = projectShotPlan([beat({ imagePrompt: "a fallback scene", imagePrompts: ["a", "b"] })], profile, {
      isLong: false,
    });
    expect(p.notes.some((n) => n.includes("leaves the singular imagePrompt EMPTY"))).toBe(false);
    expect(p.notes.some((n) => n.includes("render near-identical images"))).toBe(true);
    expect(p.perBeat[0]!.singularPromptEmpty).toBe(false);
  });

  it("names beats with NO visual direction at all", () => {
    const p = projectShotPlan([beat({})], profile, { isLong: false });
    expect(p.notes.some((n) => n.includes("NO visual direction at all"))).toBe(true);
  });

  it("stays quiet when every beat is fully directed", () => {
    const p = projectShotPlan([beat({ imagePrompt: "a scene", visualBrief: "a brief" })], profile, { isLong: false });
    expect(p.notes.some((n) => n.includes("NO visual direction at all"))).toBe(false);
    expect(p.notes.some((n) => n.includes("leaves the singular imagePrompt EMPTY"))).toBe(false);
  });
});
