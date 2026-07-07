import { describe, expect, it } from "vitest";
import { chunkText, MEMORY_CHUNK_TARGET_CHARS } from "../src/memory";

describe("chunkText", () => {
  it("returns [] for empty/whitespace input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n  ")).toEqual([]);
  });

  it("keeps a short document as a single chunk", () => {
    const chunks = chunkText("The Concorde entered service in 1976. Only 20 were built.");
    expect(chunks).toHaveLength(1);
  });

  it("splits on sentence boundaries near the target size", () => {
    const sentence = "This is a factual sentence about aviation history that runs on. ";
    const doc = sentence.repeat(60); // ~3800 chars
    const chunks = chunkText(doc);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MEMORY_CHUNK_TARGET_CHARS + sentence.length);
      expect(c.endsWith(".")).toBe(true); // sentence-boundary splits
    }
  });

  it("hard-splits a pathological unbroken run", () => {
    const doc = "x".repeat(MEMORY_CHUNK_TARGET_CHARS * 3);
    const chunks = chunkText(doc);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MEMORY_CHUNK_TARGET_CHARS);
  });

  it("normalizes whitespace and loses no content on clean input", () => {
    const doc = "First sentence.  \n Second   sentence. Third sentence.";
    const chunks = chunkText(doc);
    expect(chunks.join(" ")).toBe("First sentence. Second sentence. Third sentence.");
  });
});
