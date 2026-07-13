import { describe, expect, it } from "vitest";
import {
  resolveConditioning,
  styleBlockForImagePrompts,
  styleRefKeyForIndex,
  visualStyleDistillSchema,
} from "../src/visual-style";
import { buildThumbnailPrompts } from "../src/thumbnail-prompts";

const DOC = {
  palette: "steel blue with one amber accent",
  lighting: "hard left key",
  composition: "subject at two-thirds frame",
  subjectTreatment: "low angle, rim-lit",
  texture: "35mm grain",
  typography: "two uppercase words, heavy sans",
  energy: "measured awe",
  promptSuffix: "Style: steel blue, amber accent, 35mm grain. Mood: measured awe.",
  rationale: "test",
};

describe("visualStyleDistillSchema", () => {
  it("parses the mock-shaped fixture", () => {
    expect(visualStyleDistillSchema.parse(DOC)).toMatchObject({ palette: DOC.palette });
  });
});

describe("styleRefKeyForIndex", () => {
  it("rotates deterministically and returns undefined on empty", () => {
    const keys = ["a", "b", "c"];
    expect(styleRefKeyForIndex(keys, 0)).toBe("a");
    expect(styleRefKeyForIndex(keys, 4)).toBe("b");
    expect(styleRefKeyForIndex([], 2)).toBeUndefined();
  });
});

describe("resolveConditioning", () => {
  it("defaults to thumbs_hero @ 0.45 and clamps strength", () => {
    expect(resolveConditioning(null)).toEqual({ scope: "thumbs_hero", strength: 0.45 });
    expect(resolveConditioning({ conditioning: { scope: "all_generated", strength: 5 } })).toEqual({
      scope: "all_generated",
      strength: 0.9,
    });
    expect(resolveConditioning({ conditioning: { scope: "nonsense", strength: 0 } }).scope).toBe(
      "thumbs_hero",
    );
  });
});

describe("styleBlockForImagePrompts", () => {
  it("carries every field and the verbatim suffix", () => {
    const block = styleBlockForImagePrompts(DOC);
    expect(block).toContain("CHANNEL VISUAL STYLE");
    expect(block).toContain(DOC.promptSuffix);
    expect(block).toContain(DOC.palette);
  });
});

describe("buildThumbnailPrompts with styleDoc (#35.1)", () => {
  const base = {
    title: "The Jet That Arrived Too Late",
    angle: "Me 262 was years ahead",
    style: "archival documentary photography",
    isLong: true,
  };

  it("appends the promptSuffix to every concept and uses palette as contrast default", () => {
    const prompts = buildThumbnailPrompts({ ...base, styleDoc: DOC });
    for (const p of prompts) {
      expect(p).toContain(DOC.promptSuffix);
      expect(p).toContain(DOC.palette);
    }
  });

  it("spec colorContrast still wins over the style palette", () => {
    const prompts = buildThumbnailPrompts({
      ...base,
      styleDoc: DOC,
      spec: {
        focalObject: "the aircraft",
        textStyle: "block caps",
        maxWords: 2,
        colorContrast: "neon green on black",
        negativeSpace: "",
      },
    });
    expect(prompts[0]).toContain("neon green on black");
    expect(prompts[0]).not.toContain(DOC.palette);
  });

  it("no styleDoc → output identical to the pre-#35.1 builder", () => {
    const a = buildThumbnailPrompts(base);
    const b = buildThumbnailPrompts({ ...base, styleDoc: null });
    expect(a).toEqual(b);
    for (const p of a) expect(p).not.toContain("Style: steel blue");
  });
});
