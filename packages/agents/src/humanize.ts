import { generateObject } from "ai";
import {
  humanizedScriptSchema,
  personaSystemBlock,
  type FactualityMode,
  type PersonaDoc,
  type ScriptOutput,
} from "@ytauto/core";
import { temperatureFor } from "@ytauto/providers";
import { runAgent, repairDoubleEncodedJson, type AgentCtx } from "./run-agent";

/**
 * The humanize/editor pass (BACKLOG #21, audit §4.2): a separate rewrite call
 * between draft and factuality proof that strips the tells of constructed
 * writing and puts the script in the channel persona's actual voice. This is
 * the vendor-canonical draft → review → refine chain.
 *
 * Fact discipline: the pass may not add, remove, or alter factual substance;
 * on gated channels the factuality proof re-runs AFTER it as the backstop.
 * Structure discipline: beat count/order are preserved — a mismatch makes the
 * caller keep the original draft (fail-safe), so this pass can only improve.
 */
export async function humanizeScript(
  ctx: AgentCtx,
  input: {
    script: ScriptOutput;
    persona: PersonaDoc;
    factualityMode: FactualityMode;
    /** the channel kind — affects register ("Short" vs "long-form video") */
    kind: string;
  },
): Promise<ScriptOutput & { editNotes?: string }> {
  const factRule =
    input.factualityMode === "entertainment"
      ? "You may rephrase freely, but do NOT introduce a new checkable real-world claim stated as fact."
      : "You may NOT add, remove, or alter any factual claim, statistic, name, date, or event — " +
        "rewrite the phrasing around the same substance. Hedged framings like 'no one knows' or " +
        "'the story goes' must stay hedged.";

  const system = [
    "TASK:humanize — You are the script editor for this channel, with a sharp ear for writing that",
    "reads as constructed rather than spoken. Rewrite the draft the way the person below would",
    "actually SAY it out loud.",
    "",
    personaSystemBlock(input.persona),
    "",
    "YOUR EDIT, line by line:",
    "- Cut anything rehearsed, overbuilt, or written to sound impressive. Rougher and more direct wins.",
    "- Make the ideas move the way a real mind moves: uneven — punchy in places, slower where it matters. Break any stretch where every sentence has the same shape or length.",
    "- Strip the tells of generated writing one by one: neutral crowd-pleasing tone, tidy triads, \"isn't just X, it's Y\" constructions, em-dash chains, summary sentences that re-state what was just said.",
    "- One real point of view: let the persona's opinions and small shifts in tone come through; never a neutral observer trying to please everyone.",
    "- Test every sentence: would it survive being said out loud without second-guessing? If it sounds too clean to be a person, rewrite it.",
    "- Keep what already lands. This is an edit, not a do-over.",
    "",
    "HARD CONSTRAINTS:",
    `- ${factRule}`,
    // Hedge-by-default on balanced channels (scripting-loop incident, FIX 4):
    // the edit pass must not "tighten" hedged glue into flat assertions.
    ...(input.factualityMode === "balanced"
      ? [
          "- Narrative-glue claims (who knew what, 'first'/'only'/'never' statements, simultaneity, motives) must be HEDGED ('as far as either knew', 'the records suggest') unless a VERIFIED FACT states them directly — hedged framing is the default for connective tissue; never sharpen a hedge into a flat assertion.",
        ]
      : []),
    "- SAME number of beats, SAME order, one rewritten text per beat; each beat keeps its meaning and job.",
    `- The hook stays an open loop spoken in the first 1-2 seconds of this ${input.kind}.`,
    "- Total length stays within ±10% of the draft (word count).",
    "- Keep the closing call-to-action's intent (rephrase it in-voice).",
  ].join("\n");

  const prompt = [
    `HOOK: ${input.script.hookText}`,
    "BEATS:",
    ...input.script.beats.map((b, i) => `${i + 1}. [${b.type}] ${b.text}`),
  ].join("\n");

  const out = await runAgent(
    "humanize_editor",
    "agentic",
    ctx,
    `humanize pass over ${input.script.beats.length}-beat script`,
    async (model) => {
      const res = await generateObject({
        model,
        schema: humanizedScriptSchema,
        experimental_repairText: repairDoubleEncodedJson,
        temperature: temperatureFor(ctx.llm.modelId("agentic"), "editor"),
        system,
        prompt,
      });
      return { object: res.object, usage: res.usage };
    },
  );

  // Fail-safe: structure must survive the rewrite or we keep the draft.
  if (out.beats.length !== input.script.beats.length) return input.script;

  const draftWords = input.script.fullText.split(/\s+/).filter(Boolean).length;
  const beats = input.script.beats.map((b, i) => ({ ...b, text: out.beats[i]!.text }));
  const fullText = beats.map((b) => b.text).join(" ");
  const newWords = fullText.split(/\s+/).filter(Boolean).length;
  // Guard against a rewrite that gutted the runtime (>25% shrink) — keep draft.
  if (newWords < draftWords * 0.75) return input.script;

  return {
    ...input.script,
    hookText: out.hookText,
    beats,
    fullText,
    editNotes: out.editNotes,
  };
}
