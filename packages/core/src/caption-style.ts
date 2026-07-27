/**
 * Caption styling (#72). The renderer's caption look was hardcoded (lower-third,
 * sans, weight 800, brand-accent active word). This module is the single source
 * of truth for the operator-configurable caption style + the two pure helpers
 * the renderer needs — casing and emphasis-phrase matching — so the behaviour is
 * unit-testable without running a Remotion render. Every default reproduces the
 * prior hardcoded look, so an unset channel renders byte-identically.
 */

export const CAPTION_POSITIONS = ["lower-third", "center", "upper-third"] as const;
export type CaptionPosition = (typeof CAPTION_POSITIONS)[number];
export const CAPTION_CASINGS = ["as-written", "upper", "sentence"] as const;
export type CaptionCasing = (typeof CAPTION_CASINGS)[number];
export const CAPTION_TYPEFACES = ["sans", "serif", "slab"] as const;
export type CaptionTypeface = (typeof CAPTION_TYPEFACES)[number];

export const CAPTION_WEIGHT_MIN = 400;
export const CAPTION_WEIGHT_MAX = 900;

export type CaptionStyle = {
  /** where the caption sits on the frame (default lower-third — prior behaviour) */
  position?: CaptionPosition;
  /** transform each caption word (default as-written) */
  casing?: CaptionCasing;
  /** typeface family class; sans = the brand font (default, prior behaviour) */
  typeface?: CaptionTypeface;
  /** 400-900 (default 800) */
  weight?: number;
  /** add a dark text stroke in addition to the drop shadow (default false) */
  outline?: boolean;
  /** hard cap on caption lines (advisory to the renderer; default 2) */
  maxLines?: number;
  /** colour for emphasised phrases; default = the brand accent (prior active-word colour) */
  emphasisColor?: string;
  /** phrases coloured with emphasisColor wherever they appear in the captions
   * (e.g. "are not liberated") — case- and punctuation-insensitive */
  emphasisPhrases?: string[];
};

export type ResolvedCaptionStyle = {
  position: CaptionPosition;
  casing: CaptionCasing;
  typeface: CaptionTypeface;
  weight: number;
  outline: boolean;
  maxLines: number;
  /** null = use the brand accent colour (prior behaviour) */
  emphasisColor: string | null;
  emphasisPhrases: string[];
};

const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

/** Resolve a stored caption style over prior-behaviour defaults. */
export function resolveCaptionStyle(s?: CaptionStyle | null): ResolvedCaptionStyle {
  const st = s ?? {};
  const weight =
    typeof st.weight === "number" && Number.isFinite(st.weight)
      ? Math.max(CAPTION_WEIGHT_MIN, Math.min(CAPTION_WEIGHT_MAX, Math.round(st.weight)))
      : 800;
  const maxLines =
    typeof st.maxLines === "number" && Number.isFinite(st.maxLines) && st.maxLines > 0
      ? Math.max(1, Math.min(4, Math.round(st.maxLines)))
      : 2;
  const emphasisColor = typeof st.emphasisColor === "string" && st.emphasisColor.trim() ? st.emphasisColor.trim() : null;
  const emphasisPhrases = Array.isArray(st.emphasisPhrases)
    ? st.emphasisPhrases.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map((p) => p.trim())
    : [];
  return {
    position: pick(st.position, CAPTION_POSITIONS, "lower-third"),
    casing: pick(st.casing, CAPTION_CASINGS, "as-written"),
    typeface: pick(st.typeface, CAPTION_TYPEFACES, "sans"),
    weight,
    outline: typeof st.outline === "boolean" ? st.outline : false,
    maxLines,
    emphasisColor,
    emphasisPhrases,
  };
}

/** True when the resolved style is the prior hardcoded look (so the renderer can
 * take the exact old path and stay byte-identical for unmigrated channels). */
export function isDefaultCaptionStyle(r: ResolvedCaptionStyle): boolean {
  return (
    r.position === "lower-third" &&
    r.casing === "as-written" &&
    r.typeface === "sans" &&
    r.weight === 800 &&
    !r.outline &&
    r.emphasisColor === null &&
    r.emphasisPhrases.length === 0
  );
}

const capitalize = (w: string) => (w ? w[0]!.toUpperCase() + w.slice(1) : w);

/** Apply the casing transform to one caption word. `firstInPage` gets the
 * sentence-case leading capital. */
export function applyCasing(word: string, casing: CaptionCasing, firstInPage: boolean): string {
  switch (casing) {
    case "upper":
      return word.toUpperCase();
    case "sentence":
      return firstInPage ? capitalize(word.toLowerCase()) : word.toLowerCase();
    case "as-written":
    default:
      return word;
  }
}

/** Strip punctuation + lowercase, for tolerant phrase matching. */
const normWord = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/**
 * The set of caption-word indices (into the FLAT word stream) that fall inside
 * any emphasis phrase — so the renderer colours "are not liberated" as a unit,
 * wherever it appears. Matching is case- and punctuation-insensitive on word
 * boundaries (a phrase must match a consecutive run of whole caption words).
 * Pure + unit-tested so emphasis is verifiable without a render.
 */
export function emphasizedWordIndices(words: { word: string }[], phrases: string[]): Set<number> {
  const out = new Set<number>();
  if (!phrases.length || !words.length) return out;
  const norm = words.map((w) => normWord(w.word));
  for (const phrase of phrases) {
    const target = phrase.split(/\s+/).map(normWord).filter(Boolean);
    if (!target.length) continue;
    for (let i = 0; i + target.length <= norm.length; i++) {
      let hit = true;
      for (let j = 0; j < target.length; j++) {
        if (norm[i + j] !== target[j]) {
          hit = false;
          break;
        }
      }
      if (hit) for (let j = 0; j < target.length; j++) out.add(i + j);
    }
  }
  return out;
}
