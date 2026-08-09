import { generateObject } from "ai";
import { configConsistencySchema, type ConfigConsistencyResult, type TitleTemplate } from "@ytauto/core";
import { runAgent, type AgentCtx, repairDoubleEncodedJson } from "../run-agent";

/**
 * #109: write-time check that a channel's declared titleTemplates and its own
 * forbiddenTopics don't contradict each other. The Wings & Stories case: a
 * family "The [aircraft] That [did the impossible]" was declared minutes after a
 * forbidden topic banning machine-profile formats — every faithful instance of
 * the family was then blocked at review_slate, after authoring work was spent,
 * and the path of least resistance was to weaken the forbidden topic. Same
 * evaluator class as slate_review (semantic match against the channel's own
 * rules), run ONCE at set_channel_config instead of repeatedly at gate time.
 * Cheap tier: text classification against provided rules. ADVISORY — the config
 * is stored as written either way; this only makes the collision legible at the
 * moment it is introduced.
 */
export async function checkConfigConsistency(
  ctx: AgentCtx,
  input: {
    niche: string;
    forbiddenTopics: string[];
    titleTemplates: TitleTemplate[];
  },
): Promise<ConfigConsistencyResult> {
  if (!input.forbiddenTopics.length || !input.titleTemplates.length) return { findings: [] };

  const rules = input.forbiddenTopics.map((t, i) => `  F${i}. ${t}`).join("\n");
  const families = input.titleTemplates
    .map((t) => `  - ${t.name}: ${t.pattern}${t.example ? ` (e.g. "${t.example}")` : ""}`)
    .join("\n");

  const prompt = [
    `A faceless YouTube channel (niche: ${input.niche}) declares both TITLE FAMILIES (formats its videos should use) and FORBIDDEN TOPICS (content its videos must never be). Both are the channel's OWN rules, written by the same operator. Your job: find families whose FAITHFUL instances would violate a forbidden topic — a config that blocks its own declared formats.`,
    `FORBIDDEN TOPICS:\n${rules}`,
    `DECLARED TITLE FAMILIES:\n${families}`,
    [
      "Report a finding ONLY when a title written exactly as a family prescribes would fall under a forbidden topic — i.e. the family's stated purpose and the topic's prohibition overlap on MEANING, not wording.",
      "For each finding: the family's name, the forbidden topic quoted verbatim, and one sentence of evidence explaining the collision.",
      "Do NOT report families that merely COULD be misused — only ones whose canonical, on-purpose instances collide. A clean config returns an empty findings array.",
    ].join("\n"),
  ].join("\n\n");

  return runAgent("config_consistency", "cheap", ctx, "titleTemplates vs forbiddenTopics", async (model) => {
    const res = await generateObject({
      model,
      schema: configConsistencySchema,
      experimental_repairText: repairDoubleEncodedJson,
      system:
        "TASK:config_consistency — You audit a YouTube channel's own configuration for self-contradiction. " +
        "You compare declared title families against declared forbidden topics and report collisions where following one rule violates the other. " +
        "Match on meaning, not wording. Report only real, canonical collisions — not hypothetical misuse.",
      prompt,
    });
    return { object: res.object, usage: res.usage };
  });
}
