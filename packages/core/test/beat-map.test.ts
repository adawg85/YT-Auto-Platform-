import { describe, expect, it } from "vitest";
import {
  beatDurationsSec,
  beatMapFingerprint,
  beatMapVerdict,
  dateArithmeticClaims,
  estimateBeatMapShotPlan,
  flatRunSpan,
  longestFlatRun,
  payoffBeat,
  payoffPositionPct,
  reviewBeatMapDeterministic,
  selectComparisonMaps,
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
  it("payoffBeat prefers an explicit marker, else the last heroShot, else null (#69)", () => {
    // explicit marker wins — the FIRST marked beat, named with index + %
    const marked = mk(["hook", "insight", "insight", "stat", "cta"]);
    marked.beats[2]!.payoff = true;
    const pm = payoffBeat(marked);
    expect(pm).not.toBeNull();
    expect(pm!.index).toBe(2);
    expect(pm!.source).toBe("marker");
    expect(payoffPositionPct(marked)).toBe(pm!.pct); // back-compat wrapper agrees

    // no marker → last heroShot
    const hero = mk(["hook", "insight", "insight", "stat", "cta"]);
    hero.beats[3]!.heroShot = true;
    const ph = payoffBeat(hero);
    expect(ph!.index).toBe(3);
    expect(ph!.source).toBe("hero");

    // neither marker nor hero → null (no false ~99% on a fine map full of insight/stat)
    expect(payoffBeat(mk(["hook", "insight", "insight", "stat", "cta"]))).toBeNull();
  });

  it("#82 beatDurationsSec: per-beat timingSec is used verbatim, cumulative is delta'd", () => {
    // PER-BEAT durations (sum ≈ runtime) — the shape an author supplies. Old code
    // treated them as cumulative and made the last beat absorb the whole tail.
    const perBeat: BeatMap = {
      title: "T",
      hookLine: "h",
      targetLengthSec: 1020,
      beats: Array.from({ length: 31 }, (_, i) => ({
        type: i === 0 ? "hook" : [7, 13, 21].includes(i) ? "rehook" : "insight",
        summary: `beat ${i} words here now`,
        timingSec: 1020 / 31, // ~32.9s each; sum ≈ 1020 (not > 1.3×) → per-beat
      })),
    };
    const durs = beatDurationsSec(perBeat)!;
    // every beat keeps its ~33s — no beat balloons to ~the runtime
    expect(Math.max(...durs)).toBeLessThan(50);
    // CUMULATIVE offsets (monotonic, sum ≫ runtime) → deltas, last extends to runtime
    const cumulative: BeatMap = {
      title: "T",
      hookLine: "h",
      targetLengthSec: 400,
      beats: [0, 100, 200, 300].map((t, i) => ({ type: i === 0 ? "hook" : "insight", summary: `b${i} w w w`, timingSec: t })),
    };
    expect(beatDurationsSec(cumulative)).toEqual([100, 100, 100, 100]);
  });

  it("#82 flat_run reports the SPAN's elapsed time (~5 min), not the whole runtime, with a clean ~3.5 min interval", () => {
    // 31 beats, 1020s, last rehook at index 21 → beats 22..30 (9 beats) are the tail run.
    const m: BeatMap = {
      title: "T",
      hookLine: "h",
      targetLengthSec: 1020,
      beats: Array.from({ length: 31 }, (_, i) => ({
        type: i === 0 ? "hook" : [7, 13, 21].includes(i) ? "rehook" : "insight",
        summary: `beat ${i} words here now`,
        timingSec: 1020 / 31,
      })),
    };
    const flat = flatRunSpan(m);
    expect(flat.length).toBe(9);
    expect(flat.elapsedSec!).toBeGreaterThan(250);
    expect(flat.elapsedSec!).toBeLessThan(340); // ~5 min, NOT ~1020s
    const rc = reviewBeatMapDeterministic(m);
    const f = rc.advisoryFindings.find((x) => x.rule === "flat_run");
    expect(f).toBeDefined();
    expect(f!.evidence).toContain("~3.5 min"); // was "~4-4 min"
    expect(f!.evidence).not.toContain("-4 min");
    expect(f!.evidence).not.toContain("16.8"); // no longer the whole runtime
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

  it("payoff_position + flat_run key on intent and elapsed time, not position/count (#69)", () => {
    // A COARSE map: 8 long beats (300s / 8 ≈ 37.5s each), a late heroShot payoff.
    // The flat run 1..7 is ~262s > 210s → flat_run fires; hero at 7/7 = 100% > 70% → payoff fires.
    const coarse: BeatMap = {
      title: "C",
      hookLine: "h",
      targetLengthSec: 300,
      beats: Array.from({ length: 8 }, (_, i) => ({
        type: i === 0 ? "hook" : "insight",
        summary: Array.from({ length: 90 }, () => "word").join(" "),
        heroShot: i === 7,
      })),
    };
    const rc = reviewBeatMapDeterministic(coarse);
    expect(rc.advisoryFindings.some((f) => f.rule === "flat_run")).toBe(true);
    expect(rc.advisoryFindings.some((f) => f.rule === "payoff_position")).toBe(true);

    // A FINE map of the SAME 300s cut into 40 short beats: the longest flat run is
    // many beats but only ~a couple minutes — under the re-hook interval, so
    // flat_run must NOT fire (the old beat-count rule fired here; that was the bug).
    const fine: BeatMap = {
      title: "F",
      hookLine: "h",
      targetLengthSec: 300,
      beats: Array.from({ length: 40 }, (_, i) => ({
        type: i === 0 ? "hook" : i % 12 === 0 ? "rehook" : "insight",
        summary: Array.from({ length: 18 }, () => "word").join(" "),
      })),
    };
    const rf = reviewBeatMapDeterministic(fine);
    expect(rf.advisoryFindings.some((f) => f.rule === "flat_run")).toBe(false);
    // no payoff marker and no heroShot on the fine map → payoff_position silent (no false ~99%)
    expect(rf.advisoryFindings.some((f) => f.rule === "payoff_position")).toBe(false);
  });

  it("#73: minSecondsPerShot lowers estimatedShots below the density floor", () => {
    const map: BeatMap = {
      title: "hold",
      hookLine: "h",
      targetLengthSec: 1200,
      beats: Array.from({ length: 60 }, (_, i) => ({ type: i === 0 ? "hook" : "insight", summary: "a b c d e" })),
    };
    const base = { rhythm: "section" as const, motion: "static" as const, imageDensity: "relaxed" as const, maxAiClips: 0 };
    const relaxed = estimateBeatMapShotPlan(map, base, { isLong: true });
    const longHold = estimateBeatMapShotPlan(map, { ...base, minSecondsPerShot: 24 }, { isLong: true });
    // relaxed floor ~11s → ~107 shot-slots (beats over-split); a 24s hold → ~50,
    // clamped up to the 60 beats. Strictly fewer, and no beat is over-split.
    expect(relaxed.estimatedShots).toBeGreaterThan(map.beats.length);
    expect(longHold.estimatedShots).toBeLessThan(relaxed.estimatedShots);
    expect(longHold.estimatedShots).toBe(map.beats.length);
  });

  it("#69: shotEstimate reports entity coverage; referenceEntities raises it", () => {
    const base = (extra: Partial<BeatMap["beats"][number]>) => ({
      type: "insight" as const,
      summary: "a b c d e",
      ...extra,
    });
    const profile = { rhythm: "section" as const, motion: "static" as const, imageDensity: "relaxed" as const, minSecondsPerShot: 8, maxAiClips: 0 };
    // 20 beats over 400s; at an 8s floor ~50 shots but one entity per beat = 20 briefs.
    const single: BeatMap = {
      title: "single",
      hookLine: "h",
      targetLengthSec: 400,
      beats: Array.from({ length: 20 }, (_, i) => base({ referenceEntity: `painting ${i}` })),
    };
    const est1 = estimateBeatMapShotPlan(single, profile, { isLong: true });
    expect(est1.suppliedEntities).toBe(20);
    expect(est1.entityCoverage).toBeLessThan(1);
    expect(est1.notes.some((n) => /coverage/.test(n))).toBe(true);
    // same beats, but each supplies 3 ordered briefs → 60 distinct, full coverage
    const many: BeatMap = {
      ...single,
      beats: Array.from({ length: 20 }, (_, i) =>
        base({ referenceEntities: [`painting ${i}a`, `painting ${i}b`, `painting ${i}c`] }),
      ),
    };
    const est2 = estimateBeatMapShotPlan(many, profile, { isLong: true });
    expect(est2.suppliedEntities).toBe(60);
    expect(est2.entityCoverage).toBeGreaterThan(est1.entityCoverage);
    expect(est2.entityCoverage).toBe(1);
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

  describe("selectComparisonMaps (ticket 01KY62TW… — same-episode redrafts excluded)", () => {
    const A1 = mk(["hook", "stat"], { title: "A draft 1" });
    const A2 = mk(["hook", "stat", "insight"], { title: "A draft 2" });
    const B1 = mk(["hook", "cta"], { title: "B draft 1" });

    it("excludes prior drafts of the SAME idea", () => {
      // rows newest-first: A2 (current episode's earlier draft), then B1, then A1
      const rows = [
        { map: A2, ideaId: "ideaA" },
        { map: B1, ideaId: "ideaB" },
        { map: A1, ideaId: "ideaA" },
      ];
      const out = selectComparisonMaps(rows, "ideaA");
      expect(out).toEqual([B1]); // only the OTHER episode; both A drafts dropped
    });

    it("keeps only the latest map per OTHER episode", () => {
      const rows = [
        { map: B1, ideaId: "ideaB" }, // latest for B
        { map: mk(["hook"], { title: "B older" }), ideaId: "ideaB" },
      ];
      const out = selectComparisonMaps(rows, "ideaC");
      expect(out).toEqual([B1]);
    });

    it("counts legacy rows with no ideaId individually", () => {
      const L1 = mk(["hook"], { title: "legacy 1" });
      const L2 = mk(["stat"], { title: "legacy 2" });
      const out = selectComparisonMaps([{ map: L1, ideaId: null }, { map: L2, ideaId: null }], "ideaA");
      expect(out).toEqual([L1, L2]);
    });

    it("with no ideaId supplied, still collapses other episodes to latest but keeps everything comparable", () => {
      const rows = [
        { map: A2, ideaId: "ideaA" },
        { map: B1, ideaId: "ideaB" },
        { map: A1, ideaId: "ideaA" },
      ];
      const out = selectComparisonMaps(rows, null);
      expect(out).toEqual([A2, B1]); // A collapses to its latest (A2); A1 dropped
    });
  });
});
