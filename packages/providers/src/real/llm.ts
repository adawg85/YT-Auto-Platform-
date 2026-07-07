import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";
import type { LLMProvider, LLMTier } from "../types";
import { llmPrice } from "../pricing";

/**
 * Strict structured-output modes at several OpenAI-compatible upstreams
 * (Azure OpenAI, Bedrock via OpenRouter, some open-model hosts) reject
 * JSON-schema bounds: "For 'array' type, 'minItems' values other than 0 or 1
 * are not supported". Our zod contracts use .min(n)/.max(n) on arrays
 * (charter objectives, beats, hook styles…), so requests 400 before the
 * model ever runs. Strip the offending keywords from the outgoing schema and
 * fold them into the field description so the model still aims for the right
 * counts — the zod schema continues to validate the RESPONSE unchanged.
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

// ── Multi-vendor router ──────────────────────────────────────────────────
//
// Model refs are vendor-prefixed: `anthropic:claude-opus-4-8`,
// `google:gemini-2.5-flash-lite`, `glm:glm-4.6`, `qwen:qwen-plus`,
// `kimi:kimi-k2-turbo-preview`, `openrouter:anthropic/claude-opus-4.8`.
// A bare ref with no prefix keeps meaning an OpenRouter slug (backward
// compatible with values already stored on /account).

export type LLMVendor = "anthropic" | "google" | "glm" | "qwen" | "kimi" | "openrouter";

export const VENDOR_KEY_VARS: Record<LLMVendor, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  glm: "ZAI_API_KEY",
  qwen: "DASHSCOPE_API_KEY",
  kimi: "MOONSHOT_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/** OpenAI-compatible direct endpoints (overridable via <VAR>_BASE_URL-style env). */
const COMPAT_BASE_URLS: Partial<Record<LLMVendor, { envVar: string; url: string }>> = {
  glm: { envVar: "ZAI_BASE_URL", url: "https://api.z.ai/api/paas/v4" },
  qwen: {
    envVar: "DASHSCOPE_BASE_URL",
    url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  },
  kimi: { envVar: "MOONSHOT_BASE_URL", url: "https://api.moonshot.ai/v1" },
  openrouter: { envVar: "OPENROUTER_BASE_URL", url: "https://openrouter.ai/api/v1" },
};

/** OpenRouter slug prefix per vendor, for the missing-key fallback translation. */
const OPENROUTER_SLUG_PREFIX: Record<Exclude<LLMVendor, "openrouter">, string> = {
  anthropic: "anthropic/",
  google: "google/",
  glm: "z-ai/",
  qwen: "qwen/",
  kimi: "moonshotai/",
};

export type ModelRef = { vendor: LLMVendor; modelId: string };

export function parseModelRef(ref: string): ModelRef {
  const m = /^(anthropic|google|glm|qwen|kimi|openrouter):(.+)$/.exec(ref.trim());
  if (m) return { vendor: m[1] as LLMVendor, modelId: m[2]! };
  // bare id = legacy OpenRouter slug
  return { vendor: "openrouter", modelId: ref.trim() };
}

/**
 * Resolve a ref against the vendors we actually hold keys for. If the ref's
 * vendor key is missing but OpenRouter is available, translate to the
 * equivalent OpenRouter slug (best effort: Anthropic ids swap `-N-M` version
 * suffixes to `-N.M`, e.g. claude-opus-4-8 → anthropic/claude-opus-4.8).
 * Returns null when nothing available can serve the ref.
 */
export function resolveModelRef(ref: string, available: Set<LLMVendor>): ModelRef | null {
  const parsed = parseModelRef(ref);
  if (available.has(parsed.vendor)) return parsed;
  if (parsed.vendor !== "openrouter" && available.has("openrouter")) {
    let slug = parsed.modelId;
    if (parsed.vendor === "anthropic") {
      slug = slug.replace(/-(\d+)-(\d+)$/, "-$1.$2");
    }
    return { vendor: "openrouter", modelId: OPENROUTER_SLUG_PREFIX[parsed.vendor] + slug };
  }
  return null;
}

