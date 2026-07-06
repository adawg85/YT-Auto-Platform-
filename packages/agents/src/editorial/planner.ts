import { generateObject } from "ai";
import { seriesPlanSchema, type SeriesPlan } from "@ytauto/core";
import { runAgent, type AgentCtx } from "../run-agent";

/**
 * Series planner (frontier tier): charter + the channel "state of the world"
 * (mission, decisions, coverage ledger) → an ordered arc of episode topics.
 * Pure — the editorial-plan Inngest function persists series + episodes.
 */
export async function planSeries(
  ctx: AgentCtx,
  input: { niche: string; mission: string; stateSummary: string },
): Promise<SeriesPlan> {
  const prompt = [
    `NICHE: ${input.niche}`,
    `MISSION: ${input.mission}`,
    `CHANNEL STATE:\n${input.stateSummary}`,
    "Plan the next ordered series arc. Every episode must be materially distinct from anything already covered.",
  ].join("\n\n");
  return runAgent("series_planner", "frontier", ctx, `plan series for ${input.niche}`, async (model) => {
    const res = await generateObject({
      model,
      schema: seriesPlanSchema,
      system:
        "TASK:series-plan — You plan ordered evergreen series arcs for an autonomous channel. " +
        "Episodes are one self-contained story each, sequenced to build returning viewers. " +
        "NEVER include topics listed as already covered.",
      prompt,
    });
    return { object: res.object, usage: res.usage };
  });
}
