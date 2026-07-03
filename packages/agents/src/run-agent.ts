import { agentActions, ulid, type Db } from "@ytauto/db";
import type { CostSink } from "@ytauto/core";
import { llmCostUsd, type LLMProvider, type LLMTier } from "@ytauto/providers";
import type { LanguageModel } from "ai";

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
  fn: (model: LanguageModel) => Promise<GenerateResult<T>>,
): Promise<T> {
  const started = Date.now();
  const model = ctx.llm.model(tier);
  const modelId = ctx.llm.modelId(tier);

  const result = await fn(model);
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
