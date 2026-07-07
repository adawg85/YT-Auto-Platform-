import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LLMProvider, LLMTier } from "../types";
import { llmPrice } from "../pricing";

/**
 * OpenRouter gateway (via its OpenAI-compatible API) with tiered routing
 * (spec §7). Model ids are env-overridable so routing is configuration,
 * not code.
 */
export function createOpenRouterProvider(apiKey: string): LLMProvider {
  const openrouter = createOpenAICompatible({
    name: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKey,
    headers: {
      "HTTP-Referer": "https://github.com/adawg85/yt-auto-platform",
      "X-Title": "yt-auto-platform",
    },
    // Without this the SDK never sends response_format/json_schema, so
    // generateObject calls get free-form markdown back from the model and
    // fail with "… is not valid JSON". OpenRouter passes json_schema through
    // to Anthropic/Gemini structured outputs.
    supportsStructuredOutputs: true,
  });
  const models: Record<LLMTier, string> = {
    cheap: process.env.LLM_MODEL_CHEAP ?? "google/gemini-2.5-flash-lite",
    agentic: process.env.LLM_MODEL_AGENTIC ?? "anthropic/claude-sonnet-4.5",
    frontier: process.env.LLM_MODEL_FRONTIER ?? "anthropic/claude-opus-4.5",
  };
  return {
    name: "openrouter",
    model: (tier) => openrouter.chatModel(models[tier]),
    modelId: (tier) => models[tier],
    price: (tier) => llmPrice(models[tier]),
  };
}
