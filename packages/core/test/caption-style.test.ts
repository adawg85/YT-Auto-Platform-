import { describe, expect, it } from "vitest";
import {
  resolveCaptionStyle,
  isDefaultCaptionStyle,
  applyCasing,
  emphasizedWordIndices,
} from "../src/caption-style";

describe("caption-style (#72)", () => {
  it("resolves the default look, and flags it as default", () => {
    const r = resolveCaptionStyle(null);
    expect(r).toMatchObject({
      position: "lower-third",
      casing: "as-written",
      typeface: "sans",
      weight: 800,
      emphasisColor: null,
      // #79 legibility default: white text + heavy dark outline + shadow.
      color: "#FFFFFF",
      outlineColor: "#000000",
      outlineWidth: 4,
      shadow: true,
      scrim: false,
    });
    expect(isDefaultCaptionStyle(r)).toBe(true);
  });

  it("a set style is not the default (renderer takes the new path)", () => {
    expect(isDefaultCaptionStyle(resolveCaptionStyle({ position: "center", casing: "upper" }))).toBe(false);
  });

  describe("#79 legibility fields", () => {
    it("honours explicit colour/outline/shadow/scrim overrides", () => {
      const r = resolveCaptionStyle({
        color: "#FFFFFF",
        outlineColor: "#111111",
        outlineWidth: 8,
        shadow: false,
        scrim: true,
      });
      expect(r).toMatchObject({
        color: "#FFFFFF",
        outlineColor: "#111111",
        outlineWidth: 8,
        shadow: false,
        scrim: true,
      });
    });

    it("outline:false disables the stroke; an explicit width wins over it", () => {
      expect(resolveCaptionStyle({ outline: false }).outlineWidth).toBe(0);
      expect(resolveCaptionStyle({ outline: false, outlineWidth: 6 }).outlineWidth).toBe(6);
    });

    it("clamps outlineWidth to 0-12", () => {
      expect(resolveCaptionStyle({ outlineWidth: 99 }).outlineWidth).toBe(12);
      expect(resolveCaptionStyle({ outlineWidth: -3 }).outlineWidth).toBe(0);
    });

    it("#79 follow-up: activeColor is null by default (active word uses base color, no forced accent)", () => {
      // the bug: the active word was forced to the brand accent, overriding `color`.
      // default → null, so the renderer paints the active word with the base color.
      expect(resolveCaptionStyle(null).activeColor).toBeNull();
      expect(resolveCaptionStyle({ color: "#FFFFFF" }).activeColor).toBeNull();
      // set it to opt into a coloured karaoke highlight
      expect(resolveCaptionStyle({ activeColor: "#22D3EE" }).activeColor).toBe("#22D3EE");
      // blank/whitespace → null (falls back to base color)
      expect(resolveCaptionStyle({ activeColor: "  " }).activeColor).toBeNull();
    });
  });

  it("clamps weight to 400-900 and maxLines to 1-4", () => {
    expect(resolveCaptionStyle({ weight: 2000 }).weight).toBe(900);
    expect(resolveCaptionStyle({ weight: 100 }).weight).toBe(400);
    expect(resolveCaptionStyle({ maxLines: 9 }).maxLines).toBe(4);
  });

  it("ignores unknown enum values, keeping the default", () => {
    expect(resolveCaptionStyle({ position: "bogus" as never }).position).toBe("lower-third");
    expect(resolveCaptionStyle({ typeface: "comic" as never }).typeface).toBe("sans");
  });

  describe("applyCasing", () => {
    it("upper uppercases every word", () => {
      expect(applyCasing("liberated", "upper", false)).toBe("LIBERATED");
    });
    it("as-written leaves the word untouched", () => {
      expect(applyCasing("Liberated", "as-written", true)).toBe("Liberated");
    });
    it("sentence lowercases, capitalising only the first-in-page word", () => {
      expect(applyCasing("HUMAN", "sentence", true)).toBe("Human");
      expect(applyCasing("BEINGS", "sentence", false)).toBe("beings");
    });
  });

  describe("emphasizedWordIndices", () => {
    const stream = "human beings are not liberated by denying".split(" ").map((word) => ({ word }));
    it("matches a multi-word phrase as a unit, case/punctuation-insensitive", () => {
      const idx = emphasizedWordIndices(stream, ["Are NOT, liberated"]);
      expect([...idx].sort((a, b) => a - b)).toEqual([2, 3, 4]);
    });
    it("returns empty for no phrases or no match", () => {
      expect(emphasizedWordIndices(stream, []).size).toBe(0);
      expect(emphasizedWordIndices(stream, ["nonexistent"]).size).toBe(0);
    });
    it("matches every occurrence of a phrase", () => {
      const s = "go now go now".split(" ").map((word) => ({ word }));
      const idx = emphasizedWordIndices(s, ["go now"]);
      expect([...idx].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    });
  });
});
