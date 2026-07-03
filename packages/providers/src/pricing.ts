/**
 * Price tables used for cost accounting. Real adapters prefer
 * provider-reported cost when available; mocks use these same tables so
 * projected unit economics are visible with zero API keys.
 * Prices are estimates — tune per your actual plan/contract.
 */

/** USD per million tokens, keyed by (OpenRouter) model id. */
export const LLM_PRICES: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  "google/gemini-2.5-flash-lite": { inputPerMTok: 0.1, outputPerMTok: 0.4 },
  "deepseek/deepseek-chat": { inputPerMTok: 0.3, outputPerMTok: 1.2 },
  "moonshotai/kimi-k2": { inputPerMTok: 0.6, outputPerMTok: 2.5 },
  "anthropic/claude-sonnet-4.5": { inputPerMTok: 3, outputPerMTok: 15 },
  "anthropic/claude-opus-4.5": { inputPerMTok: 5, outputPerMTok: 25 },
};

export const LLM_PRICE_FALLBACK = { inputPerMTok: 1, outputPerMTok: 4 };

export function llmPrice(modelId: string) {
  return LLM_PRICES[modelId] ?? LLM_PRICE_FALLBACK;
}

export function llmCostUsd(
  modelId: string,
  usage: { inputTokens: number; outputTokens: number },
): number {
  const p = llmPrice(modelId);
  return (
    (usage.inputTokens / 1_000_000) * p.inputPerMTok +
    (usage.outputTokens / 1_000_000) * p.outputPerMTok
  );
}

/** ElevenLabs-style TTS: USD per 1k characters. */
export const VOICE_PRICE_PER_KCHAR = 0.08;

/** fal.ai flux/schnell-style image gen: USD per image at ~2MP. */
export const IMAGE_PRICE_EACH = 0.007;

/** Attributed render compute cost, USD per hour (droplet share). */
export const RENDER_COST_PER_HOUR = Number(process.env.RENDER_COST_PER_HOUR ?? "0.06");
