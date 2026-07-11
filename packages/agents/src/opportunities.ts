import { generateObject } from "ai";
import { opportunitiesSchema, type OpportunitiesOutput } from "@ytauto/core";
import { temperatureFor, type BreakoutChannel, type TrendCategory } from "@ytauto/providers";
import { runAgent, repairDoubleEncodedJson, type AgentCtx } from "./run-agent";

/**
 * Portfolio strategist (BACKLOG #22, agentic tier): clusters GLOBAL market
 * signals (trend categories + breakout channels, no niche seed) into
 * opportunities for the network — new-channel niches, topic waves, and
 * styles/formats working right now. Novelty rules live in the prompt; the
 * caller handles upsert/bump/dismiss lifecycle.
 */
export async function discoverOpportunities(
  ctx: AgentCtx,
  input: {
    categories: TrendCategory[];
    breakouts: BreakoutChannel[];
    /** niches the portfolio already operates — kind=niche must NOT overlap */
    existingNiches: string[];
    /** open opportunity labels — do not re-propose (code bumps them) */
    knownLabels: string[];
  },
): Promise<OpportunitiesOutput> {
  const system =
    "TASK:opportunity — You are the portfolio strategist for a network of faceless YouTube " +
    "channels. From the raw GLOBAL market signals, identify at most 8 opportunities:\n" +
    "- kind=niche: a trending territory where a NEW channel could work. It must NOT overlap " +
    "the EXISTING NICHES (that's covered channel intel, not an opportunity). suggestedNiche + " +
    "suggestedIntent must be wizard-ready ('deep sea discoveries', 'evergreen stories of what " +
    "lives and happens in the deep ocean, one discovery per episode').\n" +
    "- kind=topic: a cross-market topic wave — something multiple channels/categories are " +
    "riding that an existing channel could adapt or that could seed a new one.\n" +
    "- kind=style: a format/style visibly working (pacing, presentation, structure — e.g. " +
    "'silent pov builds', 'one-take explainers'), adoptable by any channel.\n" +
    "Do not re-propose KNOWN OPPORTUNITIES. Momentum reflects signal strength (growth rates, " +
    "category heat). Be selective: a weak signal is not an opportunity.";

  const prompt = [
    `EXISTING NICHES (portfolio already covers — never propose as niche): ${input.existingNiches.join("; ") || "(none)"}`,
    `KNOWN OPPORTUNITIES (already tracked — skip): ${input.knownLabels.join("; ") || "(none)"}`,
    "TREND CATEGORIES (global, niche-agnostic):",
    ...input.categories.map(
      (c) =>
        `- ${c.category}${c.momentum != null ? ` (momentum ${c.momentum})` : ""}${
          c.sampleTitles?.length ? ` — e.g. ${c.sampleTitles.slice(0, 3).join(" | ")}` : ""
        }`,
    ),
    "BREAKOUT CHANNELS (fastest-growing across the platform):",
    ...input.breakouts.map(
      (b) =>
        `- ${b.channelName}${b.niche ? ` [${b.niche}]` : ""} — ${b.subscribers.toLocaleString()} subs, +${b.growthRate}%/30d${
          b.topVideo.title ? `, top: "${b.topVideo.title}"` : ""
        }`,
    ),
  ].join("\n");

  return runAgent(
    "opportunity_scout",
    "agentic",
    ctx,
    `discover market opportunities (${input.categories.length} categories, ${input.breakouts.length} breakouts)`,
    async (model) => {
      const res = await generateObject({
        model,
        schema: opportunitiesSchema,
        experimental_repairText: repairDoubleEncodedJson,
        temperature: temperatureFor(ctx.llm.modelId("agentic"), "editor"),
        system,
        prompt,
      });
      return { object: res.object, usage: res.usage };
    },
  );
}
