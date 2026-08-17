/**
 * Empty-prompt fallback + placeholder detection (#122).
 *
 * A shot whose resolved image prompt is EMPTY used to be sent to the image
 * engine as an empty string: the engine cannot serve it, the routing wrapper
 * degrades to the mock backstop, and a grey placeholder SVG lands in the shot
 * list with `shotCount`/`assetCounts.stills` all reading correct. Nothing warned
 * — the operator found three of them across two channels by scrolling the
 * cockpit, and one of those was a beat authored with `imagePrompts[]` only,
 * whose singular `imagePrompt` was never populated (the documented failure mode
 * for that shape was "duplicate images", never "placeholder frame").
 *
 * These helpers are pure so the fallback ORDER is unit-testable with no image
 * provider, no DB and no LLM: the pipeline resolves every shot through
 * `resolveShotPrompt` before generation, and a placeholder that IS served is
 * detectable after the fact with `isPlaceholderImage`.
 */

/** Where a shot's final prompt came from once the empty case is repaired. */
export type ShotPromptSource =
  /** the shot's own prompt (builder-written or authored) — nothing was repaired */
  | "shot"
  /** (a) the beat's singular `imagePrompt` */
  | "beat_prompt"
  /** (b) a sibling entry of the same beat's `imagePrompts[]` */
  | "sibling_prompt"
  /** (c) the beat's `visualBrief` */
  | "visual_brief"
  /** (d) last resort — a scene line derived from this shot's narration */
  | "narration";

export type ResolvedShotPrompt = { prompt: string; source: ShotPromptSource };

/** A prompt that cannot be generated from: empty, or whitespace only. */
export function isBlankPrompt(p: string | null | undefined): boolean {
  return typeof p !== "string" || p.trim().length === 0;
}

const clean = (s: string | null | undefined): string => (typeof s === "string" ? s.trim() : "");

/**
 * The nearest usable entry of a beat's `imagePrompts[]`, excluding this shot's
 * own ordinal. Nearest-first (ties → the EARLIER sibling) so a beat's shots
 * borrow the prompt of the moment they actually sit next to, and the choice is
 * deterministic across Inngest replays.
 */
function nearestSiblingPrompt(prompts: (string | null)[] | null | undefined, ordinal: number): string {
  if (!Array.isArray(prompts)) return "";
  const usable = prompts.map((p, i) => ({ p: clean(p), i })).filter((x) => x.p && x.i !== ordinal);
  if (!usable.length) return "";
  usable.sort((a, b) => Math.abs(a.i - ordinal) - Math.abs(b.i - ordinal) || a.i - b.i);
  return usable[0]!.p;
}

/** Trim narration to a prompt-sized clause without cutting mid-word. */
function narrationClause(narration: string, max = 180): string {
  const t = clean(narration).replace(/["“”]/g, "");
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > 40 ? cut.slice(0, sp) : cut).replace(/[,;:\s]+$/, "");
}

/**
 * Last-resort prompt derived from the shot's own narration (#122 fallback d).
 *
 * The standing pipeline rule is that narration NEVER enters a generation prompt
 * verbatim — FLUX-family models literalize every noun, so "the workhorse of the
 * fleet" draws a horse. That rule exists to protect image QUALITY; it was never
 * meant to make "no prompt at all" the alternative. So the derivation frames the
 * line as SUBJECT MATTER inside a documentary-still instruction that asks for the
 * literal, physical scene, and the pipeline still prefers an LLM elaboration over
 * this string when one is available. A slightly generic on-topic frame beats a
 * grey placeholder shipping inside a finished video.
 */
export function narrationScenePrompt(input: {
  narration: string;
  referenceEntity?: string | null;
  styleRegister?: string | null;
}): string {
  const subject = clean(input.referenceEntity);
  const line = narrationClause(input.narration);
  const lead = subject ? `${subject}. ` : "";
  const body = line
    ? `A documentary still of the literal, physical scene this moment describes: ${line}. Real setting, one clear focal subject, natural directional lighting, plain unmarked surfaces.`
    : `A documentary still: one clear focal subject in a real setting, natural directional lighting, plain unmarked surfaces.`;
  const style = clean(input.styleRegister);
  return `${lead}${body}${style ? ` ${/^style\s*:/i.test(style) ? style : `Style: ${style}`}` : ""}`;
}

/**
 * Resolve the prompt a shot will actually be generated from, repairing the empty
 * case in the order the ticket asks for: the shot's own prompt → the beat's
 * singular `imagePrompt` → a sibling of the beat's `imagePrompts[]` → the beat's
 * `visualBrief` → a narration-derived scene line. The return is NEVER blank, so
 * no caller can hand an empty string to an image engine.
 */
export function resolveShotPrompt(input: {
  /** the prompt as resolved so far (builder output, else the shot's authored one) */
  prompt?: string | null;
  /** the beat's singular `imagePrompt` */
  beatImagePrompt?: string | null;
  /** the beat's ordered per-shot `imagePrompts[]` (#69) */
  beatImagePrompts?: (string | null)[] | null;
  /** this shot's ordinal WITHIN its beat (0-based) — which sibling is its own */
  shotOrdinal?: number;
  visualBrief?: string | null;
  narration: string;
  referenceEntity?: string | null;
  /** the channel render register, woven into the last-resort derivation only */
  styleRegister?: string | null;
}): ResolvedShotPrompt {
  const own = clean(input.prompt);
  if (own) return { prompt: own, source: "shot" };
  const beatPrompt = clean(input.beatImagePrompt);
  if (beatPrompt) return { prompt: beatPrompt, source: "beat_prompt" };
  const sibling = nearestSiblingPrompt(input.beatImagePrompts, input.shotOrdinal ?? 0);
  if (sibling) return { prompt: sibling, source: "sibling_prompt" };
  const brief = clean(input.visualBrief);
  if (brief) return { prompt: brief, source: "visual_brief" };
  return {
    prompt: narrationScenePrompt({
      narration: input.narration,
      referenceEntity: input.referenceEntity,
      styleRegister: input.styleRegister,
    }),
    source: "narration",
  };
}

/**
 * Whether a stored image asset is a PLACEHOLDER — the mock-media SVG served when
 * every real engine declined (empty prompt, or a live engine failure absorbed by
 * the routing wrapper's backstop).
 *
 * Three tells, in order of reliability: the `placeholder` flag the provider now
 * stamps, the `engineServed: "mock-media"` marker, and the `.svg` extension —
 * mock-media is the only producer of SVG shot images, so the extension catches
 * shots generated BEFORE the flag existed (the three the operator found by eye).
 */
export function isPlaceholderImage(
  meta: Record<string, unknown> | null | undefined,
  storageKey?: string | null,
): boolean {
  if (meta?.placeholder === true) return true;
  if (typeof meta?.engineServed === "string" && meta.engineServed === "mock-media") return true;
  const mime = typeof meta?.mimeType === "string" ? meta.mimeType : "";
  if (mime === "image/svg+xml") return true;
  return typeof storageKey === "string" && storageKey.toLowerCase().endsWith(".svg");
}

/** The indexes of every shot whose stored image is a placeholder, ascending. */
export function placeholderShotIndexes(
  shots: { idx: number; meta?: Record<string, unknown> | null; storageKey?: string | null }[],
): number[] {
  return shots
    .filter((s) => isPlaceholderImage(s.meta, s.storageKey))
    .map((s) => s.idx)
    .sort((a, b) => a - b);
}
