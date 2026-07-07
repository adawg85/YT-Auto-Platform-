import { describe, expect, it } from "vitest";
import {
  PATTERN_FRESHNESS_HALF_LIFE_DAYS,
  patternFreshness,
  patternRank,
  patternsToPromptLines,
  rankPatterns,
  type PatternRow,
} from "../src/patterns";

const NOW = new Date("2026-07-01T00:00:00Z");
const DAY = 86_400_000;

function pat(over: Partial<PatternRow> & { id: string }): PatternRow {
  return {
    id: over.id,
    kind: over.kind ?? "hook",
    label: over.label ?? over.id,
    niche: over.niche ?? "everyday science",
    format: over.format ?? "shorts",
    source: over.source ?? "external",
    detail: over.detail ?? {},
    sampleRefs: over.sampleRefs ?? [],
    performanceScore: over.performanceScore ?? 50,
    observations: over.observations ?? 1,
    lastSeen: over.lastSeen ?? NOW,
    createdAt: NOW,
    updatedAt: NOW,
  } as PatternRow;
}

describe("pattern freshness decay", () => {
  it("is ~1.0 the moment it is seen", () => {
    expect(patternFreshness(NOW, NOW)).toBeCloseTo(1, 5);
  });

  it("halves at exactly one half-life", () => {
    const older = new Date(NOW.getTime() - PATTERN_FRESHNESS_HALF_LIFE_DAYS * DAY);
    expect(patternFreshness(older, NOW)).toBeCloseTo(0.5, 2);
  });

  it("never drops below the 0.05 floor", () => {
    const ancient = new Date(NOW.getTime() - 3650 * DAY);
    expect(patternFreshness(ancient, NOW)).toBe(0.05);
  });
});

describe("pattern ranking", () => {
  it("prefers the fresher pattern when scores tie", () => {
    const fresh = pat({ id: "fresh", performanceScore: 80, lastSeen: NOW });
    const stale = pat({ id: "stale", performanceScore: 80, lastSeen: new Date(NOW.getTime() - 60 * DAY) });
    expect(patternRank(fresh, NOW)).toBeGreaterThan(patternRank(stale, NOW));
  });

  it("lets a fresh weaker pattern overtake a strong stale one", () => {
    // 90-score last seen 90d ago vs 60-score seen today
    const stale = pat({ id: "stale", performanceScore: 90, lastSeen: new Date(NOW.getTime() - 90 * DAY) });
    const fresh = pat({ id: "fresh", performanceScore: 60, lastSeen: NOW });
    const ranked = rankPatterns([stale, fresh], NOW);
    expect(ranked[0]!.id).toBe("fresh");
  });

  it("sorts best-first without mutating the input array", () => {
    const rows = [
      pat({ id: "a", performanceScore: 10, lastSeen: NOW }),
      pat({ id: "b", performanceScore: 90, lastSeen: NOW }),
      pat({ id: "c", performanceScore: 50, lastSeen: NOW }),
    ];
    const ranked = rankPatterns(rows, NOW);
    expect(ranked.map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("renders compact grounding lines tagged by source", () => {
    const lines = patternsToPromptLines(
      [pat({ id: "x", label: "open-loop", source: "external", observations: 3 })],
      NOW,
    );
    expect(lines[0]).toContain("open-loop");
    expect(lines[0]).toContain("external");
  });
});
