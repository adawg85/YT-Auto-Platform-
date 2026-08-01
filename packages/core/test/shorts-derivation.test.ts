import { describe, expect, it } from "vitest";
import {
  planEvenWindows,
  snapWindowsToWords,
  SHORT_MAX_SEC,
  SHORT_MIN_SEC,
} from "../src/shorts-derivation";
import type { WordTimestamp } from "@ytauto/db";

describe("planEvenWindows (even-split cut planner)", () => {
  it("count wins: N contiguous windows that tile the runtime when slot fits", () => {
    // 20-min video, 20 parts → 20 × 60s contiguous
    const w = planEvenWindows({ durationSec: 1200, count: 20 });
    expect(w).toHaveLength(20);
    expect(w[0]).toMatchObject({ index: 0, startSec: 0, endSec: 60, label: "Part 1" });
    expect(w[19]).toMatchObject({ index: 19, startSec: 1140, endSec: 1200, label: "Part 20" });
    // contiguous, no gaps
    for (let i = 1; i < w.length; i++) expect(w[i]!.startSec).toBeCloseTo(w[i - 1]!.endSec, 1);
  });

  it("avgLengthSec derives the count", () => {
    // 20 min at ~90s each → ~13 windows
    const w = planEvenWindows({ durationSec: 1200, avgLengthSec: 90 });
    expect(w.length).toBe(Math.round(1200 / 90));
    for (const win of w) expect(win.endSec - win.startSec).toBeLessThanOrEqual(SHORT_MAX_SEC + 0.1);
  });

  it("caps each window at the 180s Shorts limit and spreads them across the video", () => {
    // 20 min, 3 parts → slots are 400s (can't be Shorts); each window is 180s, CENTERED
    const w = planEvenWindows({ durationSec: 1200, count: 3 });
    expect(w).toHaveLength(3);
    for (const win of w) expect(win.endSec - win.startSec).toBeCloseTo(SHORT_MAX_SEC, 1);
    // centered in each 400s slot → spread across the whole runtime, not clustered at the start
    expect(w[0]!.startSec).toBeCloseTo((400 - 180) / 2, 1); // 110
    expect(w[2]!.startSec).toBeGreaterThan(800);
  });

  it("never yields more Shorts than the runtime supports at the minimum length", () => {
    // 45s video, asked for 20 → floor(45/10) = 4 max
    const w = planEvenWindows({ durationSec: 45, count: 20 });
    expect(w.length).toBe(Math.floor(45 / SHORT_MIN_SEC));
    for (const win of w) expect(win.endSec - win.startSec).toBeGreaterThanOrEqual(SHORT_MIN_SEC - 0.1);
  });

  it("returns nothing for a runtime shorter than the minimum", () => {
    expect(planEvenWindows({ durationSec: 5 })).toEqual([]);
  });

  it("falls back to ~60s windows when no knob is given", () => {
    const w = planEvenWindows({ durationSec: 600 });
    expect(w.length).toBe(10); // 600 / 60
  });

  it("windows stay within [0, duration] and are ordered", () => {
    const w = planEvenWindows({ durationSec: 1200, count: 7 });
    for (const win of w) {
      expect(win.startSec).toBeGreaterThanOrEqual(0);
      expect(win.endSec).toBeLessThanOrEqual(1200);
      expect(win.endSec).toBeGreaterThan(win.startSec);
    }
    for (let i = 1; i < w.length; i++) expect(w[i]!.startSec).toBeGreaterThanOrEqual(w[i - 1]!.startSec);
  });
});

describe("snapWindowsToWords (cuts land on word boundaries, not mid-word)", () => {
  const words: WordTimestamp[] = [
    { word: "the", startSec: 0.0, endSec: 0.3 },
    { word: "shadow", startSec: 0.3, endSec: 0.9 },
    { word: "you", startSec: 30.1, endSec: 30.4 },
    { word: "carry", startSec: 30.4, endSec: 31.2 },
    { word: "is", startSec: 59.6, endSec: 59.9 },
    { word: "yours", startSec: 59.9, endSec: 60.8 },
  ];

  it("snaps start to the nearest word start and end to the nearest word end", () => {
    const [win] = snapWindowsToWords([{ index: 0, startSec: 30.0, endSec: 60.0, label: "Part 1" }], words);
    expect(win!.startSec).toBe(30.1); // "you".start, not the 30.0 mid-gap target
    // end snaps to the nearest word END: "is" (59.9) is closer to 60.0 than "yours"
    // (60.8), so the cut lands cleanly after "is" and excludes the straddling word.
    expect(win!.endSec).toBe(59.9);
  });

  it("leaves windows unchanged when there are no word timestamps", () => {
    const win = { index: 0, startSec: 12.3, endSec: 45.6, label: "Part 1" };
    expect(snapWindowsToWords([win], [])).toEqual([win]);
  });

  it("keeps the original window if snapping would collapse it below the minimum", () => {
    // both boundaries snap to the same early word cluster → sub-min → keep original
    const win = { index: 0, startSec: 0.1, endSec: 0.8, label: "Part 1" };
    expect(snapWindowsToWords([win], words)).toEqual([win]);
  });
});
