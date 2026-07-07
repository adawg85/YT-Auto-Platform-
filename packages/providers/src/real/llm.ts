import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import type { LLMProvider, LLMTier } from "../types";
import { llmPrice } from "../pricing";

/**
 * Strict structured-output modes at several OpenRouter upstreams (Azure
 * OpenAI, Bedrock) reject JSON-schema array bounds: "For 'array' type,
 * 'minItems' values other than 0 or 1 are not supported". Our zod contracts
 * use .min(n)/.max(n) on arrays (charter objectives, beats, hook styles…),
 * so requests 400 before the model ever runs. Strip the offending keywords
 * from the outgoing schema and fold them into the field description so the
 * model still aims for the right counts — the zod schema continues to
 * validate the RESPONSE unchanged.
 */
export function sanitizeSchemaForProviders(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeSchemaForProviders);
  if (!node || typeof node !== "object") return node;
  const o: Record<string, unknown> = { ...(node as Record<string, unknown>) };
  const hints: string[] = [];
  const dropBound = (key: string, hint: (v: number) => string, keepZeroOne = false) => {
    const v = o[key];
    if (typeof v !== "number") return;
    if (keepZeroOne && (v === 0 || v === 1)) return;
    delete o[key];
    hints.push(hint(v));
  };
  const types = Array.isArray(o.type) ? o.type : [o.type];
  if (types.includes("array")) {
    dropBound("minItems", (v) => `at least ${v} items`, true);
    dropBound("maxItems", (v) => `at most ${v} items`);
  }
  if (types.includes("number") || types.includes("integer")) {
    dropBound("minimum", (v) => `minimum ${v}`);
    dropBound("maximum", (v) => `maximum ${v}`);
    dropBound("exclusiveMinimum", (v) => `greater than ${v}`);
    dropBound("exclusiveMaximum", (v) => `less than ${v}`);
    dropBound("multipleOf", (v) => `a multiple of ${v}`);
  }
  if (types.includes("string")) {
    dropBound("minLength", (v) => `at least ${v} characters`);
    dropBound("maxLength", (v) => `at most ${v} characters`);
    if (typeof o.pattern === "string") {
      hints.push(`matching ${o.pattern}`);
      delete o.pattern;
    }
    // "format" is rejected by some strict validators unless whitelisted
    if (typeof o.format === "string" && !["date-time", "date", "time"].includes(o.format)) {
      hints.push(`format: ${o.format}`);
      delete o.format;
    }
  }
  if (hints.length > 0) {
    const hint = hints.join(", ");
    o.description = typeof o.description === "string" && o.description ? `${o.description} (${hint})` : hint;
  }
  for (const k of Object.keys(o)) {
    if (k === "description") continue;
    o[k] = sanitizeSchemaForProviders(o[k]);
  }
  return o;
}

const schemaCompat: LanguageModelMiddleware = {
  middlewareVersion: "v2",
  transformParams: async ({ params }) => {
    const rf = params.responseFormat;
    if (rf?.type === "json" && rf.schema) {
      return {
        ...params,
        responseFormat: { ...rf, schema: sanitizeSchemaForProviders(rf.schema) as typeof rf.schema },
      };
    }
    return params;
  },
};

/**
 * OpenRouter gateway (via its OpenAI-compatible API) with tiered routing
 * (spec §7). Model ids are env-overridable so routing is configuration,
 * not code — `env` is the merged process.env + account-page secrets, so
 * LLM_MODEL_* saved on /account take effect without a redeploy.
 */
export function createOpenRouterProvider(
  apiKey: string,
  env: Record<string, string | undefined> = process.env,
): LLMProvider {
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
    cheap: env.LLM_MODEL_CHEAP ?? "google/gemini-2.5-flash-lite",
    agentic: env.LLM_MODEL_AGENTIC ?? "anthropic/claude-sonnet-5",
    frontier: env.LLM_MODEL_FRONTIER ?? "anthropic/claude-opus-4.8",
  };
  return {
    name: "openrouter",
    model: (tier) => wrapLanguageModel({ model: openrouter.chatModel(models[tier]), middleware: schemaCompat }),
    modelId: (tier) => models[tier],
    price: (tier) => llmPrice(models[tier]),
  };
}
