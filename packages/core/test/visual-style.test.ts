import { describe, expect, it } from "vitest";
import {
  applyHouseImageStyle,
  resolveShotStyleRegister,
  resolveConditioning,
  resolveImageStyle,
  styleBlockForCharacterPlate,
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

describe("resolveImageStyle — blank means blank, never a default", () => {
  it("returns null for unset/blank/whitespace and trims a real value", () => {
    expect(resolveImageStyle(undefined)).toBeNull();
    expect(resolveImageStyle(null)).toBeNull();
    expect(resolveImageStyle("")).toBeNull();
    expect(resolveImageStyle("   \n ")).toBeNull();
    expect(resolveImageStyle("  bold graphic illustration  ")).toBe("bold graphic illustration");
  });
});

describe("applyHouseImageStyle (#93 — authored prompts keep the house register)", () => {
  // the real channel style from ticket 01KZ070KJW60WRJSVCJ778F6D4
  const HOUSE =
    "Bold graphic illustration — a painted graphic-novel / high-end animated-documentary look. " +
    "Clearly illustrated and stylised, NOT photographic, NOT a photo, NOT a 3D render.";
  // the exact authored prompt that rendered photoreal (idx 72)
  const AUTHORED =
    "Wide shot of a Mediterranean port city from the water at dawn, ships at anchor, " +
    "the city rising behind, small figures on the quays, pale gold light, 16:9 landscape.";

  it("appends the register while leaving the authored subject byte-verbatim", () => {
    const out = applyHouseImageStyle(AUTHORED, HOUSE);
    // "verbatim" = the subject/composition is untouched, and leads the prompt
    expect(out.startsWith(AUTHORED)).toBe(true);
    expect(out).toBe(`${AUTHORED} Style: ${HOUSE}`);
    // the whole point: the "NOT photographic" instruction now reaches the model
    expect(out).toContain("NOT photographic");
  });

  it("is idempotent — a re-render of a stored suffixed prompt can't stack the clause", () => {
    const once = applyHouseImageStyle(AUTHORED, HOUSE);
    const twice = applyHouseImageStyle(once, HOUSE);
    expect(twice).toBe(once);
    expect(twice.match(/Style:/g)).toHaveLength(1);
  });

  it("leaves a prompt that already carries the style alone", () => {
    const baked = `Bold graphic illustration of a harbour at dawn, painted graphic-novel look.`;
    expect(applyHouseImageStyle(baked, HOUSE)).toBe(baked);
  });

  it("blank style means blank — an unset channel imposes no look", () => {
    expect(applyHouseImageStyle(AUTHORED, null)).toBe(AUTHORED);
    expect(applyHouseImageStyle(AUTHORED, undefined)).toBe(AUTHORED);
    expect(applyHouseImageStyle(AUTHORED, "   ")).toBe(AUTHORED);
  });

  it("an empty prompt stays empty (never a style-only prompt)", () => {
    expect(applyHouseImageStyle("", HOUSE)).toBe("");
    expect(applyHouseImageStyle("   ", HOUSE)).toBe("");
  });

  it("takes a distilled Style-tab promptSuffix as the register when one is active", () => {
    const out = applyHouseImageStyle(AUTHORED, DOC.promptSuffix);
    expect(out).toContain(DOC.promptSuffix);
    expect(out.startsWith(AUTHORED)).toBe(true);
  });
});

describe("resolveShotStyleRegister (#93 reopen — the live-render regression)", () => {
  const HOUSE = "Bold graphic illustration — Clearly illustrated and stylised, NOT photographic.";

  it("THE BUG: an active distilled style must NOT leave an authored prompt styleless", () => {
    // The Lost Books: distilled style active + authored prompts + seedream. The old
    // rule suppressed dna.imageStyle whenever a distilled style existed, on the
    // belief that reference-image conditioning carried the look instead — but that
    // conditioning only fires on nano-banana, and the distilled TEXT lives in the
    // builder, which authored prompts skip. All three carriers missed.
    const r = resolveShotStyleRegister({
      distilledPromptSuffix: DOC.promptSuffix,
      houseImageStyle: HOUSE,
    });
    expect(r.register).not.toBeNull();
    expect(r.source).toBe("distilled_style");
    // and it reaches the prompt
    expect(applyHouseImageStyle("Wide shot of a messenger on horseback.", r.register)).toContain(
      DOC.promptSuffix,
    );
  });

  it("falls back to the channel house style when no distilled style is active", () => {
    expect(resolveShotStyleRegister({ distilledPromptSuffix: null, houseImageStyle: HOUSE })).toEqual({
      register: HOUSE,
      source: "channel_image_style",
    });
    // blank/whitespace distilled suffix must not shadow a real house style
    expect(
      resolveShotStyleRegister({ distilledPromptSuffix: "   ", houseImageStyle: HOUSE }).source,
    ).toBe("channel_image_style");
  });

  it("reports 'none' only when the channel genuinely has no register", () => {
    expect(resolveShotStyleRegister({ distilledPromptSuffix: null, houseImageStyle: null })).toEqual({
      register: null,
      source: "none",
    });
    // and a null register leaves the prompt untouched — blank still means blank
    const p = "Wide shot of a harbour.";
    expect(applyHouseImageStyle(p, null)).toBe(p);
  });

  it("there is NO engine/conditioning carve-out — the text register is unconditional", () => {
    // every combination that has ANY register available must produce one; the old
    // code returned nothing whenever a distilled style existed
    for (const distilled of [DOC.promptSuffix, null]) {
      for (const house of [HOUSE, null]) {
        const r = resolveShotStyleRegister({ distilledPromptSuffix: distilled, houseImageStyle: house });
        expect(r.register === null).toBe(!distilled && !house);
      }
    }
  });
});

describe("buildThumbnailPrompts with NO house style", () => {
  it("writes no style lead at all (no fabricated default)", () => {
    const withStyle = buildThumbnailPrompts({
      title: "T",
      angle: "A",
      style: "archival documentary photography",
      isLong: true,
    });
    const blank = buildThumbnailPrompts({ title: "T", angle: "A", style: null, isLong: true });
    for (const p of blank) {
      expect(p).not.toContain("archival documentary photography");
      expect(p).not.toMatch(/clean flat illustration/i);
    }
    // the style lead is the ONLY difference — everything else is unchanged
    expect(blank[0]).toBe(withStyle[0]!.replace("archival documentary photography. ", ""));
  });
});

describe("styleBlockForCharacterPlate (#56/#57 #3 — no scene bleed)", () => {
  it("keeps the render register but DROPS scene composition + subject treatment", () => {
    const block = styleBlockForCharacterPlate(DOC);
    // register/look fields survive so the character still matches the channel
    expect(block).toContain(DOC.palette);
    expect(block).toContain(DOC.lighting);
    expect(block).toContain(DOC.texture);
    expect(block).toContain(DOC.energy);
    expect(block).toContain(DOC.promptSuffix);
    // the scene-framing fields are the scenery/scale bleed vector — excluded
    expect(block).not.toContain(DOC.composition);
    expect(block).not.toContain(DOC.subjectTreatment);
    expect(block).not.toContain("subject treatment");
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
