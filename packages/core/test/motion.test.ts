import { describe, expect, it } from "vitest";
import { planMotion } from "../src/motion";

const shot = (heroShot: boolean, len = 5, entity: string | null = null) => ({
  heroShot,
  referenceEntity: entity,
  startSec: 0,
  endSec: len,
});

const OPTS = { maxClipSec: 10, maxAiClips: 12 };

describe("planMotion", () => {
  it("static → nothing moves", () => {
    const plan = planMotion([shot(true), shot(false)], { motion: "static", visualMode: "mixed" }, OPTS);
    expect(plan.every((p) => p.mode === "none")).toBe(true);
  });

  it("partial on a real-imagery channel: hero shots use the stock chain with AI fallback", () => {
    const plan = planMotion(
      [shot(true, 5, "Concorde"), shot(false), shot(true)],
      { motion: "partial", visualMode: "mixed" },
      OPTS,
    );
    expect(plan[0]).toEqual({ idx: 0, mode: "stock", aiFallback: true });
    expect(plan[1]!.mode).toBe("none");
    expect(plan[2]!.mode).toBe("stock");
  });

  it("partial on an AI-imagery channel: hero shots animate directly (i2v)", () => {
    const plan = planMotion(
      [shot(true), shot(false)],
      { motion: "partial", visualMode: "ai_images" },
      OPTS,
    );
    expect(plan[0]!.mode).toBe("ai_i2v");
    expect(plan[1]!.mode).toBe("none");
  });

  it("over-length beats keep their stills in every mode", () => {
    const long = shot(true, 25);
    expect(planMotion([long], { motion: "partial", visualMode: "ai_images" }, OPTS)[0]!.mode).toBe("none");
    expect(planMotion([long], { motion: "ai_video", visualMode: "ai_video" }, OPTS)[0]!.mode).toBe("none");
  });

  it("ai_video animates everything eligible, hero-first, capped at maxAiClips", () => {
    const shots = [shot(false), shot(false), shot(true), shot(false)];
    const plan = planMotion(shots, { motion: "ai_video", visualMode: "ai_video" }, { maxClipSec: 10, maxAiClips: 2 });
    // hero (idx 2) wins a slot, then earliest non-hero (idx 0)
    expect(plan.filter((p) => p.mode === "ai_i2v").map((p) => p.idx)).toEqual([0, 2]);
    expect(plan[1]!.mode).toBe("none");
    expect(plan[3]!.mode).toBe("none");
  });

  it("partial caps AI fallback spend at maxAiClips", () => {
    const shots = [shot(true), shot(true), shot(true)];
    const plan = planMotion(shots, { motion: "partial", visualMode: "mixed" }, { maxClipSec: 10, maxAiClips: 1 });
    expect(plan.map((p) => p.aiFallback)).toEqual([true, false, false]);
    // still sourced from stock even without fallback budget
    expect(plan.every((p) => p.mode === "stock")).toBe(true);
  });

  // Visual Director path (a shot carries an explicit `medium`).
  const directed = (medium: "still" | "motion" | "real_footage", len = 5) => ({
    heroShot: false,
    referenceEntity: null,
    startSec: 0,
    endSec: len,
    medium,
  });

  it("director real_footage on a real-imagery channel → stock", () => {
    const plan = planMotion(
      [directed("real_footage"), directed("still")],
      { motion: "partial", visualMode: "mixed" },
      OPTS,
    );
    expect(plan[0]!.mode).toBe("stock");
    expect(plan[1]!.mode).toBe("none");
  });

  it("director real_footage on an AI-only channel NEVER sources footage (regression: Krypton real-clip leak)", () => {
    for (const visualMode of ["ai_images", "ai_video"] as const) {
      const plan = planMotion(
        [directed("real_footage"), directed("motion"), directed("still")],
        { motion: "partial", visualMode },
        OPTS,
      );
      // the forbidden real_footage shot falls back to the generated still…
      expect(plan[0]!.mode).toBe("none");
      // …while a genuine motion shot still animates, and no shot is "stock"
      expect(plan[1]!.mode).toBe("ai_i2v");
      expect(plan.some((p) => p.mode === "stock")).toBe(false);
    }
  });
});
