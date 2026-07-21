import { describe, expect, it } from "vitest";
import { projectShotPlan } from "../src/shot-projection";

/** A multi-sentence beat ~ N words, optionally hero / with a motion prompt. */
function beat(sentences: number, opts: { hero?: boolean; motion?: boolean; entity?: string } = {}) {
  const text = Array.from({ length: sentences }, (_, i) => `This is sentence number ${i + 1} of this beat here.`).join(" ");
  return {
    type: "insight" as const,
    text,
    imagePrompt: "a cinematic wide establishing shot of the subject, high detail",
    referenceEntity: opts.entity ?? null,
    visualBrief: null,
    heroShot: opts.hero ?? false,
    motionPrompt: opts.motion ? "slow push-in on the subject" : null,
  };
}

describe("projectShotPlan (ticket 01KY25DN… / #28)", () => {
  it("projects many shots from few beats under sentence rhythm (the 19→83 case)", () => {
    // 19 long-form beats, several sentences each, one hero, 9 motion prompts.
    const beats = [
      beat(4, { hero: true, motion: true, entity: "Lockheed SR-71 Blackbird" }),
      ...Array.from({ length: 8 }, () => beat(4, { motion: true, entity: "Lockheed SR-71 Blackbird" })),
      ...Array.from({ length: 10 }, () => beat(4, { entity: "Lockheed SR-71 Blackbird" })),
    ];
    const proj = projectShotPlan(
      beats,
      { rhythm: "sentence", motion: "partial", imageDensity: "standard", visualMode: "mixed", maxAiClips: 12 },
      { isLong: true, targetLengthSec: 900 },
    );
    // far more shots than beats — the "duplicate images" root cause
    expect(proj.projectedShots).toBeGreaterThan(beats.length);
    expect(proj.perBeat).toHaveLength(19);
  });

  it("under 'partial', only hero beats move — extra motionPrompts are flagged unused", () => {
    const beats = [
      beat(3, { hero: true, motion: true, entity: "a" }),
      beat(3, { motion: true, entity: "b" }), // motionPrompt but NOT hero → ignored
      beat(3, { motion: true, entity: "c" }), // ditto
    ];
    const proj = projectShotPlan(
      beats,
      { rhythm: "sentence", motion: "partial", imageDensity: "standard", visualMode: "ai_images", maxAiClips: 12 },
      { isLong: true, targetLengthSec: 120 },
    );
    // only the hero beat's shot(s) move
    expect(proj.projectedMovingShots).toBeGreaterThanOrEqual(1);
    // the two non-hero motionPrompts are surfaced as unused
    expect(proj.unusedMotionPromptBeats).toEqual([1, 2]);
    expect(proj.notes.some((n) => n.includes("partial"))).toBe(true);
  });

  it("static motion moves nothing and says so", () => {
    const beats = [beat(2, { hero: true, motion: true, entity: "x" })];
    const proj = projectShotPlan(
      beats,
      { rhythm: "sentence", motion: "static", imageDensity: "standard", visualMode: "ai_images", maxAiClips: 12 },
      { isLong: false, targetLengthSec: 45 },
    );
    expect(proj.projectedMovingShots).toBe(0);
    expect(proj.notes.some((n) => n.includes("static"))).toBe(true);
  });

  it("flags repeated referenceEntity as duplicate-image risk", () => {
    const beats = Array.from({ length: 6 }, () => beat(3, { entity: "Same Subject" }));
    const proj = projectShotPlan(
      beats,
      { rhythm: "sentence", motion: "static", imageDensity: "standard", visualMode: "mixed", maxAiClips: 0 },
      { isLong: true, targetLengthSec: 300 },
    );
    expect(proj.distinctReferenceEntities).toBe(1);
    expect(proj.repeatedEntityShots).toBeGreaterThan(0);
    expect(proj.notes.some((n) => n.includes("duplicate-image risk"))).toBe(true);
  });

  it("imageDensity 'busy' cuts more shots than 'relaxed'", () => {
    const beats = Array.from({ length: 5 }, () => beat(4, { entity: "e" }));
    const opts = { isLong: true as const, targetLengthSec: 600 };
    const busy = projectShotPlan(
      beats,
      { rhythm: "sentence", motion: "static", imageDensity: "busy", visualMode: "mixed", maxAiClips: 0 },
      opts,
    );
    const relaxed = projectShotPlan(
      beats,
      { rhythm: "sentence", motion: "static", imageDensity: "relaxed", visualMode: "mixed", maxAiClips: 0 },
      opts,
    );
    expect(busy.projectedShots).toBeGreaterThanOrEqual(relaxed.projectedShots);
  });
});
