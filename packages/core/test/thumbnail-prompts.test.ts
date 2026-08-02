import { describe, expect, it } from "vitest";
import { buildThumbnailPrompts } from "../src/thumbnail-prompts";

const base = {
  title: "The Jet That Arrived Too Late",
  angle: "Me 262 was years ahead — and doomed by its own timing",
  style: "archival documentary photography",
  isLong: true,
};

describe("buildThumbnailPrompts (#35.3)", () => {
  it("returns 2 concepts without patterns, 3 with a pattern", () => {
    expect(buildThumbnailPrompts(base)).toHaveLength(2);
    const withPattern = buildThumbnailPrompts({
      ...base,
      patterns: [
        {
          label: "giant subject + red arrow",
          detail: {
            composition: "subject at 65% frame right, empty sky left",
            subjectTreatment: "low angle, scale exaggeration",
            palette: "steel blue with hot orange accent",
            emotion: "awe",
          },
        },
      ],
    });
    expect(withPattern).toHaveLength(3);
    expect(withPattern[2]).toContain("giant subject + red arrow");
    expect(withPattern[2]).toContain("steel blue with hot orange accent");
    // the pattern transfers SHAPE only — the subject stays this video's
    expect(withPattern[2]).toContain(base.title);
  });

  it("every concept carries the feed-size legibility rule", () => {
    for (const p of buildThumbnailPrompts(base)) {
      expect(p).toContain("postage-stamp");
    }
  });

  it("overlay text defaults on (≤3 uppercased words) and respects spec opt-out", () => {
    const [closeUp] = buildThumbnailPrompts(base);
    expect(closeUp).toMatch(/overlay text reading "[A-Z ]+"/);
    const noText = buildThumbnailPrompts({
      ...base,
      spec: {
        focalObject: "the aircraft",
        textStyle: "none",
        maxWords: 0,
        colorContrast: "",
        negativeSpace: "",
      },
    });
    for (const p of noText) expect(p).not.toContain("overlay text");
  });

  // #91: overlay text + winner-template aspect gating
  it("overlay text uses the first clause of an authored hook, never a mid-phrase fragment", () => {
    const closeUp = buildThumbnailPrompts({
      ...base,
      title: "The B-47: Every Airliner You've Flown Is a Copy of This Bomber",
    })[0]!;
    // takes the hook before the colon, not the first N words of the whole title
    expect(closeUp).toContain('overlay text reading "THE B47"');
    expect(closeUp).not.toContain("EVERY");
  });

  it("never ends the overlay on a dangling connective", () => {
    const closeUp = buildThumbnailPrompts({
      ...base,
      title: "How the Comet and the Jet Age Began",
    })[0]!;
    const m = closeUp.match(/overlay text reading "([^"]+)"/);
    expect(m).toBeTruthy();
    expect(m![1]).not.toMatch(/\b(AND|THE|OR|OF|TO)$/);
  });

  it("omits the text clause entirely when no complete phrase survives", () => {
    // a title that reduces to a lone stop-word yields no usable overlay
    for (const p of buildThumbnailPrompts({ ...base, title: "The" })) {
      expect(p).not.toContain("overlay text");
    }
  });

  it("skips a vertical/mobile-crop winner on a 16:9 long-form frame (#91)", () => {
    const verticalWinner = {
      label: "centered cute-subject + punchline",
      detail: {
        composition: "Vertical/mobile crop. Subject occupies the central 30-45% of frame",
        subjectTreatment: "sharpening on the face/body so it reads at small sizes",
        palette: "orange lead-lines",
        emotion: "curiosity + mild alarm",
      },
    };
    // only a mismatched winner available → no 3rd (pattern-led) concept on 16:9
    const long = buildThumbnailPrompts({ ...base, isLong: true, patterns: [verticalWinner] });
    expect(long).toHaveLength(2);
    expect(long.join(" ")).not.toContain("Vertical/mobile crop");
    // the SAME winner is fine on a 9:16 short-form frame
    const short = buildThumbnailPrompts({ ...base, isLong: false, patterns: [verticalWinner] });
    expect(short).toHaveLength(3);
  });

  it("falls through to the first aspect-fitting winner when the top one mismatches", () => {
    const long = buildThumbnailPrompts({
      ...base,
      isLong: true,
      patterns: [
        { label: "vertical short", detail: { composition: "9:16 vertical crop, subject centered" } },
        { label: "landscape hero", detail: { composition: "wide 16:9 subject at frame right, sky left" } },
      ],
    });
    expect(long).toHaveLength(3);
    expect(long[2]).toContain("landscape hero");
  });
});
