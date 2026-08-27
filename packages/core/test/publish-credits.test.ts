import { describe, expect, it } from "vitest";
import {
  assemblePublishDescription,
  DESCRIPTION_MAX_CHARS,
  imageCreditLines,
  musicCreditLines,
  musicCreditText,
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

  // #110 follow-up (the "Unraveling" defect): an audio-library track's stored
  // attribution is already the COMPLETE T.A.S.L. line — rebuilding the credit
  // around it printed the title and licence twice with a stray `).,`.
  const taslLine =
    '"Unraveling" by Scott Buckley (https://www.scottbuckley.com.au/), via https://www.scottbuckley.com.au/library/unraveling/, licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).';

  it("a self-contained attribution line is emitted VERBATIM — no name prefix, no licence suffix", () => {
    expect(
      musicCreditLines({
        name: "Unraveling",
        attribution: taslLine,
        license: "CC BY 4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      }),
    ).toEqual([`• ${taslLine}`]);
  });

  it("the licence string appears exactly once per generated line", () => {
    for (const row of [
      { name: "Unraveling", attribution: taslLine, license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/" },
      { name: "Dark Ambient 2", attribution: "strathamer (https://freesound.org/s/415890/)", license: "CC BY 4.0", licenseUrl: null },
    ]) {
      const [line] = musicCreditLines(row);
      expect(line).toBeDefined();
      expect(line!.split("CC BY 4.0").length - 1).toBe(1);
      expect(line).not.toContain(").,");
      expect(line!.split(`"${row.name}"`).length - 1).toBeLessThanOrEqual(1);
    }
  });

  it("a rights-holder requiredCredit wins verbatim over everything else", () => {
    const required = "'Unraveling' by Scott Buckley – released under CC-BY 4.0. www.scottbuckley.com.au";
    expect(
      musicCreditLines({
        name: "Unraveling",
        attribution: taslLine,
        license: "CC BY 4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        requiredCredit: required,
      }),
    ).toEqual([`• ${required}`]);
  });
});

// #131: the ticket's exact pair, from the Scott Buckley library assets. Both are
// valid CC attributions; they are NOT interchangeable for a Content ID claim
// release, because the rights holder's release process checks for their own
// published wording. The differences are load-bearing: single vs double quotes,
// "released under CC-BY 4.0" vs "licensed under CC BY 4.0", a bare domain vs
// full URLs with paths, and the generated line's extra `via` source URL.
describe("#131 requiredCreditFormat vs the generated attribution line", () => {
  const generated =
    '"Home Was You" by Scott Buckley (https://www.scottbuckley.com.au/), via https://www.scottbuckley.com.au/library/home-was-you/, licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).';
  const required = "'Home Was You' by Scott Buckley – released under CC-BY 4.0. www.scottbuckley.com.au";
  const row = {
    name: "Home Was You",
    attribution: generated,
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  };

  it("emits the rights holder's wording verbatim, not the generated line", () => {
    const credit = musicCreditText({ ...row, requiredCredit: required });
    expect(credit).toBe(required);
    expect(credit).not.toBe(generated);
    // the acceptance criterion: the published description contains it verbatim
    const description = assemblePublishDescription({
      body: "b",
      authored: true,
      imageCredits: [],
      musicCredits: musicCreditLines({ ...row, requiredCredit: required }),
    });
    expect(description).toContain(required);
    expect(description).not.toContain("licensed under CC BY 4.0");
  });

  it("falls back to the generated line ONLY when no required format is set", () => {
    // an Openverse import has audioAssetId null and can never resolve one
    for (const requiredCredit of [null, undefined, "", "   "]) {
      expect(musicCreditText({ ...row, requiredCredit })).toBe(generated);
    }
  });

  it("what is RECORDED on the publication row is what is PUBLISHED", () => {
    // the row's musicCredit and the description's bullet must never diverge —
    // they are the same string by construction
    for (const requiredCredit of [required, null]) {
      const credit = musicCreditText({ ...row, requiredCredit });
      expect(musicCreditLines({ ...row, requiredCredit })).toEqual([`• ${credit}`]);
    }
  });

  it("a track needing no credit records null rather than an empty bullet", () => {
    expect(musicCreditText(null)).toBeNull();
    expect(musicCreditText({ name: "AI bed", attribution: null, license: null })).toBeNull();
    expect(musicCreditLines(null)).toEqual([]);
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