/** Default ref per tier, in preference order; first resolvable wins. */
const TIER_DEFAULTS: Record<LLMTier, string[]> = {
  cheap: ["google:gemini-2.5-flash-lite", "openrouter:google/gemini-2.5-flash-lite"],
  agentic: ["anthropic:claude-sonnet-5", "openrouter:anthropic/claude-sonnet-5"],
  frontier: ["anthropic:claude-opus-4-8", "openrouter:anthropic/claude-opus-4.8"],
};

/**
 * Multi-vendor LLM router: direct API keys per vendor, chosen by us — not by
 * a gateway's upstream lottery (spec §7 + BACKLOG #12 stack prefs). `env` is
 * process.env merged with /account secrets, so keys AND tier models change
 * without a redeploy. Anthropic uses its native SDK (native structured
 * outputs, no sanitizer); Google and every OpenAI-compatible path (GLM, Qwen,
 * Kimi, OpenRouter) get the schema-compat middleware.
 */
export function createLLMRouter(
  env: Record<string, string | undefined> = process.env,
): LLMProvider {
  const available = new Set<LLMVendor>(
    (Object.keys(VENDOR_KEY_VARS) as LLMVendor[]).filter((v) => !!env[VENDOR_KEY_VARS[v]]),
  );

  const resolveTier = (tier: LLMTier): ModelRef => {
    const override = env[`LLM_MODEL_${tier.toUpperCase()}`];
    if (override) {
      const r = resolveModelRef(override, available);
      if (r) return r;
      // fall through: an override pointing at a vendor we hold no key for
    }
    for (const ref of TIER_DEFAULTS[tier]) {
      const r = resolveModelRef(ref, available);
      if (r) return r;
    }
    // last resort: any available vendor's tier default won't exist — pick
    // OpenRouter shape so the error names the model clearly at call time
    return parseModelRef(TIER_DEFAULTS[tier][TIER_DEFAULTS[tier].length - 1]!);
  };

  const refs: Record<LLMTier, ModelRef> = {
    cheap: resolveTier("cheap"),
    agentic: resolveTier("agentic"),
    frontier: resolveTier("frontier"),
  };

  // lazy per-vendor clients (a vendor is only constructed when a tier uses it)
  const clients: Partial<Record<LLMVendor, (modelId: string) => LanguageModel>> = {};
  const client = (vendor: LLMVendor): ((modelId: string) => LanguageModel) => {
    const existing = clients[vendor];
    if (existing) return existing;
    let make: (modelId: string) => LanguageModel;
    if (vendor === "anthropic") {
      const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY! });
      make = (id) => anthropic(id);
    } else if (vendor === "google") {
      const google = createGoogleGenerativeAI({ apiKey: env.GEMINI_API_KEY! });
      make = (id) => wrapLanguageModel({ model: google(id), middleware: schemaCompat });
    } else {
      const compat = COMPAT_BASE_URLS[vendor]!;
      const provider = createOpenAICompatible({
        name: vendor,
        baseURL: env[compat.envVar] ?? compat.url,
        apiKey: env[VENDOR_KEY_VARS[vendor]]!,
        ...(vendor === "openrouter"
          ? {
              headers: {
                "HTTP-Referer": "https://github.com/adawg85/yt-auto-platform",
                "X-Title": "yt-auto-platform",
              },
            }
          : {}),
        // Without this the SDK never sends response_format/json_schema, so
        // generateObject calls get free-form text back and fail to parse.
        supportsStructuredOutputs: true,
      });
      make = (id) => wrapLanguageModel({ model: provider.chatModel(id), middleware: schemaCompat });
    }
    clients[vendor] = make;
    return make;
  };

  return {
    name: "llm-router",
    model: (tier) => client(refs[tier].vendor)(refs[tier].modelId),
    modelId: (tier) => `${refs[tier].vendor}:${refs[tier].modelId}`,
    price: (tier) => llmPrice(refs[tier].modelId),
  };
}

/** @deprecated superseded by createLLMRouter; kept for any external callers. */
export function createOpenRouterProvider(
  apiKey: string,
  env: Record<string, string | undefined> = process.env,
): LLMProvider {
  return createLLMRouter({ ...env, OPENROUTER_API_KEY: apiKey });
}
