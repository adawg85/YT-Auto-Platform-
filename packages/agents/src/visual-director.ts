import { generateObject } from "ai";
import { visualSequenceSchema, type VisualSequence } from "@ytauto/core";
import { temperatureFor } from "@ytauto/providers";
import { runAgent, repairDoubleEncodedJson, type AgentCtx } from "./run-agent";

/**
 * Visual Director (#37, 2026-07-16). Reads the WHOLE script and writes a
 * coherent visual sequence — cutting on MEANING (a new idea = a new shot),
 * arced across the video, medium-aware (it picks still / clip / real footage
 * only from what the channel allows). Downstream, `planShotsFromDirection`
 * places these shots on the real clock and the prompt builder articulates each
 * one. Opt-in per channel; a malformed pass falls back to the mechanical cut.
 */

export interface DirectorInput {
  beats: {
    type: string;
    text: string;
    visualBrief?: string | null;
    referenceEntity?: string | null;
    heroShot?: boolean;
  }[];
  durationSec: number;
  niche: string;
  orientation: "portrait" | "landscape";
  /** the channel's distilled style block (styleBlockForImagePrompts output) */
  styleBlock?: string | null;
  characters?: { name: string; description: string }[];
  /** channel visual intent — determines the allowed media palette */
  visualMode: string; // simple | real_footage | ai_images | ai_video | mixed
  motion: string; // static | partial | ai_video
  maxAiClips: number;
  /** cadence target — roughly how many shots the operator's Rhythm/density wants */
  targetShotCount: number;
}

export async function directVisualSequence(ctx: AgentCtx, input: DirectorInput): Promise<VisualSequence | null> {
  const allowMotion = input.motion !== "static";
  const allowReal = input.visualMode === "real_footage" || input.visualMode === "mixed";
  const palette = [
    "still (a generated image)",
    ...(allowMotion ? ["motion (a short animated clip made from the still)"] : []),
    ...(allowReal ? ["real_footage (a sourced real archival photo/clip)"] : []),
  ];

  const system = [
    "TASK:visual-director — You are the DIRECTOR of a short narrated video. You receive the whole",
    "script as numbered beats and design its VISUAL SEQUENCE: an ordered list of shots that tells",
    "the story with pictures. Think like a film editor building a storyboard, not a per-line",
    "illustrator.",
    "",
    "RULES:",
    "- CUT ON MEANING: start a new shot when the narration moves to a new idea/subject; keep one",
    `  idea in one shot even across sentences. Aim for about ${input.targetShotCount} shots total`,
    "  (you may deviate for the story), and NEVER make a shot shorter than a couple of seconds.",
    "- COVER EVERY WORD: within each beat, your shots' narrationSpan values must TILE the beat's",
    "  narration in order — no gaps, no overlaps, every word covered. Copy the spans verbatim from",
    "  the beat text, split at natural points.",
    "- ARC: open with an establishing shot; vary shot scale (wide/medium/close/insert) and angle",
    "  across the sequence; build to the hero beats; resolve on the closing beat.",
    "- NEVER TWO ALIKE: no two shots may look the same — not adjacent and not distant. When a motif",
    "  must recur (a device, a place, a diagram), tag it in `motif` and render it from a NEW scale",
    "  or angle each time.",
    `- MEDIUM: choose each shot's medium ONLY from this channel's allowed palette: ${palette.join("; ")}.`,
    allowMotion
      ? `  Use "motion" for genuinely dynamic beats, at most ~${input.maxAiClips} clips in the whole video (clips are expensive); everything else is "still".`
      : '  This channel is stills-only — every shot must be "still".',
    allowReal
      ? '  Use "real_footage" for real, nameable subjects (a named place/person/event) that a photo archive would have; generate ("still"/"motion") for abstract or stylised scenes.'
      : "  This channel does not use real footage — never choose real_footage.",
    input.characters?.length
      ? `- CHARACTERS you may place (by name, deliberately — opener, hero, emotional beats; leave diagrams/establishing shots character-free): ${input.characters.map((c) => c.name).join(", ")}.`
      : "- This channel has no recurring characters; set character to null.",
    "- Mark `hero` true ONLY on the genuine peak frames (roughly the beats already flagged hero).",
    "- Write one line of `intent` per shot — what it should convey/feel like — for the prompt writer.",
    input.styleBlock ? `\nCHANNEL VISUAL STYLE (every shot lives in this world):\n${input.styleBlock}` : "",
    `\nNICHE: ${input.niche} · ORIENTATION: ${input.orientation === "portrait" ? "vertical 9:16" : "widescreen 16:9"} · DURATION: ~${Math.round(input.durationSec)}s`,
  ]
    .filter(Boolean)
    .join("\n");

  const userPrompt = [
    "BEATS (design shots that cover every beat, in order):",
    ...input.beats.map((b, i) =>
      [
        `#${i} [${b.type}]${b.heroShot ? " (HERO beat)" : ""}: ${b.text}`,
        b.visualBrief ? `   brief: ${b.visualBrief}` : "",
        b.referenceEntity ? `   real subject available: ${b.referenceEntity}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  ].join("\n");

  try {
    const out = await runAgent(
      "visual_director",
      "frontier",
      ctx,
      `direct ${input.beats.length} beats into a visual sequence`,
      async (model, modelId) => {
        const res = await generateObject({
          model,
          schema: visualSequenceSchema,
          experimental_repairText: repairDoubleEncodedJson,
          temperature: temperatureFor(modelId, "creative"),
          system,
          prompt: userPrompt,
        });
        return { object: res.object, usage: res.usage };
      },
    );
    if (!out?.shots?.length) return null;
    return out;
  } catch {
    // any failure → caller falls back to the mechanical shot plan
    return null;
  }
}
