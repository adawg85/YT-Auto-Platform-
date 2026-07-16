/**
 * Price tables used for cost accounting. Real adapters prefer
 * provider-reported cost when available; mocks use these same tables so
 * projected unit economics are visible with zero API keys.
 * Prices are estimates — tune per your actual plan/contract.
 */

/**
 * USD per million tokens. Keys cover both OpenRouter slugs (vendor/model)
 * and direct-API ids (bare model id); `llmPrice` also strips the router's
 * `vendor:` prefixes before lookup.
 */
export const LLM_PRICES: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  "google/gemini-2.5-flash-lite": { inputPerMTok: 0.1, outputPerMTok: 0.4 },
  "deepseek/deepseek-chat": { inputPerMTok: 0.3, outputPerMTok: 1.2 },
  "moonshotai/kimi-k2": { inputPerMTok: 0.6, outputPerMTok: 2.5 },
  "anthropic/claude-haiku-4.5": { inputPerMTok: 1, outputPerMTok: 5 },
  "anthropic/claude-sonnet-4.5": { inputPerMTok: 3, outputPerMTok: 15 },
  "anthropic/claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "anthropic/claude-opus-4.5": { inputPerMTok: 5, outputPerMTok: 25 },
  "anthropic/claude-opus-4.8": { inputPerMTok: 5, outputPerMTok: 25 },
  "anthropic/claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50 },
  "qwen/qwen-max": { inputPerMTok: 1.6, outputPerMTok: 6.4 },
  "qwen/qwen-plus": { inputPerMTok: 0.4, outputPerMTok: 1.2 },
  // direct-API ids (Anthropic / Gemini / Z.ai GLM / DashScope Qwen / Moonshot)
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50 },
  "gemini-2.5-flash-lite": { inputPerMTok: 0.1, outputPerMTok: 0.4 },
  "glm-4.6": { inputPerMTok: 0.6, outputPerMTok: 2.2 },
  "qwen-plus": { inputPerMTok: 0.4, outputPerMTok: 1.2 },
  "qwen-max": { inputPerMTok: 1.6, outputPerMTok: 6.4 },
  "kimi-k2-turbo-preview": { inputPerMTok: 0.6, outputPerMTok: 2.5 },
};

export const LLM_PRICE_FALLBACK = { inputPerMTok: 1, outputPerMTok: 4 };

export function llmPrice(modelId: string) {
  // strip the router's vendor prefix (anthropic:/google:/glm:/qwen:/kimi:/
  // openrouter:) so audit rows priced by full ref still match the table
  const bare = modelId.replace(/^(anthropic|google|glm|qwen|kimi|openrouter):/, "");
  return LLM_PRICES[bare] ?? LLM_PRICE_FALLBACK;
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

/** Deterministic mock media (keyless / forced-mock): nominal placeholder cost. */
export const IMAGE_PRICE_MOCK = 0.007;
/** Google-direct nano-banana (gemini-2.5-flash-image): USD per image. */
export const IMAGE_PRICE_NANO = 0.039;
/** Google-direct nano-banana-pro (gemini-3-pro-image at 2K): USD per image. */
export const IMAGE_PRICE_NANO_PRO = 0.134;
/** DashScope-direct Qwen-Image (bulk tier): USD per image — estimate, tune. */
export const IMAGE_PRICE_QWEN = 0.025;
/** ByteDance Seedream DIRECT via BytePlus ModelArk (2026-07-16): ~$0.03/image,
 * a small premium over Qwen for nicer photoreal/composition on the bulk tier. */
export const IMAGE_PRICE_SEEDREAM = 0.03;

/** AI beat clips, USD per generated second — estimates, tune to vendor rates.
 * Wan via DashScope (wan2.x plus tiers) and Minimax Hailuo (~$0.28 per 6s). */
export const VIDEO_PRICE_WAN_PER_SEC = 0.05;
export const VIDEO_PRICE_MINIMAX_PER_SEC = 0.045;
/** Seedance Pro i2v DIRECT via BytePlus ModelArk (2026-07-16): ~$0.06/s at
 * 720p (best keyframe identity — reserved for character clips); tier-dependent
 * (ModelArk lists 480p/720p/1080p), tune to your account rate. */
export const VIDEO_PRICE_SEEDANCE_PER_SEC = 0.06;

/** Attributed render compute cost, USD per hour (droplet share). */
export const RENDER_COST_PER_HOUR = Number(process.env.RENDER_COST_PER_HOUR ?? "0.06");
