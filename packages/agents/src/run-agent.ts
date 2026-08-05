import { agentActions, ulid, type Db } from "@ytauto/db";
import { describeGenerationFailure, type CostSink } from "@ytauto/core";
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

  // #102: a structured-output failure used to propagate raw — "No object
  // generated: response did not match schema." with no agent, no model, no
  // field, and no agent_actions row, so the tokens the vendor charged for were
  // invisible in the ledger. Catch it here, where the name and routed model are
  // already known.
  let result: GenerateResult<T>;
  try {
    result = await fn(model, modelId);
  } catch (err) {
    const first = describeGenerationFailure(name, modelId, err);
    // A complete-but-wrong-shape response is a known-flaky class for structured
    // output and usually clears immediately. A TRUNCATION is not retried: the
    // output cap caused it, so a second attempt at the same cap repeats it and
    // bills twice.
    if (first.retryable) {
      try {
        result = await fn(model, modelId);
      } catch (err2) {
        await recordFailedCall(ctx, name, tier, modelId, inputSummary, started, err2, 2);
        throw new Error(describeGenerationFailure(name, modelId, err2).message + " (retried once)");
      }
    } else {
      await recordFailedCall(ctx, name, tier, modelId, inputSummary, started, err, 1);
      throw new Error(first.message);
    }
  }
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

/**
 * #102: record a FAILED generation so its spend is attributable.
 *
 * The vendor charges for the tokens whether or not the response parsed, but
 * only successful calls were ever written to `agent_actions`/the cost ledger —
 * so a systematically-failing schema burned real money invisibly. Usage is read
 * off the error when the SDK attached it. Best-effort: a bookkeeping failure
 * must never replace the real error the caller is about to see.
 */
async function recordFailedCall(
  ctx: AgentCtx,
  name: string,
  tier: LLMTier,
  modelId: string,
  inputSummary: string,
  started: number,
  err: unknown,
  attempts: number,
): Promise<void> {
  try {
    const usage = (err as { usage?: { inputTokens?: number; outputTokens?: number } })?.usage;
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const costUsd = llmCostUsd(modelId, { inputTokens, outputTokens });
    const detail = describeGenerationFailure(name, modelId, err);
    const agentActionId = ulid();
    await ctx.db.insert(agentActions).values({
      id: agentActionId,
      agentName: name,
      tier,
      model: modelId,
      channelId: ctx.channelId,
      ideaId: ctx.ideaId,
      productionId: ctx.productionId,
      inputSummary: `FAILED (${detail.kind}${attempts > 1 ? `, ${attempts} attempts` : ""}): ${inputSummary}`.slice(0, 500),
      output: {
        failed: true,
        kind: detail.kind,
        attempts,
        finishReason: detail.finishReason,
        outputChars: detail.outputChars,
        message: detail.message,
      },
      inputTokens,
      outputTokens,
      costUsd: costUsd.toFixed(6),
      durationMs: Date.now() - started,
    });
    if (inputTokens || outputTokens) {
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
    }
  } catch {
    // swallowed by design — never mask the generation error with a logging one
  }
}
