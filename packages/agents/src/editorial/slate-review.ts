import { generateObject } from "ai";
import {
  slateSemanticSchema,
  type SlateIdea,
  type SlateSemanticResult,
  type TitleTemplate,
} from "@ytauto/core";
import { runAgent, type AgentCtx, repairDoubleEncodedJson } from "../run-agent";

/**
 * Semantic slate review (ticket 01KY2BJ9…): the checks the deterministic core
 * CAN'T make — a title/angle that violates a channel's forbiddenTopics phrased
 * differently from the rule ("Enoch's Calendar Has 364 Days" vs "mechanics of the
 * luminaries"), an overclaim that contradicts a stored rule, title-family drift,
 * and substance overlap. Prompted ADVERSARIALLY ("find what's wrong"), never "does
 * this look good" — a reviewer asked to approve will approve (ticket 01KY1Y9E…).
 * Cheap tier: this is text classification against provided rules, not generation.
 */
export async function reviewSlateSemantic(
  ctx: AgentCtx,
  input: {
    niche: string;
    forbiddenTopics: string[];
    titleTemplates?: TitleTemplate[];
    /** verification-bar context so overclaim-vs-rule can reason about the bar */
    verificationBarNote?: string;
    slate: SlateIdea[];
  },
): Promise<SlateSemanticResult> {
  // Nothing to check semantically without rules AND ideas.
  if (input.slate.length === 0) return { findings: [] };

  const rules = input.forbiddenTopics.length
    ? input.forbiddenTopics.map((t, i) => `  F${i}. ${t}`).join("\n")
    : "  (none declared)";
  const families = input.titleTemplates?.length
    ? input.titleTemplates.map((t) => `  - ${t.name}: ${t.pattern}${t.example ? ` (e.g. "${t.example}")` : ""}`).join("\n")
    : "  (none declared — skip title_family_drift)";
  const items = input.slate
    .map((idea, i) => `  [${i}] title: ${idea.title}\n       angle: ${idea.angle ?? "(none)"}${idea.arc ? `\n       arc: ${idea.arc}` : ""}`)
    .join("\n");

  const prompt = [
    "You are reviewing a BATCH of proposed video ideas against a channel's OWN stored rules, BEFORE they enter the backlog. Your job is to find VIOLATIONS, not to approve. Assume the author overlooked a rule they wrote earlier.",
    `FORBIDDEN TOPICS (the channel's own constraints — a title OR angle that falls under any of these is a VIOLATION, even if worded completely differently):\n${rules}`,
    input.verificationBarNote ? `VERIFICATION BAR: ${input.verificationBarNote}` : "",
    `DECLARED TITLE FAMILIES:\n${families}`,
    `PROPOSED SLATE (${input.slate.length} ideas):\n${items}`,
    [
      "Return a findings array. For each problem, give the idea's index, a severity, a rule slug, and one sentence of evidence naming the specific stored rule it hits:",
      "- severity 'block', rule 'forbidden_topic': the title OR angle falls under a FORBIDDEN TOPIC (semantic match — e.g. 'Enoch's Calendar Has 364 Days' IS 'mechanics of the luminaries / abstract cosmology'). Quote which Fn it hits.",
      "- severity 'block', rule 'overclaim_vs_rule': an assertive certainty claim ('proved', 'confirmed') on a matter a forbidden topic marks contested/unsettled.",
      "- severity 'advise', rule 'title_family_drift': the title matches NONE of the declared families (skip if none declared).",
      "- severity 'advise', rule 'substance_overlap': two ideas cover materially the same ground under different titles (name both indices in the evidence).",
      "- severity 'advise', rule 'family_interchangeable': two+ titles WITHIN the same declared family are near-interchangeable (same verb, same rhythm, same payoff shape) — that reads as templated. This is the intra-family version of clustering; only when titleTemplates are declared.",
      "CRITICAL — distinguish a CLAIM ABOUT an institution/person (disparagement, allegation, attribution of motive, contested assertion) from a NEUTRAL STATEMENT of what a tradition's practice or canon simply IS. A rule like 'claims about current religious institutions' targets the FORMER. 'Ethiopia's church still treats Enoch as scripture' is a neutral, verifiable fact — do NOT block it. Likewise separate manuscript dating (often mainstream) from composition dating (often contested); only block the contested one.",
      "Only report real problems. An idea with no problem gets no finding. Do not invent forbidden topics that aren't listed, and do not block neutral descriptive facts.",
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");

  return runAgent("slate_review", "cheap", ctx, `review slate of ${input.slate.length} ideas`, async (model) => {
    const res = await generateObject({
      model,
      schema: slateSemanticSchema,
      experimental_repairText: repairDoubleEncodedJson,
      system:
        "TASK:slate_review — You are an adversarial pre-flight reviewer for a faceless YouTube channel's idea backlog. " +
        "You test proposed titles/angles against the channel's OWN forbiddenTopics and declared title families. " +
        "forbiddenTopics violations are BLOCK authority and must not be rationalised away — if an idea plausibly falls under a rule, flag it. " +
        "Match on MEANING, not wording. BUT do not over-fire: a neutral, verifiable statement of what a tradition's canon or practice IS is not the same as a disparaging or contested CLAIM about that institution — block the latter, not the former. " +
        "Be precise: cite the specific rule index each finding hits. Do not flag ideas that are clean.",
      prompt,
    });
    return { object: res.object, usage: res.usage };
  });
}
