import type { CostSink } from "@ytauto/core";
import type { EmbeddingProvider } from "../types";
import { EMBEDDING_DIMENSIONS } from "../mock/embedding";

/** USD per million tokens, text-embedding-3-small */
const PRICE_PER_MTOK = 0.02;

/**
 * OpenAI embeddings (text-embedding-3-small, 1536 dims — matches
 * memory_chunks.embedding vector(1536)). Plain fetch, no SDK. Cost lands in
 * cost_records under category "llm" (embeddings are LLM-adjacent spend; a
 * dedicated enum value isn't worth a migration).
 */
export function createOpenAIEmbeddingProvider(
  apiKey: string,
  costSink: CostSink,
): EmbeddingProvider {
  return {
    name: "openai-embedding",
    dimensions: EMBEDDING_DIMENSIONS,
    async embed(texts, ctx) {
      if (texts.length === 0) return [];
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: texts,
          dimensions: EMBEDDING_DIMENSIONS,
        }),
      });
      if (!res.ok) {
        throw new Error(`openai embeddings ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const json = (await res.json()) as {
        data: { index: number; embedding: number[] }[];
        usage?: { total_tokens?: number };
      };
      const tokens = json.usage?.total_tokens ?? 0;
      await costSink.record({
        category: "llm",
        provider: "openai",
        model: "text-embedding-3-small",
        units: { inputTokens: tokens },
        costUsd: (tokens / 1_000_000) * PRICE_PER_MTOK,
        channelId: ctx?.channelId ?? "platform",
      });
      return json.data
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
    },
  };
}
