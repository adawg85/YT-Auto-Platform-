import { describe, expect, it } from "vitest";
import {
  continueStatusFor,
  invalidatedBy,
  isStaleAsset,
  PRODUCTION_STAGES,
  reopenImpact,
  stageOfAssetKind,
  statusForStage,
} from "../src/production-stages";

describe("invalidatedBy — the reopen cascade", () => {
  it("reopening the script reaches everything derived from it", () => {
    // the operator's own words: "if I go back to scripting, that opens everything"
    expect(invalidatedBy("script")).toEqual(["voiceover", "visuals", "render", "thumbnail"]);
  });

  it("reopening the voiceover DOES invalidate the visuals — timings drive the cut", () => {
    // the non-obvious edge: shots are cut from word timestamps, so new audio
    // re-cuts the shot plan and the existing stills no longer match their lines
    expect(invalidatedBy("voiceover")).toContain("visuals");
    expect(invalidatedBy("voiceover")).toContain("render");
  });

  it("but a voiceover redo KEEPS the script and the thumbnail", () => {
    const out = invalidatedBy("voiceover");
    expect(out).not.toContain("script");
    expect(out).not.toContain("thumbnail");
  });

  it("re-cutting the visuals must NOT throw away the chosen music bed", () => {
    // music is picked by mood, not derived from the picture — losing the
    // operator's track because they redrew a shot would be gratuitous
    expect(invalidatedBy("visuals")).toEqual(["render"]);
  });

  it("music invalidates only the render — the bed is baked into it", () => {
    expect(invalidatedBy("music")).toEqual(["render"]);
  });

  it("the terminal stages cascade to nothing", () => {
    expect(invalidatedBy("render")).toEqual([]);
    expect(invalidatedBy("thumbnail")).toEqual([]);
    expect(invalidatedBy("publish")).toEqual([]);
  });

  it("never invalidates a stage upstream of itself", () => {
    PRODUCTION_STAGES.forEach((stage, i) => {
      for (const hit of invalidatedBy(stage)) {
        expect(PRODUCTION_STAGES.indexOf(hit)).toBeGreaterThan(i);
      }
    });
  });

  it("terminates — no stage can invalidate itself into a loop", () => {
    for (const stage of PRODUCTION_STAGES) {
      expect(invalidatedBy(stage)).not.toContain(stage);
    }
  });
});

describe("reopenImpact — the warning the operator confirms against", () => {
  const EP2 = { voiceover: 1, images: 102, clips: 8, render: 1, thumbnails: 3, music: 1 };

  it("names exactly what a voiceover reopen destroys, and why", () => {
    const impact = reopenImpact("voiceover", EP2);
    expect(impact.warning).toContain("102 images");
    expect(impact.warning).toContain("8 motion clips");
    expect(impact.warning).toContain("the render");
    // the surprising edge is stated outright, not left to be inferred
    expect(impact.warning).toContain("word timestamps");
    expect(impact.warning).toContain("Nothing is deleted yet");
  });

  it("names what SURVIVES, not just what is lost", () => {
    const impact = reopenImpact("voiceover", EP2);
    expect(impact.keeps).toContain("the approved script");
    expect(impact.keeps).toContain("the chosen music bed");
    expect(impact.keeps).toContain("the thumbnail");
  });

  it("REOPENING visuals keeps the shots so you can refine them individually", () => {
    // "refine prompts for shots" — a reopen must not wipe the set you came to fix
    const impact = reopenImpact("visuals", EP2, "reopen");
    expect(impact.discards).not.toContain("102 images");
    expect(impact.discards).toContain("the render");
    expect(impact.keeps).toContain("every existing shot (refine them individually)");
    expect(impact.keeps).toContain("the voiceover");
    expect(impact.keeps).toContain("the chosen music bed");
  });

  it("CLEANING visuals throws the shots away and rebuilds", () => {
    // "clean visuals, remove visuals that exist" — the other half of the ask
    const impact = reopenImpact("visuals", EP2, "clean");
    expect(impact.discards).toContain("102 images");
    expect(impact.discards).toContain("8 motion clips");
    expect(impact.discards).toContain("the render");
    expect(impact.warning).toContain("Cleaning visuals");
    // still keeps what visuals never owned
    expect(impact.keeps).toContain("the voiceover");
    expect(impact.keeps).toContain("the chosen music bed");
  });

  it("a script reopen is the total one", () => {
    const impact = reopenImpact("script", EP2);
    expect(impact.staleStages).toEqual(["voiceover", "visuals", "render", "thumbnail"]);
    expect(impact.discards).toEqual([
      "the voiceover",
      "102 images",
      "8 motion clips",
      "the render",
      "3 thumbnails",
    ]);
    expect(impact.keeps).not.toContain("the approved script");
  });

  it("says so plainly when there is nothing to lose", () => {
    const impact = reopenImpact("thumbnail", EP2);
    expect(impact.discards).toEqual([]);
    expect(impact.warning).toContain("discards nothing");
  });

  it("is always reversible and says when the delete actually fires", () => {
    for (const stage of PRODUCTION_STAGES) {
      for (const mode of ["reopen", "clean"] as const) {
        const impact = reopenImpact(stage, EP2, mode);
        expect(impact.reversible).toBe(true);
        expect(impact.deletesWhen).toContain("produces new output");
      }
    }
  });

  it("clean is never gentler than reopen — it can only discard more", () => {
    for (const stage of PRODUCTION_STAGES) {
      const open = reopenImpact(stage, EP2, "reopen");
      const clean = reopenImpact(stage, EP2, "clean");
      for (const d of open.discards) expect(clean.discards).toContain(d);
      expect(clean.staleStages.length).toBeGreaterThanOrEqual(open.staleStages.length);
    }
  });

  it("counts singular artifacts without saying '1 images'", () => {
    expect(reopenImpact("visuals", { images: 1, clips: 1 }, "clean").discards).toEqual([
      "1 image",
      "1 motion clip",
    ]);
  });

  it("omits artifacts the production doesn't have", () => {
    const impact = reopenImpact("script", { voiceover: 1 });
    expect(impact.discards).toEqual(["the voiceover"]);
    expect(impact.warning).not.toContain("image");
  });
});

