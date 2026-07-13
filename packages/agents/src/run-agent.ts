import { agentActions, ulid, type Db } from "@ytauto/db";
import type { CostSink } from "@ytauto/core";
import { llmCostUsd, type LLMProvider, type LLMTier } from "@ytauto/providers";
import type { LanguageModel, RepairTextFunction } from "ai";

/**
 * Structured-output repair (BACKLOG #15). Some models (incl. Anthropic on
 * nested-array schemas) occasionally return a field whose value is the JSON
 * *stringified* rather than the object/array itself — e.g.
 * `{"sources":"{\"sources\":[…]}"}` — which fails zod validation and kills the
 * whole run. Pass this to `generateObject({ experimental_repairText })` to
 * unwrap such double-encoded values before validation. Returns null (no repair)
 * when nothing looks double-encoded, so healthy output is untouched.
 *
 * Also unwraps tool-call-style WRAPPER objects: some models (seen with
 * gpt-5-mini on the idea-autoscore rubric) emit the whole payload nested under
 * a single generic key — `{"parameters": {…actual object…}}` — as if filling a
 * tool-call envelope. Only exact single-key objects with one of the known
 * envelope names are unwrapped, so real schemas are never touched (none of
 * ours use these as a lone top-level field).
 */
const WRAPPER_KEYS = new Set(["parameters", "arguments", "properties", "input"]);

export const repairDoubleEncodedJson: RepairTextFunction = async ({ text }) => {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    let obj = parsed as Record<string, unknown>;
    let changed = false;
    const soleKey = Object.keys(obj).length === 1 ? Object.keys(obj)[0] : undefined;
    if (soleKey && WRAPPER_KEYS.has(soleKey)) {
      const inner = obj[soleKey];
      if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        obj = inner as Record<string, unknown>;
        changed = true;
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v !== "string") continue;
      const s = v.trim();
      if (s[0] !== "{" && s[0] !== "[") continue;
      try {
        const inner = JSON.parse(s);
        // {"k":"{\"k\":X}"} → X; otherwise use the parsed inner value directly.
        obj[k] =
          inner && typeof inner === "object" && !Array.isArray(inner) && k in inner
            ? (inner as Record<string, unknown>)[k]
            : inner;
        changed = true;
      } catch {
        /* not JSON — leave it */
      }
    }
    return changed ? JSON.stringify(obj) : null;
  } catch {
    return null;
  }
};

export type AgentCtx = {
  db: Db;
  llm: LLMProvider;
  costSink: CostSink;
  channelId: string;
  ideaId?: string;
  productionId?: string;
};

type GenerateResult<T> = {
  object: T;
  usage: { inputTokens?: number; outputTokens?: number };
};

/**
 * Every agent invocation goes through here: it routes to the tiered model,
 * times the call, and writes both the AgentAction audit row and the
 * CostRecord line item. This is what keeps per-video unit economics and the
 * agent audit trail complete by construction.
 */
export async function runAgent<T>(
  name: string,
  tier: LLMTier,
  ctx: AgentCtx,
  inputSummary: string,
  // fn receives the ROUTED model id too (#21 per-agent overrides can differ
  // from the tier's model) — use it for temperatureFor, never the tier's id.
  fn: (model: LanguageModel, modelId: string) => Promise<GenerateResult<T>>,
): Promise<T> {
  const started = Date.now();
  const model = ctx.llm.agentModel(name, tier);
  const modelId = ctx.llm.agentModelId(name, tier);

  const result = await fn(model, modelId);
  const inputTokens = result.usage.inputTokens ?? 0;
  const outputTokens = result.usage.outputTokens ?? 0;
  const costUsd = llmCostUsd(modelId, { inputTokens, outputTokens });

  const agentActionId = ulid();
  await ctx.db.insert(agentActions).values({
    id: agentActionId,
    agentName: name,
    tier,
    model: modelId,
    channelId: ctx.channelId,
    ideaId: ctx.ideaId,
    productionId: ctx.productionId,
    inputSummary: inputSummary.slice(0, 500),
    output: result.object,
    inputTokens,
    outputTokens,
    costUsd: costUsd.toFixed(6),
    durationMs: Date.now() - started,
  });
  await ctx.costSink.record({
    category: "llm",
    provider: ctx.llm.name,
    model: modelId,
    units: { inputTokens, outputTokens },
    costUsd,
    channelId: ctx.channelId,
    productionId: ctx.productionId,
    agentActionId,
  });
  return result.object;
}
