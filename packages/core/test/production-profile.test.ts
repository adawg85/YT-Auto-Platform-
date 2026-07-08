import { describe, expect, it } from "vitest";
import {
  defaultProductionProfile,
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

  it("defaults captions ON for Shorts and OFF for long-form", () => {
    expect(resolveProductionProfile(null, { contentFormat: "short" }).captions).toBe(true);
    expect(resolveProductionProfile(null, { contentFormat: "long" }).captions).toBe(false);
    // unknown/missing format is treated as short (the v1 platform default)
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

  it("defaultProductionProfile is format-aware", () => {
    expect(defaultProductionProfile("long").captions).toBe(false);
    expect(defaultProductionProfile("short").captions).toBe(true);
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
});
