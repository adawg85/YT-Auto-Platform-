import type { EmbeddingProvider } from "../types";
import { fnv1a } from "./hash";

export const EMBEDDING_DIMENSIONS = 1536;

/**
 * Deterministic bag-of-words embedding: each token adds weight at
 * fnv1a(token) % dims, then L2-normalize. Unlike a random vector, texts that
 * share vocabulary are genuinely cosine-closer, so top-k retrieval over the
 * pgvector memory behaves meaningfully with zero keys.
 */
export function mockEmbed(text: string, dims = EMBEDDING_DIMENSIONS): number[] {
  const vec = new Array<number>(dims).fill(0);
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
  for (const token of tokens) {
    vec[fnv1a(token) % dims]! += 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm === 0) {
    // degenerate input: a stable unit vector so cosine distance stays defined
    vec[fnv1a(text) % dims] = 1;
    return vec;
  }
  return vec.map((v) => v / norm);
}

export function createMockEmbeddingProvider(): EmbeddingProvider {
  return {
    name: "mock-embedding",
    dimensions: EMBEDDING_DIMENSIONS,
    async embed(texts) {
      return texts.map((t) => mockEmbed(t));
    },
  };
}
