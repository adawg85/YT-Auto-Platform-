import { describe, expect, it } from "vitest";
import {
  assemblePublishDescription,
  DESCRIPTION_MAX_CHARS,
  imageCreditLines,
  musicCreditLines,
} from "../src/publish-credits";

// #77: these blocks are what a live description edit must NEVER strip — the
// worker's publish path and the post-publish editor both assemble through here.

describe("imageCreditLines", () => {
  it("credits licensed assets, deduped by source, skipping unlicensed ones", () => {
    const lines = imageCreditLines([
      { entity: "SR-71", source: "https://commons.example/a", license: "CC BY 2.0", attribution: "J. Doe" },
      { entity: "SR-71 cockpit", source: "https://commons.example/a", license: "CC BY 2.0" }, // same source → deduped
      { source: "https://nasa.example/b", license: "Public domain (NASA)" },
      { entity: "generated", license: undefined, source: undefined }, // AI image → no credit
      null,
    ]);
    expect(lines).toEqual([
      "• SR-71 — J. Doe, CC BY 2.0: https://commons.example/a",
      "• Public domain (NASA): https://nasa.example/b",
    ]);
  });
});

describe("musicCreditLines", () => {
  it("credits a licensed selected track, with the deed when known", () => {
    expect(
      musicCreditLines({
        name: "Dark Ambient 2",
        attribution: "strathamer (https://freesound.org/s/415890/)",
        license: "CC BY 4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      }),
    ).toEqual([
      '• "Dark Ambient 2" — strathamer (https://freesound.org/s/415890/), CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)',
    ]);
  });

  it("no licence or no attribution → no line (nothing is required)", () => {
    expect(musicCreditLines(null)).toEqual([]);
    expect(musicCreditLines({ name: "AI bed", attribution: null, license: null })).toEqual([]);
    expect(musicCreditLines({ name: "t", attribution: "x", license: null })).toEqual([]);
  });
});

describe("assemblePublishDescription", () => {
  const image = ["• SR-71 — J. Doe, CC BY 2.0: https://commons.example/a"];
  const music = ['• "Track" — someone, CC BY 4.0'];

  it("authored copy owns its body; disclosure + credits are ALWAYS appended", () => {
    const d = assemblePublishDescription({
      body: "New description the operator wrote.",
      authored: true,
      ctaLine: "SUBSCRIBE NOW", // must NOT appear on authored copy
      imageCredits: image,
      musicCredits: music,
    });
    expect(d).toContain("New description the operator wrote.");
    expect(d).not.toContain("SUBSCRIBE NOW");
    expect(d).toContain("This video contains AI-generated content.");
    expect(d).toContain("Image credits:");
    expect(d).toContain("Music:");
  });

  it("auto copy keeps the CTA + funnel block", () => {
    const d = assemblePublishDescription({
      body: "The idea angle.",
      authored: false,
      ctaLine: "Watch next…",
      funnelLines: ["", "▶ Watch the full video: https://yt.example/x"],
      imageCredits: [],
      musicCredits: [],
    });
    expect(d).toContain("Watch next…");
    expect(d).toContain("▶ Watch the full video");
    expect(d).toContain("This video contains AI-generated content.");
    expect(d).not.toContain("Image credits:");
  });

  it("caps at the YouTube-safe limit", () => {
    const d = assemblePublishDescription({
      body: "x".repeat(6000),
      authored: true,
      imageCredits: [],
      musicCredits: [],
    });
    expect(d.length).toBeLessThanOrEqual(DESCRIPTION_MAX_CHARS);
  });
});
