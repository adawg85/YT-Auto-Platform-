import { describe, expect, it } from "vitest";
import {
  defaultProductionProfile,
  deliveryVoiceSettings,
  guidanceBudgetWarnings,
  preferGeneratedImagery,
  productionProfileSchema,
  PROFILE_GUIDANCE_MAX,
  resolveProductionProfile,
  mergeProductionProfile,
  minSecondsPerShotOverrideWarning,
  stillMotionTransform,
  stillMotionKindForShot,
  stillMotionDeltaForShot,
  stillMotionRateWarning,
  KEN_BURNS_DELTA_MAX,
  STILL_MOTION_AMOUNT_MAX,
  STILL_MOTION_RATE_MAX,
} from "../src/production-profile";
import type { ProductionProfile } from "@ytauto/db";

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
    it("clamps amount to [0, KEN_BURNS_DELTA_MAX] and frac to [0,1] (#114: kernel ceiling is the per-shot delta cap, 0.6)", () => {
      expect(stillMotionTransform("slow_push", 5, 1).scale).toBeCloseTo(1.6);
      expect(stillMotionTransform("slow_push", -1, 1).scale).toBeCloseTo(1);
      expect(stillMotionTransform("slow_push", 0.12, 2).scale).toBeCloseTo(1.12);
    });
    it("resolveProductionProfile fills prior-behaviour defaults", () => {
      const p = resolveProductionProfile(null);
      expect(p.stillMotion).toBe("slow_push");
      expect(p.stillMotionAmount).toBeCloseTo(0.12);
      expect(p.transition).toBe("cut");
      expect(p.transitionMs).toBe(0);
      // #114: the rate knob has NO default — unset keeps the legacy fixed-amount path
      expect(p.stillMotionRatePctPerSec).toBeUndefined();
    });
  });

  describe("rate-based Ken Burns (#114)", () => {
    it("stillMotionKindForShot resolves 'alternate' by shot parity and passes concrete kinds through", () => {
      expect(stillMotionKindForShot("alternate", 0)).toBe("slow_push");
      expect(stillMotionKindForShot("alternate", 1)).toBe("slow_pull");
      expect(stillMotionKindForShot("alternate", 2)).toBe("slow_push");
      expect(stillMotionKindForShot("drift", 7)).toBe("drift");
      expect(stillMotionKindForShot("none", 0)).toBe("none");
    });

    it("stillMotionDeltaForShot scales the delta to the shot's own hold when the rate is set", () => {
      // the ticket's Lost Books row: 1.2%/sec over a 27.7s hold → 0.33 total travel
      expect(stillMotionDeltaForShot({ stillMotionAmount: 0.15, stillMotionRatePctPerSec: 1.2 }, 27.7)).toBeCloseTo(0.3324);
      // same rate on a short hold — perceived speed identical, smaller travel
      expect(stillMotionDeltaForShot({ stillMotionAmount: 0.15, stillMotionRatePctPerSec: 1.2 }, 5)).toBeCloseTo(0.06);
      // a 60s hold at 1.2%/sec would ask for 0.72 — capped at KEN_BURNS_DELTA_MAX
      expect(stillMotionDeltaForShot({ stillMotionAmount: 0.15, stillMotionRatePctPerSec: 1.2 }, 60)).toBeCloseTo(KEN_BURNS_DELTA_MAX);
      // a degenerate/zero-length shot falls back to a 1s hold, floored at 0.04
      expect(stillMotionDeltaForShot({ stillMotionAmount: 0.15, stillMotionRatePctPerSec: 1.2 }, 0)).toBeCloseTo(0.04);
    });

    it("stillMotionDeltaForShot without a rate keeps the legacy fixed amount (clamped to the profile cap)", () => {
      expect(stillMotionDeltaForShot({ stillMotionAmount: 0.15, stillMotionRatePctPerSec: undefined }, 27.7)).toBeCloseTo(0.15);
      expect(stillMotionDeltaForShot({ stillMotionAmount: 0.9, stillMotionRatePctPerSec: undefined }, 10)).toBeCloseTo(STILL_MOTION_AMOUNT_MAX);
      expect(stillMotionDeltaForShot({ stillMotionAmount: undefined, stillMotionRatePctPerSec: undefined }, 10)).toBeCloseTo(0.12);
    });

    it("resolveProductionProfile accepts 'alternate' and clamps the rate to STILL_MOTION_RATE_MAX", () => {
      const p = resolveProductionProfile({ stillMotion: "alternate", stillMotionRatePctPerSec: 9 });
      expect(p.stillMotion).toBe("alternate");
      expect(p.stillMotionRatePctPerSec).toBeCloseTo(STILL_MOTION_RATE_MAX);
      expect(resolveProductionProfile({ stillMotionAmount: 0.25 }).stillMotionAmount).toBeCloseTo(0.25);
    });

    it("stillMotionRateWarning fires on the ticket's exact rows (sub-1%/sec on long holds)", () => {
      // Pentimento: amount 0.08 over 12.8s holds ≈ 0.63%/sec — "the zoom didn't work"
      const pentimento = stillMotionRateWarning(
        resolveProductionProfile({ stillMotionAmount: 0.08, minSecondsPerShot: 12.8, motion: "static" }),
      );
      expect(pentimento).toMatch(/0\.63%\/sec/);
      expect(pentimento).toMatch(/stillMotionRatePctPerSec/);
      // Lost Books at the old cap: 0.15 over 27.7s ≈ 0.54%/sec — still warns
      const lostBooks = stillMotionRateWarning(
        resolveProductionProfile({ stillMotionAmount: 0.15, minSecondsPerShot: 27.7, motion: "static" }),
      );
      expect(lostBooks).toMatch(/0\.54%\/sec/);
    });

    it("stillMotionRateWarning stays silent when the config can move (or motion isn't stills)", () => {
      // rate knob set → per-shot scaling handles any hold length
      expect(
        stillMotionRateWarning(
          resolveProductionProfile({ stillMotionAmount: 0.08, stillMotionRatePctPerSec: 1.2, minSecondsPerShot: 28, motion: "static" }),
        ),
      ).toBeNull();
      // short holds at a healthy amount: 0.12 over 6s = 2%/sec
      expect(
        stillMotionRateWarning(resolveProductionProfile({ stillMotionAmount: 0.12, minSecondsPerShot: 6, motion: "static" })),
      ).toBeNull();
      // stillMotion none — nothing to warn about
      expect(
        stillMotionRateWarning(resolveProductionProfile({ stillMotion: "none", minSecondsPerShot: 28, motion: "static" })),
      ).toBeNull();
      // animating channel — moving shots are clips, not Ken Burns
      expect(
        stillMotionRateWarning(resolveProductionProfile({ stillMotionAmount: 0.08, minSecondsPerShot: 28, motion: "ai_video" })),
      ).toBeNull();
      // no explicit hold floor — the implied rate is unknowable at write time
      expect(stillMotionRateWarning(resolveProductionProfile({ stillMotionAmount: 0.08, motion: "static" }))).toBeNull();
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

describe("mergeProductionProfile (#80: partial override must not wipe stored axes)", () => {
  // The stored Wings & Stories profile from the ticket.
  const stored: Partial<ProductionProfile> = {
    motion: "partial",
    imageEngine: "seedream",
    heroImageEngine: "seedream",
    characterImageEngine: "seedream",
    thumbnailImageEngine: "seedream",
    voiceModel: "turbo_v2_5",
    delivery: "warm",
    archivalStrength: "balanced",
    visualDirector: true,
    stillMotion: "slow_push",
    music: "subtle",
    maxAiClips: 12,
  };

  it("sending ONE axis keeps every other stored axis (no reset to platform defaults)", () => {
    const merged = mergeProductionProfile(stored, { minSecondsPerShot: 14 });
    // the supplied axis wins
    expect(merged.minSecondsPerShot).toBe(14);
    // and NOTHING else falls through to defaults (the exact regression in #80:
    // motion went partial -> static, engines seedream -> qwen/nano)
    expect(merged.motion).toBe("partial");
    expect(merged.imageEngine).toBe("seedream");
    expect(merged.heroImageEngine).toBe("seedream");
    expect(merged.characterImageEngine).toBe("seedream");
    expect(merged.thumbnailImageEngine).toBe("seedream");
    expect(merged.voiceModel).toBe("turbo_v2_5");
    expect(merged.delivery).toBe("warm");
    expect(merged.music).toBe("subtle");
    expect(merged.visualDirector).toBe(true);
    expect(merged.maxAiClips).toBe(12);
  });

  it("a supplied axis overrides the stored value", () => {
    const merged = mergeProductionProfile(stored, { motion: "ai_video", imageEngine: "qwen" });
    expect(merged.motion).toBe("ai_video");
    expect(merged.imageEngine).toBe("qwen");
    // untouched axes still inherit from the channel
    expect(merged.heroImageEngine).toBe("seedream");
    expect(merged.voiceModel).toBe("turbo_v2_5");
  });

  it("no override reproduces resolveProductionProfile(stored) exactly (behaviour-preserving)", () => {
    expect(mergeProductionProfile(stored, null)).toEqual(resolveProductionProfile(stored));
    expect(mergeProductionProfile(stored, undefined)).toEqual(resolveProductionProfile(stored));
  });

  it("empty stored + override still resolves to a complete profile", () => {
    const merged = mergeProductionProfile(null, { minSecondsPerShot: 20 });
    expect(merged.minSecondsPerShot).toBe(20);
    expect(merged.motion).toBe("static"); // platform default, since nothing was stored
    expect(merged.imageEngine).toBe("qwen");
  });
});

describe("minSecondsPerShotOverrideWarning (#69 append: floor is inert while motion animates)", () => {
  it("warns when the floor exceeds the clip cap AND motion animates", () => {
    expect(minSecondsPerShotOverrideWarning({ motion: "ai_video", minSecondsPerShot: 22 })).toMatch(/NO effect/);
    expect(minSecondsPerShotOverrideWarning({ motion: "partial", minSecondsPerShot: 22 })).toMatch(/i2v clip cap/);
  });

  it("is silent on a static channel (Ken-Burns holds DO honour the floor)", () => {
    expect(minSecondsPerShotOverrideWarning({ motion: "static", minSecondsPerShot: 22 })).toBeNull();
  });

  it("is silent when the floor is at/under the clip cap (no override happening)", () => {
    expect(minSecondsPerShotOverrideWarning({ motion: "ai_video", minSecondsPerShot: 8 })).toBeNull();
    expect(minSecondsPerShotOverrideWarning({ motion: "ai_video", minSecondsPerShot: 10 })).toBeNull();
  });

  it("is silent when no floor is set", () => {
    expect(minSecondsPerShotOverrideWarning({ motion: "ai_video", minSecondsPerShot: undefined })).toBeNull();
  });

  it("respects a caller-supplied clip cap", () => {
    // with a 6s cap, a 8s floor now DOES get overridden
    expect(minSecondsPerShotOverrideWarning({ motion: "ai_video", minSecondsPerShot: 8 }, 6)).toMatch(/NO effect/);
  });
});

// #133: gate approval over MCP. The resolver builds its output field by field, so
// a flag that is not named there is silently dropped — which would have left
// decide_gate refusing forever with the channel's opt-in apparently set. These
// pin the whole round trip: schema accepts it, resolver defaults it OFF, and an
// explicit opt-in survives.
describe("mcpGateApproval (#133 — decide_gate opt-in)", () => {
  it("defaults to FALSE — approval over MCP is opt-in, never inherited", () => {
    expect(resolveProductionProfile(null).mcpGateApproval).toBe(false);
    expect(resolveProductionProfile({}).mcpGateApproval).toBe(false);
    expect(defaultProductionProfile().mcpGateApproval).toBe(false);
  });

  it("survives resolution when the channel opts in", () => {
    expect(resolveProductionProfile({ mcpGateApproval: true }).mcpGateApproval).toBe(true);
    expect(resolveProductionProfile({ mcpGateApproval: false }).mcpGateApproval).toBe(false);
  });

  it("is accepted by the config schema, so set_channel_config can set it", () => {
    // the schema is a FULL profile — a partial patch is how set_channel_config
    // sends one axis, so that is what has to accept the flag
    expect(productionProfileSchema.partial().parse({ mcpGateApproval: true }).mcpGateApproval).toBe(true);
    expect(productionProfileSchema.parse({ ...defaultProductionProfile(), mcpGateApproval: true }).mcpGateApproval).toBe(true);
  });

  it("is independent of the auto-approve axes — it changes WHERE, not WHETHER", () => {
    const p = resolveProductionProfile({ mcpGateApproval: true } as Partial<ProductionProfile>);
    expect(p.autoApproveVisuals).toBe(false);
    expect(p.autoApproveFinal).toBe(false);
    const auto = resolveProductionProfile({ autoApproveFinal: true } as Partial<ProductionProfile>);
    expect(auto.mcpGateApproval).toBe(false);
  });

  it("a merge does not silently turn it on", () => {
    const merged = mergeProductionProfile({ mcpGateApproval: false }, { imageDensity: "busy" });
    expect(resolveProductionProfile(merged).mcpGateApproval).toBe(false);
  });
});
