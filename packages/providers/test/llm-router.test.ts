/**
 * Multi-vendor LLM router: ref parsing, missing-key fallback translation,
 * tier resolution defaults, and price normalization — all pure/offline.
 */
import { describe, expect, it } from "vitest";
import {
  createLLMRouter,
  parseModelRef,
  resolveModelRef,
  type LLMVendor,
} from "../src/real/llm";
import { llmPrice, LLM_PRICE_FALLBACK } from "../src/pricing";

const V = (...vendors: LLMVendor[]) => new Set<LLMVendor>(vendors);

describe("parseModelRef", () => {
  it("parses vendor-prefixed refs", () => {
    expect(parseModelRef("anthropic:claude-opus-4-8")).toEqual({
      vendor: "anthropic",
      modelId: "claude-opus-4-8",
    });
    expect(parseModelRef("glm:glm-4.6")).toEqual({ vendor: "glm", modelId: "glm-4.6" });
    expect(parseModelRef("qwen:qwen-plus").vendor).toBe("qwen");
    expect(parseModelRef("kimi:kimi-k2-turbo-preview").vendor).toBe("kimi");
  });

  it("treats bare ids as legacy OpenRouter slugs", () => {
    expect(parseModelRef("anthropic/claude-opus-4.8")).toEqual({
      vendor: "openrouter",
      modelId: "anthropic/claude-opus-4.8",
    });
  });
});

describe("resolveModelRef", () => {
  it("uses the named vendor when its key is available", () => {
    expect(resolveModelRef("anthropic:claude-sonnet-5", V("anthropic"))).toEqual({
      vendor: "anthropic",
      modelId: "claude-sonnet-5",
    });
  });

  it("falls back to OpenRouter with a translated slug when the vendor key is missing", () => {
    expect(resolveModelRef("anthropic:claude-opus-4-8", V("openrouter"))).toEqual({
      vendor: "openrouter",
      modelId: "anthropic/claude-opus-4.8",
    });
    expect(resolveModelRef("glm:glm-4.6", V("openrouter"))).toEqual({
      vendor: "openrouter",
      modelId: "z-ai/glm-4.6",
    });
    expect(resolveModelRef("kimi:kimi-k2", V("openrouter"))).toEqual({
      vendor: "openrouter",
      modelId: "moonshotai/kimi-k2",
    });
    expect(resolveModelRef("qwen:qwen-plus", V("openrouter"))?.modelId).toBe("qwen/qwen-plus");
    expect(resolveModelRef("google:gemini-2.5-flash-lite", V("openrouter"))?.modelId).toBe(
      "google/gemini-2.5-flash-lite",
    );
  });

  it("returns null when nothing can serve the ref", () => {
    expect(resolveModelRef("anthropic:claude-opus-4-8", V("google"))).toBeNull();
    expect(resolveModelRef("bare-openrouter-slug", V("anthropic"))).toBeNull();
  });
});

describe("createLLMRouter tier resolution", () => {
  it("prefers direct Anthropic + Google when those keys exist", () => {
    const router = createLLMRouter({ ANTHROPIC_API_KEY: "k", GEMINI_API_KEY: "k" });
    expect(router.modelId("frontier")).toBe("anthropic:claude-opus-4-8");
    expect(router.modelId("agentic")).toBe("anthropic:claude-sonnet-5");
    expect(router.modelId("cheap")).toBe("google:gemini-2.5-flash-lite");
  });

  it("falls back to OpenRouter slugs when only that key exists", () => {
    const router = createLLMRouter({ OPENROUTER_API_KEY: "k" });
    expect(router.modelId("frontier")).toBe("openrouter:anthropic/claude-opus-4.8");
    expect(router.modelId("cheap")).toBe("openrouter:google/gemini-2.5-flash-lite");
  });

  it("honours explicit vendor-prefixed overrides (e.g. Kimi on the cheap tier)", () => {
    const router = createLLMRouter({
      ANTHROPIC_API_KEY: "k",
      MOONSHOT_API_KEY: "k",
      LLM_MODEL_CHEAP: "kimi:kimi-k2-turbo-preview",
    });
    expect(router.modelId("cheap")).toBe("kimi:kimi-k2-turbo-preview");
    expect(router.modelId("frontier")).toBe("anthropic:claude-opus-4-8");
  });

  it("translates an override to OpenRouter when its vendor key is missing", () => {
    const router = createLLMRouter({
      OPENROUTER_API_KEY: "k",
      LLM_MODEL_AGENTIC: "glm:glm-4.6",
    });
    expect(router.modelId("agentic")).toBe("openrouter:z-ai/glm-4.6");
  });

  it("legacy bare-slug overrides keep working via OpenRouter", () => {
    const router = createLLMRouter({
      OPENROUTER_API_KEY: "k",
      LLM_MODEL_FRONTIER: "anthropic/claude-opus-4.8",
    });
    expect(router.modelId("frontier")).toBe("openrouter:anthropic/claude-opus-4.8");
  });
});

describe("llmPrice vendor-prefix normalization", () => {
  it("prices direct ids, prefixed refs and OpenRouter slugs identically", () => {
    const direct = llmPrice("claude-opus-4-8");
    expect(direct.inputPerMTok).toBe(5);
    expect(llmPrice("anthropic:claude-opus-4-8")).toEqual(direct);
    expect(llmPrice("openrouter:anthropic/claude-opus-4.8")).toEqual(
      llmPrice("anthropic/claude-opus-4.8"),
    );
    expect(llmPrice("google:gemini-2.5-flash-lite").inputPerMTok).toBe(0.1);
  });

  it("unknown models fall back to the flat estimate", () => {
    expect(llmPrice("qwen:qwen3-someday")).toEqual(LLM_PRICE_FALLBACK);
  });
});
