import { eq } from "drizzle-orm";
import { generateObject } from "ai";
import { channels, type channelDna, type ideas } from "@ytauto/db";
import {
  patternGrounding,
  patternsToPromptLines,
  personaSystemBlock,
  scriptOutputSchema,
  type FactualityMode,
  type PersonaDoc,
  type ScriptOutput,
} from "@ytauto/core";
import { temperatureFor } from "@ytauto/providers";
import { runAgent, repairDoubleEncodedJson, type AgentCtx } from "./run-agent";

// Structural subsets (no Date fields) so callers can pass rows that have
// round-tripped through JSON, e.g. Inngest step outputs.
type Idea = Pick<typeof ideas.$inferSelect, "id" | "channelId" | "title" | "angle">;
type Dna = Pick<
  typeof channelDna.$inferSelect,
  "tone" | "audiencePersona" | "hookStyles" | "visualStyle" | "voiceId" | "ctaTemplate" | "targetLengthSec"
>;

/**
 * Scriptwriter agent (frontier tier): drafts original substance onto the
 * proven hook→stat→insight→cta skeleton. Format is templated; substance must
 * be materially varied — the substanceFingerprint it returns feeds the
 * variation check.
 */
export type HookTemplateInput = {
  name: string;
  archetype: string;
  skeleton: { first2s: string; beatPlan: string[]; payoffPlacement: string; loopOrCta: string };
};

/** Narration pace (~150 wpm) used for the word budget and per-beat estimates. */
const SPEAKING_WPS = 2.5;
/** Accept a draft once it reaches this fraction of the word budget. */
const LENGTH_FLOOR = 0.85;
/** Extra expand attempts if the first draft comes in under the floor. */
const MAX_LENGTH_RETRIES = 2;

const wordsOf = (t: string) => t.split(/\s+/).filter(Boolean).length;

