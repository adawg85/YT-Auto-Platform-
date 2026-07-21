import { describe, expect, it } from "vitest";
import {
  beatMapFingerprint,
  beatMapVerdict,
  dateArithmeticClaims,
  flatRunSpan,
  longestFlatRun,
  payoffBeat,
  payoffPositionPct,
  reviewBeatMapDeterministic,
  structuralSimilarity,
  type BeatMap,
} from "../src/beat-map";

const mk = (types: string[], over: Partial<BeatMap> = {}): BeatMap => ({
  title: "T",
  hookLine: "hook",
  targetLengthSec: 300,
  beats: types.map((t, i) => ({ type: t, summary: `beat ${i} words here now`, heroShot: t === "insight" && i > 3 })),
  ...over,
});

describe("named findings (ticket 01KY29ZW…)", () => {
  it("payoffBeat names the index and % (not just a bare %)", () => {
    const map = mk(["hook", "insight", "insight", "stat", "cta"]);
    const p = payoffBeat(map);
    expect(p).not.toBeNull();
    expect(p!.index).toBe(3); // last stat/insight/hero
    expect(payoffPositionPct(map)).toBe(p!.pct); // back-compat wrapper agrees
  });

  it("flatRunSpan names the start/end beats and 'rehook' breaks the run", () => {
    // hook, then 6 flat beats — one long run from beat 1..6
    const flat = flatRunSpan(mk(["hook", "insight", "insight", "insight", "insight", "insight", "insight"]));
    expect(flat.start).toBe(1);
    expect(flat.end).toBe(6);
    expect(flat.length).toBe(6);
    expect(longestFlatRun(mk(["hook", "insight", "insight"]))).toBe(2); // back-compat
    // a rehook mid-way resets the run
    const withRehook = flatRunSpan(mk(["hook", "insight", "insight", "rehook", "insight", "insight"]));
    expect(withRehook.length).toBe(2);
  });
});

describe("beat-map structural checks (ticket 01KY1Y9E…)", () => {
  it("fingerprint ignores surface text — same shape, same fingerprint", () => {
    const a = mk(["hook", "stat", "insight", "cta"]);
    const b = mk(["hook", "stat", "insight", "cta"], { title: "Different topic", hookLine: "x" });
    expect(beatMapFingerprint(a)).toBe(beatMapFingerprint(b));
  });

  it("structuralSimilarity is high for same-shape maps, low for different shapes", () => {
    const a = mk(["hook", "stat", "insight", "insight", "cta"]);
    const b = mk(["hook", "stat", "insight", "insight", "cta"], { title: "Other" });
    const c = mk(["hook", "rehook", "cta"]);
    expect(structuralSimilarity(a, b)).toBeGreaterThanOrEqual(0.85);
    expect(structuralSimilarity(a, c)).toBeLessThan(0.5);
  });

  it("BLOCKS on cross-video structural repetition", () => {
    const map = mk(["hook", "stat", "insight", "insight", "cta"]);
    const recent = [mk(["hook", "stat", "insight", "insight", "cta"], { title: "Prev" })];
    const r = reviewBeatMapDeterministic(map, { recentMaps: recent });
    expect(r.blockingFindings.some((f) => f.rule === "structural_repetition")).toBe(true);
    expect(beatMapVerdict(r)).toBe("block");
  });

  it("BLOCKS on word budget outside the band", () => {
    // target 300s * 2.5 = 750 words; give ~40 → far under
    const map = mk(["hook", "stat", "cta"]);
    const r = reviewBeatMapDeterministic(map);
    expect(r.blockingFindings.some((f) => f.rule === "word_budget")).toBe(true);
  });

  it("passes a well-formed, distinct map", () => {
    const beats = Array.from({ length: 19 }, (_, i) => ({
      type: i === 0 ? "hook" : i % 6 === 0 ? "rehook" : i === 18 ? "cta" : "insight",
      summary: Array.from({ length: 40 }, () => "word").join(" "),
      heroShot: i === 11,
    }));
    const map: BeatMap = { title: "Distinct", hookLine: "h", targetLengthSec: 300, beats };
    const r = reviewBeatMapDeterministic(map, { recentMaps: [mk(["hook", "cta"])] });
    expect(r.blockingFindings).toHaveLength(0);
  });

  it("payoff position + flat run advisories", () => {
    const beats = Array.from({ length: 10 }, (_, i) => ({ type: i === 0 ? "hook" : i === 9 ? "insight" : "stat", summary: "a b c" }));
    const map: BeatMap = { title: "P", hookLine: "h", targetLengthSec: 60, beats };
    expect(payoffPositionPct(map)).toBe(100);
    expect(longestFlatRun(map)).toBeGreaterThanOrEqual(8);
  });

  it("flags date-arithmetic phrases for verification", () => {
    const map = mk(["hook"]);
    map.beats[0]!.summary = "It has been twenty-five years since the first flight";
    expect(dateArithmeticClaims(map).length).toBeGreaterThan(0);
  });

  it("advises when one referenceEntity dominates many beats (ticket 01KY1ZNP…)", () => {
    const beats = Array.from({ length: 19 }, (_, i) => ({
      type: i === 0 ? "hook" : i === 18 ? "cta" : "insight",
      summary: Array.from({ length: 40 }, () => "word").join(" "),
      referenceEntity: i < 11 ? "Lockheed SR-71 Blackbird" : undefined,
    }));
    const map: BeatMap = { title: "SR-71", hookLine: "h", targetLengthSec: 300, beats };
    const r = reviewBeatMapDeterministic(map);
    expect(r.advisoryFindings.some((f) => f.rule === "repeated_entity")).toBe(true);
  });
});
