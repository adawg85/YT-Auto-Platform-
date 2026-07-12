import { z } from "zod";

/**
 * Golden-set eval harness (#21.2.5 / PROMPT-AUDIT §6). The judge scores what a
 * model CAN'T be graded on deterministically; everything countable (AI tells,
 * length adherence, unsupported claims) is computed in code so the numbers are
 * reproducible and model-independent.
 */

/** Cost/agent-action attribution channel for eval spend (no real channel row). */
export const EVAL_CHANNEL_ID = "eval-harness";

/**
 * Judge rubric output. Bounds are describe-hints, not zod .min/.max — real
 * models overshoot hard bounds (2026-07-08 learning #2); callers clamp.
 */
export const scriptJudgeSchema = z.object({
  factCompliance: z
    .number()
    .describe(
      "0-10: does the script assert only what the VERIFIED FACTS support (10 = every claim supported or properly hedged)",
    ),
  hookStrength: z
    .number()
    .describe("0-10: would the first two seconds stop a scroller — open loop, specificity, tension"),
  voiceNaturalness: z
    .number()
    .describe(
      "0-10: read aloud, does this sound like ONE real person talking (10) or generated filler (0)",
    ),
  overall: z.number().describe("0-10: overall publishable quality of this narration script"),
  rationale: z.string().describe("2-3 sentences: the main strengths/defects driving the scores"),
});
export type ScriptJudgeScores = z.infer<typeof scriptJudgeSchema>;

export const clampScore = (n: number): number => Math.max(0, Math.min(10, Math.round(n * 10) / 10));

/**
 * AI-tell phrases (audit §6: blind read-aloud + AI-tell count). Kept aligned
 * with the persona archetypes' shared avoid-list — these are the phrases that
 * mark text as generated to a reader.
 */
export const AI_TELL_PHRASES = [
  "isn't just",
  "isn't merely",
  "delve",
  "dive into",
  "let's explore",
  "in today's video",
  "game-changer",
  "game changer",
  "rich tapestry",
  "testament to",
  "in the world of",
  "it's important to note",
  "at the end of the day",
] as const;

export type AiTellMetrics = {
  /** total occurrences of known AI-tell phrases (case-insensitive) */
  aiTellCount: number;
  /** em-dash count per 100 words — chained em-dashes are a strong tell */
  emDashPer100Words: number;
  /** sentence count the variance was computed over */
  sentences: number;
  /** stdev of sentence word-lengths — low variance reads robotic */
  sentenceLenStdev: number;
  words: number;
};

/** Deterministic AI-tell metrics over narration text (pure, unit-tested). */
export function aiTellMetrics(text: string): AiTellMetrics {
  const lower = text.toLowerCase();
  let aiTellCount = 0;
  for (const phrase of AI_TELL_PHRASES) {
    let idx = 0;
    while ((idx = lower.indexOf(phrase, idx)) !== -1) {
      aiTellCount++;
      idx += phrase.length;
    }
  }
  const words = text.split(/\s+/).filter(Boolean).length;
  const emDashes = (text.match(/—/g) ?? []).length;
  const sentenceList = text
    .split(/[.!?]+(?:\s+|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const lens = sentenceList.map((s) => s.split(/\s+/).filter(Boolean).length);
  const mean = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  const variance = lens.length
    ? lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length
    : 0;
  return {
    aiTellCount,
    emDashPer100Words: words ? Math.round((emDashes / words) * 100 * 100) / 100 : 0,
    sentences: sentenceList.length,
    sentenceLenStdev: Math.round(Math.sqrt(variance) * 100) / 100,
    words,
  };
}

/** Per-result deterministic metrics stored on eval_results.metrics. */
export type EvalMetrics = AiTellMetrics & {
  /** words ÷ word budget (targetLengthSec × 2.5 wps), as a percentage */
  targetAdherencePct: number;
  /** unsupported-claim count from the fixed factuality-proof instrument */
  unsupportedClaims: number;
  beatCount: number;
  /** candidate-chain LLM spend (judge/proof instruments excluded) */
  costUsd: number;
  durationMs: number;
};
