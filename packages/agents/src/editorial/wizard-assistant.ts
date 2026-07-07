import { generateObject } from "ai";
import { z } from "zod";
import { runAgent, type AgentCtx } from "../run-agent";

/**
 * Channel-setup assistant (build #5 wizard): a conversational co-pilot that
 * persists across every wizard step. It answers the operator in plain language
 * AND may return a `patch` of concrete field edits ("make the mission punchier"
 * → patch.mission), which the wizard merges into its form state. Distinct from
 * the control-plane assistant (runControl) — this one never touches the DB, it
 * only shapes the in-progress channel draft.
 */

/** The editable wizard fields the assistant is allowed to edit. All optional. */
export const wizardPatchSchema = z
  .object({
    niche: z.string(),
    intent: z.string(),
    format: z.enum(["short", "long", "both"]),
    researchDepth: z.enum(["standard", "deep"]),
    cadencePerWeek: z.number().int().min(1).max(21),
    targetLengthSec: z.number().int().min(10).max(1800),
    autonomyTier: z.number().int().min(0).max(3),
    monetisationSafe: z.boolean(),
    name: z.string(),
    handle: z.string(),
    mission: z.string(),
    /** one objective per line */
    objectives: z.string(),
    /** comma-separated authoritative domains */
    domains: z.string(),
    minSources: z.number().int().min(1).max(5),
    presentDebate: z.boolean(),
    tone: z.string(),
    persona: z.string(),
    /** comma-separated */
    hookStyles: z.string(),
    /** comma-separated */
    forbidden: z.string(),
    imageStyle: z.string(),
    cta: z.string(),
  })
  .partial();

export type WizardPatch = z.infer<typeof wizardPatchSchema>;

export type WizardChatTurn = { role: "operator" | "assistant"; text: string };

const responseSchema = z.object({
  reply: z.string().describe("Plain-language reply to the operator (1-4 sentences)."),
  patch: wizardPatchSchema.describe(
    "Only the fields you are changing, with their new values. Empty object if the operator only asked a question.",
  ),
});

export type WizardAssistantResult = z.infer<typeof responseSchema>;

export async function runWizardAssistant(
  ctx: AgentCtx,
  input: {
    step: string;
    fields: WizardPatch;
    history: WizardChatTurn[];
    message: string;
  },
): Promise<WizardAssistantResult> {
  const transcript = input.history
    .map((t) => `${t.role === "operator" ? "OPERATOR" : "ASSISTANT"}: ${t.text}`)
    .join("\n");
  const prompt = [
    `WIZARD STEP: ${input.step}`,
    `CURRENT DRAFT FIELDS (JSON):\n${JSON.stringify(input.fields, null, 2)}`,
    transcript ? `CONVERSATION SO FAR:\n${transcript}` : "",
    `OPERATOR: ${input.message}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  return runAgent(
    "wizard_assistant",
    "agentic",
    ctx,
    input.message,
    async (model) => {
      const res = await generateObject({
        model,
        schema: responseSchema,
        system:
          "TASK:wizard — You are the operator's co-pilot for setting up a faceless, autonomous YouTube channel. " +
          "You help refine the channel's niche, identity, mission, charter and DNA as they move through a setup wizard. " +
          "When the operator asks you to change something, return the concrete new values in `patch` (only the changed fields) " +
          "and describe the change in `reply`. When they only ask a question, leave `patch` empty and answer in `reply`. " +
          "Never invent a channel name the operator rejected; keep edits faithful to what they asked. " +
          "objectives is newline-separated; domains/hookStyles/forbidden are comma-separated.",
        prompt,
      });
      return { object: res.object, usage: res.usage };
    },
  );
}
