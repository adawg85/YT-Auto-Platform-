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
});
