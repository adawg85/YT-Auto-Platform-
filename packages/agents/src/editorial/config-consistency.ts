import { generateObject } from "ai";
import {
  configConsistencySchema,
  isProhibitionFamily,
  type ConfigConsistencyResult,
  type TitleTemplate,
} from "@ytauto/core";
import { runAgent, type AgentCtx, repairDoubleEncodedJson } from "../run-agent";

/**
 * #109: write-time check that a channel's declared titleTemplates and its own
 * forbiddenTopics don't contradict each other — run ONCE at set_channel_config
 * instead of surfacing as a review_slate block after authoring work is spent.
 *
 * #113 (live false-positive report, 7 warnings across 5 well-formed families):
 * the test is "FAITHFUL instances violate", never "could produce a violating
 * instance" — any family permissive enough to be useful ADMITS a violating
 * instance, and flagging that penalises exactly the permissiveness that keeps a
 * catalogue varied. Two brakes: prohibition-style entries ("NEVER SHIP:",
 * "BANNED -") are excluded deterministically before the model ever sees them
 * (they are constraints, not templates), and the schema REQUIRES the evaluator
 * to produce the faithful instance it claims violates — a violation reachable
 * only by steering into it cannot fill that field honestly.
 *
 * Cheap tier: text classification against provided rules. ADVISORY — the
 * config is stored as written either way.
 */
export async function checkConfigConsistency(
  ctx: AgentCtx,
  input: {
    niche: string;
    forbiddenTopics: string[];
    titleTemplates: TitleTemplate[];
  },
): Promise<ConfigConsistencyResult> {
  // #113: prohibition entries are the operator's own guard-rails written into
  // the templates list — never templates to test for conformance.
  const families = input.titleTemplates.filter((t) => !isProhibitionFamily(t));
  if (!input.forbiddenTopics.length || !families.length) return { findings: [] };

  const rules = input.forbiddenTopics.map((t, i) => `  F${i}. ${t}`).join("\n");
  const familyList = families
    .map((t) => `  - ${t.name}: ${t.pattern}${t.example ? ` (e.g. "${t.example}")` : ""}`)
    .join("\n");

  const prompt = [
    `A faceless YouTube channel (niche: ${input.niche}) declares both TITLE FAMILIES (formats its videos should use) and FORBIDDEN TOPICS (content its videos must never be). Both are the channel's OWN rules, written by the same operator. Your job: find families that CANNOT BE INSTANTIATED COMPLIANTLY — where following the family's own instructions faithfully produces a title a forbidden topic prohibits.`,
    `FORBIDDEN TOPICS:\n${rules}`,
    `DECLARED TITLE FAMILIES:\n${familyList}`,
    [
      "THE TEST IS 'CANNOT AVOID', NEVER 'COULD PRODUCE'. Before flagging a family, mentally write ONE compliant title that follows the family's instructions faithfully. If you can — and for any well-formed family you almost always can — there is NO finding. A family that merely ADMITS a violating instance is fine: catching individual bad titles is review_slate's per-title job, not this check's.",
      "NOT a contradiction (do not flag): a curiosity-gap family vs a manipulation topic, because 'the gap COULD be \"How to Make Anyone Obey\"' — that is an invented, steered instance, not a faithful one. A keyword-first family vs a medical-advice topic for the same reason. If your evidence contains 'if the gap were…' or 'permits…' or 'can produce…', you are reasoning about admission, not faithfulness — stop.",
      "IS a contradiction (flag it): a family whose own pattern/purpose IS the prohibited thing — e.g. pattern 'promise a guaranteed income outcome from the method' vs a forbidden topic banning income promises. Following that family faithfully violates the rule every time.",
      "For each finding you MUST supply faithfulInstance: a complete example title that is a canonical, on-purpose instance of the family AND violates the topic. If you cannot write one without deliberately steering into the violation, there is no finding.",
      "A clean config returns an empty findings array — that is the expected result for a well-run channel.",
    ].join("\n"),
  ].join("\n\n");

  return runAgent("config_consistency", "cheap", ctx, "titleTemplates vs forbiddenTopics", async (model) => {
    const res = await generateObject({
      model,
      schema: configConsistencySchema,
      experimental_repairText: repairDoubleEncodedJson,
      system:
        "TASK:config_consistency — You audit a YouTube channel's own configuration for GENUINE self-contradiction: a title family whose faithful, on-purpose instances violate the channel's own forbidden topics. " +
        "The bar is 'cannot be instantiated compliantly', never 'admits a violating instance' — flagging mere permissiveness pushes operators toward narrow fill-in-the-blank templates, the exact mass-production signature these rules exist to prevent. " +
        "Expect to return zero findings on a well-formed config. Every finding must carry the faithful instance that proves it.",
      prompt,
    });
    return { object: res.object, usage: res.usage };
  });
}
