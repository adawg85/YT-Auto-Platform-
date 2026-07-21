import { describe, expect, it } from "vitest";
import { chunkText } from "./voiceover";

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
