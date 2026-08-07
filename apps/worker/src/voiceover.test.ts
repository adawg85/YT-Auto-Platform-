import { describe, expect, it } from "vitest";
import { narrationSegments } from "@ytauto/core";
import type { WordTimestamp } from "@ytauto/providers";
import { alignScriptToAsr, chunkText, pieceSlug, planPieceSlugs, type BeatTakeInput } from "./voiceover";

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

/**
 * Forced alignment (#103 follow-up): Whisper supplies TIMINGS, the script
 * supplies WORDS. Before this, the ASR transcript replaced the operator's
 * writing — one surname came through as Fuscone/Foscone/Fuscoen/Fusco, "Housel's
 * account" as "households account", and those words are what the render burns as
 * captions and what each shot reports as its narration.
 */
describe("alignScriptToAsr — the script's words, Whisper's timings", () => {
  const asr = (pairs: [string, number, number][]): WordTimestamp[] =>
    pairs.map(([word, startSec, endSec]) => ({ word, startSec, endSec }));

  it("THE CASE: a mis-heard proper noun keeps the SCRIPT spelling", () => {
    const out = alignScriptToAsr(
      "Fuscone borrowed heavily",
      asr([["Foscone", 0, 0.5], ["borrowed", 0.5, 1], ["heavily", 1, 1.5]]),
      { offsetSec: 0, durationSec: 1.5 },
    );
    expect(out.map((w) => w.word)).toEqual(["Fuscone", "borrowed", "heavily"]);
    // and it inherits the ASR timing of the word it was heard as
    expect(out[0]).toMatchObject({ startSec: 0, endSec: 0.5 });
  });

  it("keeps punctuation and casing the script had and the ASR dropped", () => {
    const out = alignScriptToAsr(
      "By Housel's account, Tails drive everything.",
      asr([["by", 0, 0.2], ["households", 0.2, 0.8], ["account", 0.8, 1.2], ["Tales", 1.2, 1.6], ["drive", 1.6, 1.9], ["everything", 1.9, 2.3]]),
      { offsetSec: 0, durationSec: 2.3 },
    );
    expect(out.map((w) => w.word).join(" ")).toBe("By Housel's account, Tails drive everything.");
  });

  it("timings stay monotonic and inside the piece when the ASR DROPS words", () => {
    const out = alignScriptToAsr(
      "the market fell over twenty percent in a single day",
      // ASR missed "twenty percent" entirely
      asr([["the", 0, 0.2], ["market", 0.2, 0.5], ["fell", 0.5, 0.8], ["over", 0.8, 1.0], ["in", 2.0, 2.2], ["a", 2.2, 2.3], ["single", 2.3, 2.7], ["day", 2.7, 3.0]]),
      { offsetSec: 0, durationSec: 3 },
    );
    expect(out).toHaveLength(10);
    expect(out.map((w) => w.word)).toContain("percent");
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.startSec).toBeGreaterThanOrEqual(out[i - 1]!.startSec - 1e-9);
    }
    expect(out[0]!.startSec).toBeGreaterThanOrEqual(0);
    expect(out[out.length - 1]!.endSec).toBeLessThanOrEqual(3 + 1e-9);
  });

  it("drops words the ASR INVENTED rather than letting them into the captions", () => {
    const out = alignScriptToAsr(
      "temperament beats intelligence",
      asr([["temperament", 0, 0.6], ["um", 0.6, 0.7], ["beats", 0.7, 1.1], ["uh", 1.1, 1.2], ["intelligence", 1.2, 1.9]]),
      { offsetSec: 0, durationSec: 1.9 },
    );
    expect(out.map((w) => w.word)).toEqual(["temperament", "beats", "intelligence"]);
  });

  it("carries the piece's offset through, so a segment lands in the right place", () => {
    const out = alignScriptToAsr("hello world", asr([["hello", 10, 10.4], ["world", 10.4, 10.9]]), {
      offsetSec: 10,
      durationSec: 0.9,
    });
    expect(out[0]!.startSec).toBe(10);
    expect(out[1]!.endSec).toBeCloseTo(10.9);
  });

  it("degrades to the linear estimate when Whisper returned nothing", () => {
    const out = alignScriptToAsr("one two three four", [], { offsetSec: 5, durationSec: 4 });
    expect(out.map((w) => w.word)).toEqual(["one", "two", "three", "four"]);
    expect(out[0]!.startSec).toBeGreaterThanOrEqual(5);
    expect(out[out.length - 1]!.endSec).toBeLessThanOrEqual(9);
  });

  it("never loses or reorders a script word, whatever the ASR did", () => {
    const script = "Ronald Read died with eight million dollars and Richard Fuscone declared bankruptcy";
    const out = alignScriptToAsr(
      script,
      asr([["Ronald", 0, 0.3], ["Reed", 0.3, 0.6], ["died", 0.6, 0.9], ["with", 0.9, 1.1], ["8", 1.1, 1.4], ["million", 1.4, 1.8], ["dollars", 1.8, 2.2], ["and", 2.2, 2.4], ["Richard", 2.4, 2.8], ["Fusco", 2.8, 3.2], ["clear", 3.2, 3.5], ["bankruptcy", 3.5, 4.0]]),
      { offsetSec: 0, durationSec: 4 },
    );
    expect(out.map((w) => w.word).join(" ")).toBe(script);
  });
});
