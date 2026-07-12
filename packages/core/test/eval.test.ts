import { describe, expect, it } from "vitest";
import { aiTellMetrics, clampScore } from "../src/eval";

describe("aiTellMetrics", () => {
  it("counts AI-tell phrases case-insensitively, including repeats", () => {
    const m = aiTellMetrics(
      "This isn't just a plane. Let's explore why. It really isn't just fast — it's a Game-Changer.",
    );
    expect(m.aiTellCount).toBe(4); // isn't just ×2, let's explore, game-changer
  });

  it("computes em-dash density per 100 words", () => {
    const words = Array.from({ length: 50 }, (_, i) => `w${i}`).join(" ");
    const m = aiTellMetrics(`${words} — and — more`);
    // standalone em-dashes are whitespace-separated tokens: 50 + 4 words
    expect(m.words).toBe(54);
    expect(m.emDashPer100Words).toBeCloseTo((2 / 54) * 100, 1);
  });

  it("measures sentence-length variance (uniform lengths → 0 stdev)", () => {
    const uniform = aiTellMetrics("One two three. Four five six. Seven eight nine.");
    expect(uniform.sentences).toBe(3);
    expect(uniform.sentenceLenStdev).toBe(0);
    const varied = aiTellMetrics("Short. This one runs quite a bit longer than the first. Mid one here.");
    expect(varied.sentenceLenStdev).toBeGreaterThan(0);
  });

  it("handles empty text without dividing by zero", () => {
    const m = aiTellMetrics("");
    expect(m).toEqual({
      aiTellCount: 0,
      emDashPer100Words: 0,
      sentences: 0,
      sentenceLenStdev: 0,
      words: 0,
    });
  });
});

describe("clampScore", () => {
  it("clamps into 0-10 and rounds to one decimal", () => {
    expect(clampScore(11.7)).toBe(10);
    expect(clampScore(-3)).toBe(0);
    expect(clampScore(7.4499)).toBe(7.4);
  });
});
