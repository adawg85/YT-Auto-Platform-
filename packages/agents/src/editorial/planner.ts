import { generateObject } from "ai";
import {
  replacementEpisodeSchema,
  seriesPlanSchema,
  type ReplacementEpisode,
  type SeriesPlan,
} from "@ytauto/core";
import { runAgent, type AgentCtx, repairDoubleEncodedJson } from "../run-agent";

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
      experimental_repairText: repairDoubleEncodedJson,
      system:
        "TASK:series-plan — You plan ordered evergreen series arcs for an autonomous channel. " +
        "Episodes are one self-contained story each, sequenced to build returning viewers. " +
        "NEVER include topics listed as already covered.",
      prompt,
    });
    return { object: res.object, usage: res.usage };
  });
}

/**
 * Proposed-arc revision (2026-07-14 operator ask): the operator reviewed a
 * PROPOSED series arc and asked for specific tweaks before approving it —
 * previously steering was only possible before the arc existed. Applies the
 * operator's instructions to the current arc and returns the full revised
 * plan (same schema the planner emits). Pure — reviseSeriesAction persists.
 */
export async function reviseSeriesPlan(
  ctx: AgentCtx,
  input: {
    niche: string;
    stateSummary: string;
    current: { title: string; description: string; episodes: { title: string; angle: string }[] };
    instructions: string;
  },
): Promise<SeriesPlan> {
  const prompt = [
    `NICHE: ${input.niche}`,
    `CHANNEL STATE:\n${input.stateSummary}`,
    `CURRENT PROPOSED ARC — "${input.current.title}"\n${input.current.description}`,
    `CURRENT EPISODES (ordered):\n${input.current.episodes
      .map((e, i) => `${i + 1}. ${e.title} — ${e.angle}`)
      .join("\n")}`,
    `OPERATOR CHANGE REQUEST (apply exactly):\n${input.instructions}`,
    "Return the COMPLETE revised arc (title, description, full ordered episode list).",
  ].join("\n\n");
  return runAgent(
    "series_reviser",
    "frontier",
    ctx,
    `revise proposed arc "${input.current.title}"`,
    async (model) => {
      const res = await generateObject({
        model,
        schema: seriesPlanSchema,
        experimental_repairText: repairDoubleEncodedJson,
        system:
          "TASK:series-revise — The operator reviewed a PROPOSED series arc and requested changes. " +
          "Apply their instructions faithfully and return the complete revised arc. Everything the " +
          "operator did NOT ask to change stays VERBATIM — same titles, angles and order. " +
          "NEVER include topics listed as already covered.",
        prompt,
      });
      return { object: res.object, usage: res.usage };
    },
  );
}

/**
 * Gap-fill replacement planner (BACKLOG #23.1, frontier tier): an episode was
 * cut in research or its production failed — propose ONE replacement episode
 * for the vacated slot in the same arc, materially distinct from every title
 * the series already has (including the one that died). Pure — the
 * editorial-gapfill Inngest function persists the new episode.
 */
export async function proposeReplacementEpisode(
  ctx: AgentCtx,
  input: {
    niche: string;
    seriesTitle: string;
    seriesDescription: string;
    excludeTitles: string[];
    /** operator-initiated replace (2026-07-12 Plan-tab menu): their direction
     * for what the replacement should lean toward — it outranks everything
     * except the exclusion list */
    operatorSteer?: string;
  },
): Promise<ReplacementEpisode> {
  const prompt = [
    `NICHE: ${input.niche}`,
    `SERIES: ${input.seriesTitle}`,
    `SERIES DESCRIPTION: ${input.seriesDescription}`,
    `EXCLUDED TITLES (already used, cut, or failed — do NOT repeat or lightly rephrase any):\n${input.excludeTitles
      .map((t) => `- ${t}`)
      .join("\n")}`,
    ...(input.operatorSteer?.trim()
      ? [`OPERATOR DIRECTION (follow this above all other preferences): ${input.operatorSteer.trim()}`]
      : []),
    "Propose exactly ONE replacement episode to fill the vacated slot.",
  ].join("\n\n");
  return runAgent(
    "gapfill_planner",
    "frontier",
    ctx,
    `replacement episode for ${input.seriesTitle}`,
    async (model) => {
      const res = await generateObject({
        model,
        schema: replacementEpisodeSchema,
        experimental_repairText: repairDoubleEncodedJson,
        system:
          "TASK:replace-episode — An episode in an ordered evergreen series was cut or failed. " +
          "Propose ONE replacement episode that fills the gap: same arc and subject family as the " +
          "series, one self-contained story, materially distinct from every excluded title.",
        prompt,
      });
      return { object: res.object, usage: res.usage };
    },
  );
}
