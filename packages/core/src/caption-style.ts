/**
 * Caption styling (#72, extended #79). This module is the single source of truth
 * for the operator-configurable caption look + the two pure helpers the renderer
 * needs — casing and emphasis-phrase matching — so the behaviour is unit-testable
 * without running a Remotion render.
 *
 * #79 (caption legibility): captions are burned in over unpredictable imagery, so
 * the DEFAULT is now white text with a heavy dark outline + drop shadow — the
 * robust choice when the renderer has no idea what image sits behind the text.
 * The base text colour, outline colour/width, shadow and an optional dark scrim
 * band are all configurable. (Before #79 the base was white with only a soft
 * shadow and no outline, which vanished over bright frames.)
 */

export const CAPTION_POSITIONS = ["lower-third", "center", "upper-third"] as const;
export type CaptionPosition = (typeof CAPTION_POSITIONS)[number];
export const CAPTION_CASINGS = ["as-written", "upper", "sentence"] as const;
export type CaptionCasing = (typeof CAPTION_CASINGS)[number];
export const CAPTION_TYPEFACES = ["sans", "serif", "slab"] as const;
export type CaptionTypeface = (typeof CAPTION_TYPEFACES)[number];

export const CAPTION_WEIGHT_MIN = 400;
export const CAPTION_WEIGHT_MAX = 900;

// #79 legibility defaults + bounds.
export const CAPTION_OUTLINE_WIDTH_MAX = 12;
export const CAPTION_DEFAULT_COLOR = "#FFFFFF";
export const CAPTION_DEFAULT_OUTLINE_COLOR = "#000000";
/** Heavy enough to survive bright imagery at 56–72px, thin enough to stay legible. */
export const CAPTION_DEFAULT_OUTLINE_WIDTH = 4;

export type CaptionStyle = {
  /** where the caption sits on the frame (default lower-third — prior behaviour) */
  position?: CaptionPosition;
  /** transform each caption word (default as-written) */
  casing?: CaptionCasing;
  /** typeface family class; sans = the brand font (default, prior behaviour) */
  typeface?: CaptionTypeface;
  /** 400-900 (default 800) */
  weight?: number;
  /** #79: force a stroke on/off. Unset → on (the heavy-outline default); set
   * false to drop the stroke entirely. An explicit `outlineWidth` always wins. */
  outline?: boolean;
  /** hard cap on caption lines (advisory to the renderer; default 2) */
  maxLines?: number;
  /** colour for emphasised phrases; default = the brand accent (prior active-word
   * colour). NOTE: only colours words that match `emphasisPhrases` — with no
   * phrases set it has no visible effect. */
  emphasisColor?: string;
  /** phrases coloured with emphasisColor wherever they appear in the captions
   * (e.g. "are not liberated") — case- and punctuation-insensitive */
  emphasisPhrases?: string[];
  /** #79: base text colour for non-active/non-emphasised words (default white). */
  color?: string;
  /** #79 (follow-up): colour of the currently-spoken ("active") word. Unset → the
   * active word uses the base `color` (so a white caption stays white; the karaoke
   * highlight is the scale-up alone). Set it (e.g. to the brand accent) to opt into
   * a coloured karaoke highlight. Replaces the old hardcoded brand-accent on every
   * active word, which overrode `color` and rendered captions in the accent colour. */
  activeColor?: string;
  /** #79: outline/stroke colour (default near-black). */
  outlineColor?: string;
  /** #79: outline/stroke width in px, 0–12 (default 4 = heavy). 0 disables the
   * stroke. Overrides the `outline` boolean when set. */
  outlineWidth?: number;
  /** #79: drop a dark shadow behind the text (default true). */
  shadow?: boolean;
  /** #79: render a semi-transparent dark band (scrim) behind the caption block —
   * the most robust contrast guarantee over varied imagery (default false). */
  scrim?: boolean;
};

export type ResolvedCaptionStyle = {
  position: CaptionPosition;
  casing: CaptionCasing;
  typeface: CaptionTypeface;
  weight: number;
  maxLines: number;
  /** null = use the brand accent colour (prior behaviour) */
  emphasisColor: string | null;
  emphasisPhrases: string[];
  /** #79: fully-resolved legibility fields (always concrete). */
  color: string;
  /** null = the active word uses the base `color` (no forced accent). */
  activeColor: string | null;
  outlineColor: string;
  /** px; 0 = no stroke. */
  outlineWidth: number;
  shadow: boolean;
  scrim: boolean;
};

const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

const colorOr = (v: unknown, fallback: string): string =>
  typeof v === "string" && v.trim() ? v.trim() : fallback;

/** Resolve a stored caption style over the (legible) defaults. */
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
  // Outline width: an explicit width wins; else the `outline` boolean toggles the
  // heavy default (unset/true → default width, false → no stroke).
  const outlineWidth =
    typeof st.outlineWidth === "number" && Number.isFinite(st.outlineWidth)
      ? Math.max(0, Math.min(CAPTION_OUTLINE_WIDTH_MAX, st.outlineWidth))
      : st.outline === false
        ? 0
        : CAPTION_DEFAULT_OUTLINE_WIDTH;
  return {
    position: pick(st.position, CAPTION_POSITIONS, "lower-third"),
    casing: pick(st.casing, CAPTION_CASINGS, "as-written"),
    typeface: pick(st.typeface, CAPTION_TYPEFACES, "sans"),
    weight,
    maxLines,
    emphasisColor,
    emphasisPhrases,
    color: colorOr(st.color, CAPTION_DEFAULT_COLOR),
    activeColor: typeof st.activeColor === "string" && st.activeColor.trim() ? st.activeColor.trim() : null,
    outlineColor: colorOr(st.outlineColor, CAPTION_DEFAULT_OUTLINE_COLOR),
    outlineWidth,
    shadow: typeof st.shadow === "boolean" ? st.shadow : true,
    scrim: typeof st.scrim === "boolean" ? st.scrim : false,
  };
}

/** True when the resolved style is the plain default look (no operator overrides). */
export function isDefaultCaptionStyle(r: ResolvedCaptionStyle): boolean {
  return (
    r.position === "lower-third" &&
    r.casing === "as-written" &&
    r.typeface === "sans" &&
    r.weight === 800 &&
    r.maxLines === 2 &&
    r.emphasisColor === null &&
    r.emphasisPhrases.length === 0 &&
    r.color === CAPTION_DEFAULT_COLOR &&
    r.outlineColor === CAPTION_DEFAULT_OUTLINE_COLOR &&
    r.outlineWidth === CAPTION_DEFAULT_OUTLINE_WIDTH &&
    r.shadow &&
    !r.scrim
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