export async function draftScript(
  ctx: AgentCtx,
  idea: Idea,
  dna: Dna | undefined,
  opts: {
    revisionNotes?: string;
    targetLengthSec?: number;
    hookTemplate?: HookTemplateInput;
    /** build #5 factuality gate: the ONLY facts the script may assert */
    verifiedFacts?: { id: string; tier: string; text: string }[];
    /** BACKLOG #21.3: conjecture claims — tellable only with hedged framing */
    conjecture?: { id: string; tier: string; text: string }[];
    /** BACKLOG #21.3: how hard facts constrain this channel (default balanced) */
    factualityMode?: FactualityMode;
    /** BACKLOG #21.1: the channel's writing persona (system-prompt voice) */
    persona?: PersonaDoc;
    /** build #5 memory: channel state-of-the-world + retrieved evidence */
    groundingContext?: string;
    /** build #5.2: the active experiment's single-variable directive */
    experimentDirective?: string;
  } = {},
): Promise<ScriptOutput> {
  const targetLen = opts.targetLengthSec ?? dna?.targetLengthSec ?? 40;
  const wordBudget = Math.round(targetLen * SPEAKING_WPS); // ≈ speaking pace
  const minWords = Math.round(wordBudget * LENGTH_FLOOR);
  const mode: FactualityMode = opts.factualityMode ?? "balanced";
  // Factuality-gated channel: the script may assert ONLY the verified facts, so
  // length must come from elaborating them, never from inventing new claims.
  // Entertainment mode treats facts as inspiration, not a constraint (#21.3).
  const factConstrained = !!opts.verifiedFacts?.length && mode !== "entertainment";

  // Shared pattern store grounding (build #4): the hook shapes + beat structures
  // proven in this niche right now, own + external. Shape only — the writer
  // still produces original substance (enforced by the variation check).
  const [channel] = await ctx.db
    .select({ niche: channels.niche, contentFormat: channels.contentFormat })
    .from(channels)
    .where(eq(channels.id, idea.channelId));

  // Format drives everything: a long-form channel (or a long target) must be
  // written to fill minutes, not seconds. The prior version hardcoded "Short",
  // so long-form scripts came out Shorts-length and never filled the runtime.
  const isLong = channel?.contentFormat === "long" || targetLen > 90;
  const groundFormat = isLong ? "long" : "shorts";
  const minBeats = isLong ? Math.max(8, Math.round(targetLen / 30)) : 4;
  const maxBeats = isLong ? Math.max(minBeats + 2, Math.round(targetLen / 15)) : 8;
  const kind = isLong ? "long-form video" : "Short";

  const ground = channel
    ? await patternGrounding(ctx.db, { niche: channel.niche, format: groundFormat, perKind: 3 })
    : { hooks: [], structures: [], topics: [] };

  const basePrompt = [
    `IDEA TITLE: ${idea.title}`,
    `IDEA ANGLE: ${idea.angle}`,
    `TONE: ${dna?.tone ?? "punchy, curious, plain language"}`,
    `AUDIENCE: ${dna?.audiencePersona ?? (isLong ? "engaged long-form viewers" : "general short-form viewers")}`,
    `HOOK STYLES TO PREFER: ${(dna?.hookStyles ?? []).join(", ") || "curiosity_gap"}`,
    ground.hooks.length
      ? `HOOK PATTERNS WORKING IN THIS NICHE (shape suggestions ONLY — they never override the story or the facts; write ORIGINAL substance):\n${patternsToPromptLines(ground.hooks).join("\n")}`
      : "",
    ground.structures.length
      ? `PROVEN BEAT STRUCTURES IN THIS NICHE (suggestions, same rule):\n${patternsToPromptLines(ground.structures).join("\n")}`
      : "",
    opts.hookTemplate
      ? [
          `STRUCTURE SKELETON (${opts.hookTemplate.name} / ${opts.hookTemplate.archetype}):`,
          `  first 2s: ${opts.hookTemplate.skeleton.first2s}`,
          `  beats: ${opts.hookTemplate.skeleton.beatPlan.join(" → ")}`,
          `  payoff: ${opts.hookTemplate.skeleton.payoffPlacement}`,
          `  close: ${opts.hookTemplate.skeleton.loopOrCta}`,
        ].join("\n")
      : "",
    opts.verifiedFacts?.length
      ? mode === "entertainment"
        ? [
            "RESEARCH MATERIAL (inspiration, not a cage — you may embellish for fun,",
            "but never state a false checkable real-world claim as fact):",
            ...opts.verifiedFacts.map((f) => `[claim:${f.id}] [${f.tier}] ${f.text}`),
          ].join("\n")
        : [
            "VERIFIED FACTS (cite ONLY these — do not invent facts; claims tagged",
            "[emerging]/[contested] must be framed as reported/claimed, never asserted):",
            ...opts.verifiedFacts.map((f) => `[claim:${f.id}] [${f.tier}] ${f.text}`),
          ].join("\n")
      : "",
    opts.conjecture?.length && mode !== "strict"
      ? [
          "CONJECTURE (uncorroborated but tellable — use ONLY with hedged framing like",
          "'the story goes', 'according to legend', 'no one knows why'; NEVER assert as fact.",
          "Unknowns are hooks: lean into the mystery rather than papering over it):",
          ...opts.conjecture.map((f) => `[claim:${f.id}] ${f.text}`),
        ].join("\n")
      : "",
    opts.groundingContext ? `CHANNEL CONTEXT (continuity — don't contradict or repeat):\n${opts.groundingContext}` : "",
    opts.experimentDirective
      ? `EXPERIMENT DIRECTIVE (apply this ONE deliberate change, keep everything else standard): ${opts.experimentDirective}`
      : "",
    `IMAGE STYLE: ${dna?.visualStyle?.imageStyle ?? "clean flat illustration, high contrast"}`,
    `CTA: ${dna?.ctaTemplate ?? "Follow for more."}`,
    `TARGET LENGTH: this is a ${kind} that must run about ${targetLen}s of narration — write ~${wordBudget} words total (no fewer than ${minWords}) across ${minBeats}–${maxBeats} beats. ${
      factConstrained
        ? "Fill the runtime by elaborating the VERIFIED FACTS above — depth, mechanism, stakes and pacing — NOT by inventing new facts."
        : "Fill the whole runtime with real substance"
    }; do NOT stop short.`,
    opts.revisionNotes ? `REVISION NOTES: ${opts.revisionNotes}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  // Persona-first system prompt (BACKLOG #21.1, verified vendor ordering:
  // Identity → Instructions → Exemplars, task mechanics after). The persona is
  // WHO is speaking; the user prompt carries this episode's content.
  const personaBlock = opts.persona ? personaSystemBlock(opts.persona) + "\n\n" : "";
  const system =
    `TASK:script — You are writing the spoken narration for a faceless YouTube ${kind}.\n\n` +
    personaBlock +
    "THE JOB: " +
    `Write on the hook→stat→insight→cta skeleton` +
    (isLong ? ", expanded across many beats to fill the full target runtime. " : ". ") +
    "The structure is templated but the SUBSTANCE must be original and specific: concrete facts, numbers, mechanisms — never generic filler. " +
    "Write for the EAR, not the page — this will be spoken aloud by one person; read each sentence back as speech and vary the rhythm. " +
    "The hook is spoken in the first 1-2 seconds and must create an open loop. " +
    (isLong
      ? "Sustain retention with escalating stat/insight beats, then close with the CTA. "
      : "") +
    "CREATIVE LATITUDE: the skeleton is the default, not a cage — when this story is better served by a pure story beat, a slower turn, or an unresolved ending, do that and pick the closest beat type. The facts rules are never negotiable; the shape is. " +
    "Each beat gets an imagePrompt: the SCENE you want on screen (subject first, concrete), in the given IMAGE STYLE — a builder pass finalises the wording. " +
    "For any beat that depicts a SPECIFIC real subject (a named aircraft, person, place, or event), set referenceEntity to that subject's canonical name (e.g. 'Supermarine Spitfire') so a real photo can be sourced; leave it null for abstract/conceptual beats. " +
    `The narration must be long enough to run ~${targetLen}s (~${wordBudget} words); write enough beats and depth to fill it. ` +
    "substanceFingerprint must be 'topic | hook claim | fact1 | fact2 | fact3' — lowercase, terse.";

  // Draft, then enforce the duration: if the model comes in short (common for
  // long-form), re-prompt to expand — keeping the best draft so we never
  // regress. Each attempt goes through runAgent, so its spend is recorded.
  // On a factuality-gated channel the expansion must NOT invent new claims — it
  // reaches length by elaborating the SAME verified facts (else the expanded
  // script asserts ungrounded facts and the review board blocks it later).
  let best: ScriptOutput | undefined;
  let bestWords = -1;
  let expandNote = "";
  for (let attempt = 0; attempt <= MAX_LENGTH_RETRIES; attempt++) {
    const prompt = expandNote ? `${basePrompt}\n\n${expandNote}` : basePrompt;
    const out = await runAgent(
      "scriptwriter",
      "frontier",
      ctx,
      `draft script v-next for: ${idea.title}${attempt ? ` (expand ${attempt})` : ""}`,
      async (model) => {
        const res = await generateObject({
          model,
          schema: scriptOutputSchema,
          experimental_repairText: repairDoubleEncodedJson,
          temperature: temperatureFor(ctx.llm.modelId("frontier"), "creative"),
          system,
          prompt,
        });
        return { object: res.object, usage: res.usage };
      },
    );
    const w = wordsOf(out.fullText);
    if (w > bestWords) {
      best = out;
      bestWords = w;
    }
    if (w >= minWords) break;
    expandNote = [
      `LENGTH CHECK: the last draft was ${w} words (~${Math.round(w / SPEAKING_WPS)}s), short of the ~${targetLen}s target (~${wordBudget} words).`,
      factConstrained
        ? `Rewrite it LONGER — reach at least ${minWords} words WITHOUT introducing any new factual claim, statistic, name, date, or event. Assert ONLY the VERIFIED FACTS listed above. Reach the length by finding NEW angles on the same facts — walk the mechanism step by step, set the scene around a fact, contrast then vs now, follow one detail's consequences — and pace the reveal across ${minBeats}–${maxBeats} beats. Analogy/framing is fine only if it asserts no new fact. Never restate a point already made; keep the hook and CTA tight.`
        : `Rewrite it LONGER — reach at least ${minWords} words by adding depth: more concrete examples, mechanisms and context, and additional stat/insight beats (aim ${minBeats}–${maxBeats} beats). Never restate a point already made; keep the hook and CTA tight.`,
      `Draft to expand:\n${best?.fullText ?? out.fullText}`,
    ].join("\n");
  }

  const result = best!;
  // Attach computed per-beat duration estimates (for the reviewer; the render
  // uses the real voiceover word-timestamps, not these).
  result.beats = result.beats.map((b) => ({
    ...b,
    estSec: Math.max(1, Math.round((wordsOf(b.text) / SPEAKING_WPS) * 10) / 10),
  }));
  return result;
}
