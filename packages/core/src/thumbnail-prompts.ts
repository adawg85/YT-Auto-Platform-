/**
 * Thumbnail prompt builder (spec §5.5 upgrade): encodes proven thumbnail
 * practice into the two candidate prompts the pipeline generates per video —
 * one subject close-up concept, one scene/contrast concept. Pure and
 * deterministic so it's unit-testable and works identically in mock mode.
 *
 * Encoded practice: a single dominant focal subject filling ~60% of the frame,
 * rule-of-thirds placement, high contrast with a saturated accent against a
 * muted background, visible emotion/tension in the subject, depth via
 * foreground/background separation, and ≤3 words of overlay text ONLY when the
 * channel's thumbnail spec demands text. Everything is phrased positively —
 * FLUX-class image models ignore negations, so "avoid clutter" is expressed as
 * "clean simple composition built from a few bold shapes".
 */

/** Structural shape of the per-channel thumbnail spec (mirrors @ytauto/db's ThumbnailSpec). */
export type ThumbnailSpecLike = {
  focalObject: string;
  textStyle: string;
  maxWords: number;
  colorContrast: string;
  negativeSpace: string;
};

/** Pull ≤3 punchy overlay words from the title (significant words, uppercased). */
function overlayWords(title: string, maxWords: number): string {
  return title
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, Math.max(1, Math.min(3, maxWords)))
    .join(" ")
    .toUpperCase();
}

export function buildThumbnailPrompts(input: {
  title: string;
  angle: string;
  /** the channel DNA image style */
  style: string;
  spec?: ThumbnailSpecLike | null;
  isLong: boolean;
}): [string, string] {
  const { title, angle, style, spec, isLong } = input;
  const label = isLong
    ? "YouTube thumbnail, 16:9 landscape"
    : "YouTube Shorts thumbnail, 9:16 vertical";
  const contrast =
    spec?.colorContrast ||
    "high contrast, one saturated accent color against a muted desaturated background";
  // Overlay text only when the channel's spec demands it — otherwise the
  // prompt simply never mentions text (mentioning "no text" backfires).
  const wantsText =
    !!spec?.textStyle && (spec.maxWords ?? 0) > 0 && !/\b(none|no text)\b/i.test(spec.textStyle);
  const textClause = wantsText
    ? ` Bold ${spec!.textStyle} overlay text reading "${overlayWords(title, spec!.maxWords)}", huge and legible at feed size.`
    : "";

  // Concept 1: subject close-up — one dominant focal subject, emotion, depth.
  const closeUp =
    `${label}, ${style}. Extreme close-up of ${spec?.focalObject || `the single most striking subject of "${title}"`}, ` +
    `one dominant focal subject filling about 60% of the frame, placed on a rule-of-thirds intersection, ` +
    `intense emotion and tension in the subject, razor-sharp foreground subject with a softly blurred background for depth, ` +
    `${contrast}, clean simple composition built from a few bold shapes that read instantly at a glance.${textClause}`;

  // Concept 2: scene/contrast — the angle as a dramatic moment with negative space.
  const scene =
    `${label}, ${style}. Dramatic scene: ${angle} — one clear focal point on a rule-of-thirds line, ` +
    `strong visual contrast between the subject and its surroundings, ` +
    `${spec?.negativeSpace || "generous negative space around the subject"}, ` +
    `moody directional lighting, distinct foreground and background layers for depth, ${contrast}, ` +
    `bold graphic composition with large simple forms.${textClause}`;

  return [closeUp, scene];
}
