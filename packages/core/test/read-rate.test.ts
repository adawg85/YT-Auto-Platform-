import { describe, expect, it } from "vitest";
import {
  DEFAULT_READ_RATE,
  READ_RATE_MIN_SAMPLES,
  fitReadRate,
  resolveReadRate,
  type ReadRateSample,
} from "../src/read-rate";
import { WORDS_PER_SEC, estimateMapSegments, reviewBeatMapDeterministic, type BeatMap } from "../src/beat-map";

// #120 — the ticket's own measurement: three assembled operator takes on
// Wings & Stories, all Whisper-aligned, pooling to 2.89 w/s against the 2.5
// constant the gate assumed (a 16% under-read → ~14%-short videos, enforced).
const TICKET_SAMPLES: ReadRateSample[] = [
  { words: 214, durationSec: 72.66, segments: 11 }, // B-17 All American (2.95 w/s)
  { words: 236, durationSec: 77.64, segments: 11 }, // F-106 Montana (3.04)
  { words: 290, durationSec: 105.9, segments: 19 }, // Alkemade (2.74 — beat-dense)
];

describe("fitReadRate", () => {
  it("recovers the operator's real rate from the ticket's three samples", () => {
    const fit = fitReadRate(TICKET_SAMPLES)!;
    // the 2-param solve on these three points decomposes into 4.14 w/s +
    // 1.9s/segment — a perfect reproduction of the data but an implausible gap
    // (it's absorbing slower delivery, and would overshoot sparse maps), so
    // the guard rejects it and the honest model is the ticket's POOLED 2.89
    expect(fit.wordsPerSec).toBe(2.89);
    expect(fit.segmentGapSec).toBe(0);
  });

  it("fits a genuine small per-segment gap when the samples support one", () => {
    // synthesised from a true 3.0 w/s speaking rate + 0.5s/segment
    const fit = fitReadRate([
      { words: 300, durationSec: 105, segments: 10 },
      { words: 150, durationSec: 60, segments: 20 },
      { words: 240, durationSec: 84, segments: 8 },
    ])!;
    expect(fit.wordsPerSec).toBeCloseTo(3.0, 1);
    expect(fit.segmentGapSec).toBeCloseTo(0.5, 1);
  });

  it("degrades to the pooled rate when the 2-param solve is degenerate", () => {
    // identical rows → singular normal equations → pooled
    const same: ReadRateSample = { words: 250, durationSec: 100, segments: 10 };
    const fit = fitReadRate([same, same, same])!;
    expect(fit.wordsPerSec).toBe(2.5);
    expect(fit.segmentGapSec).toBe(0);
  });

  it("rejects implausible fits instead of trusting them", () => {
    // absurd data (5 words over 300s) is outside any human range → null
    expect(fitReadRate([{ words: 5, durationSec: 300, segments: 2 }])).toBeNull();
    expect(fitReadRate([])).toBeNull();
  });
});

describe("resolveReadRate — evidence gating", () => {
  it("channel samples win when the floor is met", () => {
    const r = resolveReadRate(TICKET_SAMPLES, []);
    expect(r.basis).toBe("operator_measured");
    expect(r.sampleProductions).toBe(3);
    expect(r.wordsPerSec).toBeGreaterThan(WORDS_PER_SEC);
  });

  it("falls back to the platform pool for a cold-start channel (same narrator)", () => {
    // Dog-Eared: zero own samples, Wings & Stories has three one channel over
    const r = resolveReadRate([], TICKET_SAMPLES);
    expect(r.basis).toBe("operator_platform");
    expect(r.wordsPerSec).toBeGreaterThan(WORDS_PER_SEC);
  });

  it("below the sample floor everywhere, the 2.5 default stands", () => {
    const two = TICKET_SAMPLES.slice(0, READ_RATE_MIN_SAMPLES - 1);
    expect(resolveReadRate(two, two)).toEqual(DEFAULT_READ_RATE);
    expect(resolveReadRate([], [])).toEqual(DEFAULT_READ_RATE);
  });
});

describe("word_budget at the measured rate (the ticket's reproduction)", () => {
  // Dog-Eared: targetLengthSec 55, a 168-word map — BLOCKED at 2.5 w/s
  // (target 138, band 110-166) despite being the map that would hit 55s at
  // the operator's real 2.89.
  const map = (words: number): BeatMap => ({
    title: "repro",
    hookLine: "h",
    targetLengthSec: 55,
    beats: [
      { type: "hook", summary: "s", wordBudget: Math.round(words / 2) },
      { type: "insight", summary: "s", wordBudget: Math.round(words / 2) },
    ],
  });

  it("accepts the 168-word map once the measured rate applies", () => {
    const { blockingFindings } = reviewBeatMapDeterministic(map(168), {
      readRate: { wordsPerSec: 2.89, segmentGapSec: 0, basis: "operator_measured" },
    });
    expect(blockingFindings.filter((f) => f.rule === "word_budget")).toEqual([]);
  });

  it("still blocks the same map at the 2.5 default (unchanged behaviour)", () => {
    const { blockingFindings } = reviewBeatMapDeterministic(map(168), {});
    expect(blockingFindings.some((f) => f.rule === "word_budget")).toBe(true);
  });

  it("rejects a 2.5-sized map when the measured rate differs materially", () => {
    // at 3.5 w/s a 55s target wants ~193 words; a 138-word (2.5-sized) map is
    // 28% under — outside the band, so the gate now catches the SHORT map
    const { blockingFindings } = reviewBeatMapDeterministic(map(138), {
      readRate: { wordsPerSec: 3.5, segmentGapSec: 0, basis: "operator_measured" },
    });
    const f = blockingFindings.find((x) => x.rule === "word_budget");
    expect(f).toBeDefined();
    expect(f!.evidence).toMatch(/3\.5 w\/s/); // the rate is named, not inferred
  });

  it("the per-segment gap allowance shrinks the speaking budget for dense maps", () => {
    // 55s at 2.89 with 0.5s/segment across ~7 segments → ~51.5s of speaking
    const dense = map(168);
    const segs = estimateMapSegments(dense);
    expect(segs).toBeGreaterThan(0);
    const { blockingFindings } = reviewBeatMapDeterministic(map(190), {
      readRate: { wordsPerSec: 2.89, segmentGapSec: 0.5, basis: "operator_measured" },
    });
    // 190 words would pass a gapless 2.89 budget (band tops ~191) but the gap
    // allowance lowers the target, pushing 190 out the top of the band
    expect(blockingFindings.some((f) => f.rule === "word_budget")).toBe(true);
  });
});
