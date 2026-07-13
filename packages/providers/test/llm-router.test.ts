/**
 * Multi-vendor LLM router: ref parsing, missing-key fallback translation,
 * tier resolution defaults, and price normalization — all pure/offline.
 */
import { describe, expect, it } from "vitest";
import {
  createLLMRouter,
  ensureJsonWord,
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
  it("falls back to Claude on agentic/frontier when Qwen has no route (Anthropic + Google only)", () => {
    // Qwen leads TIER_DEFAULTS but resolves to nothing without a DashScope or
    // OpenRouter key, so the Claude fallback wins.
    const router = createLLMRouter({ ANTHROPIC_API_KEY: "k", GEMINI_API_KEY: "k" });
    expect(router.modelId("frontier")).toBe("anthropic:claude-opus-4-8");
    expect(router.modelId("agentic")).toBe("anthropic:claude-sonnet-5");
    expect(router.modelId("cheap")).toBe("google:gemini-2.5-flash-lite");
  });

  it("routes Qwen (agentic/frontier) via OpenRouter when only that key exists", () => {
    const router = createLLMRouter({ OPENROUTER_API_KEY: "k" });
    expect(router.modelId("frontier")).toBe("openrouter:qwen/qwen-max");
    expect(router.modelId("agentic")).toBe("openrouter:qwen/qwen-max");
    expect(router.modelId("cheap")).toBe("openrouter:google/gemini-2.5-flash-lite");
  });

  it("uses the direct DashScope route for Qwen when that key exists", () => {
    const router = createLLMRouter({ DASHSCOPE_API_KEY: "k", GEMINI_API_KEY: "k" });
    expect(router.modelId("frontier")).toBe("qwen:qwen-max");
    expect(router.modelId("agentic")).toBe("qwen:qwen-max");
    expect(router.modelId("cheap")).toBe("google:gemini-2.5-flash-lite");
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

describe("per-agent model overrides (#21 routing)", () => {
  const base = { ANTHROPIC_API_KEY: "k", GEMINI_API_KEY: "k" };

  it("routes a named agent to its override, others to the tier", () => {
    const router = createLLMRouter({
      ...base,
      LLM_AGENT_MODELS: '{"scriptwriter":"google:gemini-2.5-flash-lite"}',
    });
    expect(router.agentModelId("scriptwriter", "frontier")).toBe("google:gemini-2.5-flash-lite");
    expect(router.agentModelId("humanize_editor", "agentic")).toBe("anthropic:claude-sonnet-5");
  });

  it("never applies overrides to escalation-tier calls", () => {
    const router = createLLMRouter({
      ...base,
      LLM_MODEL_ESCALATION: "anthropic:claude-opus-4-8",
      LLM_AGENT_MODELS: '{"scriptwriter":"google:gemini-2.5-flash-lite"}',
    });
    expect(router.agentModelId("scriptwriter", "escalation")).toBe("anthropic:claude-opus-4-8");
  });

  it("falls back to the tier when the override's vendor has no route", () => {
    const router = createLLMRouter({
      ANTHROPIC_API_KEY: "k",
      LLM_AGENT_MODELS: '{"ideation":"glm:glm-4.6"}', // no GLM or OpenRouter key
    });
    expect(router.agentModelId("ideation", "cheap")).toBe(router.modelId("cheap"));
  });

  it("tolerates malformed JSON (no overrides, no crash)", () => {
    const router = createLLMRouter({ ...base, LLM_AGENT_MODELS: "not json{" });
    expect(router.agentModelId("scriptwriter", "frontier")).toBe(router.modelId("frontier"));
  });
});

describe("escalation tier (#21.2.3 — strictly opt-in)", () => {
  it("aliases frontier when LLM_MODEL_ESCALATION is unset", () => {
    const router = createLLMRouter({ ANTHROPIC_API_KEY: "k" });
    expect(router.modelId("escalation")).toBe(router.modelId("frontier"));
  });

  it("aliases the frontier OVERRIDE too, so the enabled-check stays correct", () => {
    // The degradation path must not resolve escalation to a tier DEFAULT while
    // frontier itself carries an override — that would fake "configured".
    const router = createLLMRouter({
      ANTHROPIC_API_KEY: "k",
      DASHSCOPE_API_KEY: "k",
      LLM_MODEL_FRONTIER: "anthropic:claude-opus-4-8",
    });
    expect(router.modelId("escalation")).toBe("anthropic:claude-opus-4-8");
  });

  it("resolves an explicit escalation override", () => {
    const router = createLLMRouter({
      ANTHROPIC_API_KEY: "k",
      DASHSCOPE_API_KEY: "k",
      LLM_MODEL_ESCALATION: "anthropic:claude-opus-4-8",
    });
    expect(router.modelId("frontier")).toBe("qwen:qwen-max");
    expect(router.modelId("escalation")).toBe("anthropic:claude-opus-4-8");
    expect(router.modelId("escalation")).not.toBe(router.modelId("frontier"));
  });

  it("falls back to the frontier alias when the escalation override is unresolvable", () => {
    const router = createLLMRouter({
      DASHSCOPE_API_KEY: "k",
      LLM_MODEL_ESCALATION: "anthropic:claude-opus-4-8", // no anthropic/openrouter key
    });
    expect(router.modelId("escalation")).toBe(router.modelId("frontier"));
  });
});

describe("ensureJsonWord (DashScope json_object requires the word 'json')", () => {
  const sys = (text: string) => ({ role: "system" as const, content: text });
  const user = (text: string) => ({
    role: "user" as const,
    content: [{ type: "text" as const, text }],
  });

  it("appends the word json to the system message when absent", () => {
    const out = ensureJsonWord([sys("TASK:charter — design a charter"), user("aviation history")]);
    expect(out[0]).toMatchObject({ role: "system" });
    expect(/json/i.test(out[0]!.content as string)).toBe(true);
    // original system text is preserved
    expect((out[0]!.content as string).startsWith("TASK:charter")).toBe(true);
  });

  it("is a no-op when a message already contains 'json' (any case)", () => {
    const prompt = [sys("Return JSON only"), user("hi")];
    expect(ensureJsonWord(prompt)).toBe(prompt);
  });

  it("detects 'json' inside user text parts", () => {
    const prompt = [sys("no marker"), user("please answer as json")];
    expect(ensureJsonWord(prompt)).toBe(prompt);
  });

  it("prepends a system message when there is no system message", () => {
    const out = ensureJsonWord([user("just a user turn")]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ role: "system" });
    expect(/json/i.test(out[0]!.content as string)).toBe(true);
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
