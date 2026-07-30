import { describe, expect, it } from "vitest";
import {
  defaultProductionProfile,
  deliveryVoiceSettings,
  guidanceBudgetWarnings,
  preferGeneratedImagery,
  productionProfileSchema,
  PROFILE_GUIDANCE_MAX,
  resolveProductionProfile,
  stillMotionTransform,
} from "../src/production-profile";

describe("resolveProductionProfile (defaults + merge)", () => {
  it("falls back to behaviour-preserving defaults when nothing is stored", () => {
    const p = resolveProductionProfile(null, { contentFormat: "short" });
    expect(p.visualMode).toBe("mixed");
    expect(p.motion).toBe("static");
    expect(p.rhythm).toBe("sentence");
    expect(p.music).toBe("off");
    expect(p.delivery).toBe("measured");
    expect(p.artDirection).toBeUndefined();
  });

  it("defaults captions ON for every format (#26 operator ask)", () => {
    expect(resolveProductionProfile(null, { contentFormat: "short" }).captions).toBe(true);
    expect(resolveProductionProfile(null, { contentFormat: "long" }).captions).toBe(true);
    expect(resolveProductionProfile(null).captions).toBe(true);
  });

  it("merges stored values over the defaults", () => {
    const p = resolveProductionProfile(
      { visualMode: "real_footage", captions: false, music: "subtle" },
      { contentFormat: "short" },
    );
    expect(p.visualMode).toBe("real_footage");
    expect(p.captions).toBe(false);
    expect(p.music).toBe("subtle");
    // untouched axes still default
    expect(p.motion).toBe("static");
  });

  it("ignores invalid stored enum values (falls back, never throws)", () => {
    const p = resolveProductionProfile({ visualMode: "bogus" as never, motion: "" as never });
    expect(p.visualMode).toBe("mixed");
    expect(p.motion).toBe("static");
  });

  it("trims and drops empty note fields", () => {
    expect(resolveProductionProfile({ artDirection: "   " }).artDirection).toBeUndefined();
    expect(resolveProductionProfile({ artDirection: "  archival photos  " }).artDirection).toBe(
      "archival photos",
    );
  });

  it("defaultProductionProfile defaults captions ON regardless of format", () => {
    expect(defaultProductionProfile("long").captions).toBe(true);
    expect(defaultProductionProfile("short").captions).toBe(true);
  });

  it("preferGeneratedImagery: AI modes skip the real-photo lookup, others keep it", () => {
    expect(preferGeneratedImagery("ai_images")).toBe(true);
    expect(preferGeneratedImagery("ai_video")).toBe(true);
    expect(preferGeneratedImagery("real_footage")).toBe(false);
    expect(preferGeneratedImagery("mixed")).toBe(false);
    expect(preferGeneratedImagery("simple")).toBe(false);
  });

  it("deliveryVoiceSettings: expressiveness rises as stability falls", () => {
    const measured = deliveryVoiceSettings("measured");
    const dramatic = deliveryVoiceSettings("dramatic");
    // more dramatic → lower stability, higher style
    expect(dramatic.stability).toBeLessThan(measured.stability);
    expect(dramatic.style).toBeGreaterThan(measured.style);
    // all in ElevenLabs' 0–1 range with speaker boost on
    for (const d of ["measured", "warm", "energetic", "dramatic"]) {
      const s = deliveryVoiceSettings(d);
      expect(s.stability).toBeGreaterThanOrEqual(0);
      expect(s.stability).toBeLessThanOrEqual(1);
      expect(s.style).toBeGreaterThanOrEqual(0);
      expect(s.style).toBeLessThanOrEqual(1);
      expect(s.useSpeakerBoost).toBe(true);
    }
    // unknown → measured default
    expect(deliveryVoiceSettings("bogus")).toEqual(deliveryVoiceSettings("measured"));
  });

  it("the zod schema accepts a full valid profile and rejects a bad enum", () => {
    const ok = productionProfileSchema.safeParse({
      visualMode: "mixed",
      motion: "static",
      rhythm: "sentence",
      captions: true,
      music: "off",
      delivery: "measured",
    });
    expect(ok.success).toBe(true);
    const bad = productionProfileSchema.safeParse({
      visualMode: "nope",
      motion: "static",
      rhythm: "sentence",
      captions: true,
      music: "off",
      delivery: "measured",
    });
    expect(bad.success).toBe(false);
  });

  it("thumbnailTemplate accepts up to the guidance cap (#71: 50,000, was 6,000) and rejects beyond", () => {
    expect(PROFILE_GUIDANCE_MAX).toBe(50000);
    const atMax = productionProfileSchema.partial().safeParse({ thumbnailTemplate: "x".repeat(PROFILE_GUIDANCE_MAX) });
    expect(atMax.success).toBe(true);
    const over = productionProfileSchema.partial().safeParse({ thumbnailTemplate: "x".repeat(PROFILE_GUIDANCE_MAX + 1) });
    expect(over.success).toBe(false);
    // the old 6,000 cap no longer binds — a full brief that overflowed it now fits
    const brief = "x".repeat(6510); // the ticket's rejected draft length
    expect(productionProfileSchema.partial().safeParse({ notes: brief }).success).toBe(true);
    // a ~1900-char template (an earlier ticket's real case) still stores verbatim
    const tmpl = "line\n".repeat(380);
    const resolved = resolveProductionProfile({ thumbnailTemplate: tmpl });
    expect(resolved.thumbnailTemplate).toBe(tmpl.trim());
  });

  describe("stillMotionTransform (#73)", () => {
    it("default slow_push @ 0.12 reproduces the prior hardcoded 1→1.12 zoom", () => {
      expect(stillMotionTransform("slow_push", 0.12, 0).scale).toBeCloseTo(1);
      expect(stillMotionTransform("slow_push", 0.12, 1).scale).toBeCloseTo(1.12);
      expect(stillMotionTransform("slow_push", 0.12, 0.5).scale).toBeCloseTo(1.06);
    });
    it("slow_pull zooms out (starts scaled, ends at 1)", () => {
      expect(stillMotionTransform("slow_pull", 0.1, 0).scale).toBeCloseTo(1.1);
      expect(stillMotionTransform("slow_pull", 0.1, 1).scale).toBeCloseTo(1);
    });
    it("none holds the frame perfectly still", () => {
      const a = stillMotionTransform("none", 0.12, 0);
      const b = stillMotionTransform("none", 0.12, 1);
      expect(a).toEqual({ scale: 1, translateXPct: 0, translateYPct: 0 });
      expect(b.scale).toBe(1);
    });
    it("drift pans across the hold at a slight fixed zoom (no edge reveal)", () => {
      const mid = stillMotionTransform("drift", 0.1, 0.5);
      const end = stillMotionTransform("drift", 0.1, 1);
      expect(mid.translateXPct).toBeCloseTo(0); // centred at the midpoint
      expect(end.translateXPct).toBeGreaterThan(0); // moved by the end
      expect(end.scale).toBeGreaterThan(1); // always slightly zoomed so edges hide
    });
    it("clamps amount to [0, 0.15] and frac to [0,1]", () => {
      expect(stillMotionTransform("slow_push", 5, 1).scale).toBeCloseTo(1.15);
      expect(stillMotionTransform("slow_push", -1, 1).scale).toBeCloseTo(1);
      expect(stillMotionTransform("slow_push", 0.12, 2).scale).toBeCloseTo(1.12);
    });
    it("resolveProductionProfile fills prior-behaviour defaults", () => {
      const p = resolveProductionProfile(null);
      expect(p.stillMotion).toBe("slow_push");
      expect(p.stillMotionAmount).toBeCloseTo(0.12);
      expect(p.transition).toBe("cut");
      expect(p.transitionMs).toBe(0);
    });
  });

  describe("guidanceBudgetWarnings (#71)", () => {
    it("is silent for normal-sized guidance", () => {
      expect(guidanceBudgetWarnings({ notes: "short brief", artDirection: "archival photos" })).toEqual([]);
    });
    it("flags a large artDirection as per-shot cost", () => {
      const w = guidanceBudgetWarnings({ artDirection: "x".repeat(8000) });
      expect(w).toHaveLength(1);
      expect(w[0]).toMatch(/per-shot image prompt/i);
    });
    it("flags large notes and thumbnailTemplate as once-per-pass", () => {
      const w = guidanceBudgetWarnings({ notes: "x".repeat(30000), thumbnailTemplate: "x".repeat(30000) });
      expect(w).toHaveLength(2);
      expect(w.join(" ")).toMatch(/authoring pass/);
      expect(w.join(" ")).toMatch(/thumbnail build/);
    });
    it("stays under the artDirection advisory just below the threshold", () => {
      expect(guidanceBudgetWarnings({ artDirection: "x".repeat(6000) })).toEqual([]);
    });
  });

  describe("captionStyle schema (#79 — no silent key drops)", () => {
    it("accepts the #79 legibility fields", () => {
      const r = productionProfileSchema.partial().safeParse({
        captionStyle: { color: "#FFFFFF", outlineColor: "#000000", outlineWidth: 6, shadow: true, scrim: true },
      });
      expect(r.success).toBe(true);
    });
    it("REJECTS an unknown captionStyle key instead of dropping it", () => {
      const r = productionProfileSchema.partial().safeParse({
        captionStyle: { color: "#FFFFFF", bogusKey: 1 },
      });
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.error.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
      }
    });
  });
});
