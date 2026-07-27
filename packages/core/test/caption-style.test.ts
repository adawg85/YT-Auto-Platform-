import { describe, expect, it } from "vitest";
import {
  resolveCaptionStyle,
  isDefaultCaptionStyle,
  applyCasing,
  emphasizedWordIndices,
} from "../src/caption-style";

describe("caption-style (#72)", () => {
  it("resolves prior-behaviour defaults, and flags them as default", () => {
    const r = resolveCaptionStyle(null);
    expect(r).toMatchObject({
      position: "lower-third",
      casing: "as-written",
      typeface: "sans",
      weight: 800,
      outline: false,
      emphasisColor: null,
    });
    expect(isDefaultCaptionStyle(r)).toBe(true);
  });

  it("a set style is not the default (renderer takes the new path)", () => {
    expect(isDefaultCaptionStyle(resolveCaptionStyle({ position: "center", casing: "upper" }))).toBe(false);
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