describe("staleness — an old asset must never look current", () => {
  it("a CLEAN of visuals stales the shots themselves; a REOPEN does not", () => {
    expect(isStaleAsset("image", "visuals", "clean")).toBe(true);
    expect(isStaleAsset("image", "visuals", "reopen")).toBe(false);
    // either way the render below it is stale
    expect(isStaleAsset("render", "visuals", "reopen")).toBe(true);
  });

  it("marks the assets of invalidated stages stale, and only those", () => {
    // reopened at voiceover: shots are stale, the render is stale
    expect(isStaleAsset("image", "voiceover")).toBe(true);
    expect(isStaleAsset("video_clip", "voiceover")).toBe(true);
    expect(isStaleAsset("render", "voiceover")).toBe(true);
    // the voiceover asset itself belongs to the reopened stage, not its cascade
    expect(isStaleAsset("voiceover", "voiceover")).toBe(false);
  });

  it("marks nothing when no reopen is in flight", () => {
    for (const kind of ["image", "video_clip", "render", "voiceover"]) {
      expect(isStaleAsset(kind, null)).toBe(false);
      expect(isStaleAsset(kind, undefined)).toBe(false);
      expect(isStaleAsset(kind, "")).toBe(false);
    }
  });

  it("ignores an unknown stage rather than staling everything", () => {
    expect(isStaleAsset("image", "not_a_stage")).toBe(false);
  });

  it("maps asset kinds to their owning stage", () => {
    expect(stageOfAssetKind("image")).toBe("visuals");
    expect(stageOfAssetKind("video_clip")).toBe("visuals");
    expect(stageOfAssetKind("render")).toBe("render");
    expect(stageOfAssetKind("voiceover")).toBe("voiceover");
    expect(stageOfAssetKind("something_else")).toBeNull();
  });
});

describe("continueStatusFor — resume where the work is, never upstream of it", () => {
  it("a fully built production continues at assembling", () => {
    expect(continueStatusFor({ render: 1, images: 102, voiceover: 1, script: true })).toBe("assembling");
  });

  it("102 images and no render continues at producing_assets — NOT greenlit", () => {
    // this is #98's lesson carried into Continue: a built, human-approved
    // production must never present as if it were back at the start
    expect(continueStatusFor({ images: 102, voiceover: 1, script: true })).toBe("producing_assets");
  });

  it("a script-only production continues at scripting", () => {
    expect(continueStatusFor({ script: true })).toBe("scripting");
  });

  it("an empty production is the only one that lands at greenlit", () => {
    expect(continueStatusFor({})).toBe("greenlit");
  });
});

describe("statusForStage — every stage has a re-entry status", () => {
  it("maps each stage to a real production status", () => {
    const valid = new Set([
      "scripting",
      "producing_assets",
      "assembling",
      "thumbnail_review",
      "ready",
    ]);
    for (const stage of PRODUCTION_STAGES) {
      expect(valid.has(statusForStage(stage))).toBe(true);
    }
  });

  it("never re-enters upstream of the stage being reopened", () => {
    expect(statusForStage("script")).toBe("scripting");
    expect(statusForStage("render")).toBe("assembling");
    expect(statusForStage("publish")).toBe("ready");
  });
});
