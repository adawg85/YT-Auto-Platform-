import { describe, expect, it } from "vitest";
import {
  SEGMENT_TAKE_BASE,
  decodeTakeIdx,
  narrationSegments,
  segmentTakeIdx,
  splitNarrationSegments,
} from "../src/narration-segments";

// a real beat from The Lost Books Ep 2 — 51 words, the size that made a single
// take a chore
const BEAT =
  "In Carthage, around the year 200, a man sat down to write a furious book about women's jewellery. " +
  "He was not interested in fashion. He was interested in where the jewellery came from. " +
  "And the answer, he believed, was written in a book that most of his contemporaries had already begun to forget.";

describe("splitNarrationSegments — never mid-sentence", () => {
  it("THE INVARIANT: concatenating the segments reproduces the text exactly", () => {
    for (const target of [10, 25, 40, 200]) {
      expect(splitNarrationSegments(BEAT, target).join(" ")).toBe(BEAT);
    }
  });

  it("every segment ends on terminal punctuation — no seam inside a sentence", () => {
    for (const seg of splitNarrationSegments(BEAT, 25)) {
      expect(seg.trim()).toMatch(/[.!?]["')\]]*$/);
    }
  });

  it("breaks a 51-word beat into several ~25-word takes", () => {
    const segs = splitNarrationSegments(BEAT, 25);
    expect(segs.length).toBeGreaterThan(1);
    // the whole point: no take is the full paragraph any more
    for (const s of segs) expect(s.split(/\s+/).length).toBeLessThan(45);
  });

  it("groups short sentences instead of making a card per fragment", () => {
    const chatty = "It failed. It failed again. Nobody noticed. The third attempt worked.";
    // all four fit inside 25 words, so they stay as ONE take
    expect(splitNarrationSegments(chatty, 25)).toEqual([chatty]);
  });

  it("NEVER splits a single over-long sentence — it stands alone", () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ") + ".";
    const segs = splitNarrationSegments(long, 25);
    expect(segs).toEqual([long]);
  });

  it("does not break on abbreviations, initials or decimals", () => {
    const tricky = "Dr. Mensah measured 3.5 metres of it. J. R. R. Tolkien disagreed, etc. That was that.";
    const segs = splitNarrationSegments(tricky, 25);
    expect(segs.join(" ")).toBe(tricky);
    // "Dr." / "3.5" / "J." / "etc." must not have created their own takes
    for (const s of segs) expect(s.split(/\s+/).length).toBeGreaterThan(2);
  });

  it("handles empty and whitespace-only narration", () => {
    expect(splitNarrationSegments("")).toEqual([]);
    expect(splitNarrationSegments("   \n ")).toEqual([]);
  });

  it("keeps question and exclamation boundaries", () => {
    const mixed = "Did it survive? It did. Nobody knows how!";
    // target 1 forces one sentence per take, so the boundaries are visible
    expect(splitNarrationSegments(mixed, 1)).toEqual(["Did it survive?", "It did.", "Nobody knows how!"]);
    // and at a realistic target the short ones group, which is the intent
    expect(splitNarrationSegments(mixed, 5)).toEqual(["Did it survive? It did.", "Nobody knows how!"]);
  });
});

describe("take idx encoding — a segment take can never clobber a legacy one", () => {
  it("round-trips beat + segment", () => {
    for (const [b, sg] of [[0, 0], [3, 7], [31, 12], [999, 999]] as const) {
      expect(decodeTakeIdx(segmentTakeIdx(b, sg))).toEqual({ beatIdx: b, segIdx: sg });
    }
  });

  it("legacy per-beat indices decode as whole-beat takes", () => {
    // recorded before segments shipped: idx WAS the beat index
    expect(decodeTakeIdx(0)).toEqual({ beatIdx: 0, segIdx: null });
    expect(decodeTakeIdx(31)).toEqual({ beatIdx: 31, segIdx: null });
  });

  it("segment indices sit clear of every plausible legacy index", () => {
    // beat 0 / segment 0 must not collide with legacy beat 0
    expect(segmentTakeIdx(0, 0)).toBe(SEGMENT_TAKE_BASE);
    expect(segmentTakeIdx(0, 0)).toBeGreaterThan(10_000);
  });

  it("orders correctly across beats and segments", () => {
    const ids = [segmentTakeIdx(0, 0), segmentTakeIdx(0, 1), segmentTakeIdx(1, 0), segmentTakeIdx(2, 3)];
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });
});

describe("narrationSegments — the recorder's card list", () => {
  it("flattens beats in reading order with stable take ids", () => {
    const segs = narrationSegments([{ text: "One. Two." }, { text: "Three." }], 1);
    expect(segs.map((s) => s.text)).toEqual(["One.", "Two.", "Three."]);
    expect(segs.map((s) => [s.beatIdx, s.segIdx])).toEqual([[0, 0], [0, 1], [1, 0]]);
    expect(segs.map((s) => s.takeIdx)).toEqual([
      segmentTakeIdx(0, 0),
      segmentTakeIdx(0, 1),
      segmentTakeIdx(1, 0),
    ]);
  });

  it("skips empty beats without shifting the beat numbering", () => {
    const segs = narrationSegments([{ text: "A." }, { text: "" }, { text: "C." }]);
    expect(segs.map((s) => s.beatIdx)).toEqual([0, 2]);
  });
});
