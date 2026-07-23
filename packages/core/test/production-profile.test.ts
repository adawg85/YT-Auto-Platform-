import { describe, expect, it } from "vitest";
import {
  defaultProductionProfile,
  deliveryVoiceSettings,
  preferGeneratedImagery,
  productionProfileSchema,
  resolveProductionProfile,
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

  it("thumbnailTemplate accepts up to 6000 chars (ticket 01KY6F1X… — was 800) and rejects beyond", () => {
    const at6000 = productionProfileSchema.partial().safeParse({ thumbnailTemplate: "x".repeat(6000) });
    expect(at6000.success).toBe(true);
    const over = productionProfileSchema.partial().safeParse({ thumbnailTemplate: "x".repeat(6001) });
    expect(over.success).toBe(false);
    // a ~1900-char template (the ticket's real case) now stores, kept verbatim
    const tmpl = "line\n".repeat(380); // ~1900 chars, newlines intact
    const resolved = resolveProductionProfile({ thumbnailTemplate: tmpl });
    expect(resolved.thumbnailTemplate).toBe(tmpl.trim());
  });
});
