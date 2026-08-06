import { describe, expect, it } from "vitest";
import { narrationSegments } from "@ytauto/core";
import { chunkText, pieceSlug, planPieceSlugs, type BeatTakeInput } from "./voiceover";

/**
 * #103 — the assembly must give every piece its OWN file.
 *
 * Pieces were named by `beatIdx`, which stopped being unique the moment #101 cut
 * beats into segments: all 9 segments of a beat wrote `raw-3`/`norm-3.wav`, the
 * last one won, and the concat list referenced that single file nine times. The
 * run reported 122 pieces and the audio repeated one take per beat.
 */
describe("assembly piece naming (#103)", () => {
  it("gives segments of the SAME beat different files", () => {
    expect(pieceSlug(0, 3, 0)).not.toBe(pieceSlug(1, 3, 1));
  });

  it("is 1:1 across a realistic segmented script — 14 beats, >100 segments", () => {
    // beats long enough that ~25-word segmentation cuts each into several takes
    const sentence = "The quick brown fox jumped over the lazy dog and kept running. ";
    const beats = Array.from({ length: 14 }, () => ({ text: sentence.repeat(16).trim() }));
    const segments = narrationSegments(beats);
    expect(segments.length).toBeGreaterThan(100);

    const pieces: BeatTakeInput[] = segments.map((s) => ({
      beatIdx: s.beatIdx,
      segIdx: s.segIdx,
      text: s.text,
      takeKey: `productions/p/vo-take-${s.takeIdx}.webm`,
    }));
    const slugs = planPieceSlugs(pieces);

    expect(slugs).toHaveLength(segments.length);
    expect(new Set(slugs).size).toBe(segments.length);
    // the old naming — beatIdx alone — collapsed those pieces to 14 files
    expect(new Set(pieces.map((p) => p.beatIdx)).size).toBe(14);
  });

  it("stays 1:1 on the legacy whole-beat and chunked-TTS shapes (no segIdx)", () => {
    const legacy: BeatTakeInput[] = Array.from({ length: 14 }, (_, beatIdx) => ({
      beatIdx,
      text: `beat ${beatIdx}`,
      segIdx: null,
    }));
    const slugs = planPieceSlugs(legacy);
    expect(new Set(slugs).size).toBe(14);
  });

  it("keeps a legacy whole-beat take distinct from that beat's segment pieces", () => {
    // a partially-migrated script: beat 0 has a pre-#101 take, beat 1 is segmented
    const mixed: BeatTakeInput[] = [
      { beatIdx: 0, text: "whole beat", segIdx: null },
      { beatIdx: 1, text: "first half", segIdx: 0 },
      { beatIdx: 1, text: "second half", segIdx: 1 },
    ];
    expect(new Set(planPieceSlugs(mixed)).size).toBe(3);
  });
});

describe("chunkText (long-form TTS chunking)", () => {
  it("returns a single chunk when under the limit", () => {
    expect(chunkText("Hello world. This is short.", 4500)).toEqual(["Hello world. This is short."]);
  });

  it("returns [] for empty/whitespace", () => {
    expect(chunkText("   ", 4500)).toEqual([]);
  });

  it("splits a long script on sentence boundaries, each chunk <= limit", () => {
    const sentence = "The quick brown fox jumped over the lazy dog. ";
    const text = sentence.repeat(50); // ~2300 chars
    const chunks = chunkText(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
    // no words lost (ignoring whitespace normalisation)
    expect(chunks.join(" ").split(/\s+/).filter(Boolean).length).toBe(
      text.split(/\s+/).filter(Boolean).length,
    );
  });

  it("hard-splits a single over-length sentence on words", () => {
    const longSentence = "word ".repeat(100).trim(); // one 'sentence', no punctuation, ~500 chars
    const chunks = chunkText(longSentence, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
  });
});
