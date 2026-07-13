/**
 * Thumbnail prompt builder (spec §5.5, upgraded for #35.3): encodes proven
 * thumbnail practice into the candidate prompts the pipeline generates per
 * video — one subject close-up concept, one scene/contrast concept, and (when
 * the intel scan has deconstructed winning thumbnails for this niche) one
 * PATTERN-LED concept modeled on what is demonstrably pulling clicks right
 * now. Pure and deterministic so it's unit-testable and works identically in
 * mock mode.
 *
 * Encoded practice (the #35.3 ruleset): a single dominant focal subject
 * filling ~60% of the frame, rule-of-thirds placement, high contrast with a
 * saturated accent against a muted background, visible emotion/tension,
 * depth via foreground/background separation, legibility at feed size
 * (~120px — thumbnails are judged as postage stamps, not posters), and ≤3
 * words of overlay text ONLY when the channel's thumbnail spec demands text.
 * Everything is phrased positively — FLUX-class image models ignore
 * negations, so "avoid clutter" is expressed as "clean simple composition
 * built from a few bold shapes".
 */

/** Structural shape of the per-channel thumbnail spec (mirrors @ytauto/db's ThumbnailSpec). */
export type ThumbnailSpecLike = {
  focalObject: string;
  textStyle: string;
  maxWords: number;
  colorContrast: string;
  negativeSpace: string;
};

/** A deconstructed winning-thumbnail pattern (kind "thumbnail" in the store). */
export type ThumbnailPatternLike = {
  label: string;
  detail?: {
    composition?: string;
    subjectTreatment?: string;
    textTreatment?: string;
    palette?: string;
    emotion?: string;
  } | null;
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
  /** #35.3: top deconstructed winning patterns for this niche (freshness-ranked) */
  patterns?: ThumbnailPatternLike[];
}): string[] {
  const { title, angle, style, spec, isLong } = input;
  const label = isLong
    ? "YouTube thumbnail, 16:9 landscape"
    : "YouTube Shorts thumbnail, 9:16 vertical";
  const contrast =
    spec?.colorContrast ||
    "high contrast, one saturated accent color against a muted desaturated background";
  // Overlay text IS the best practice (bold, ≤3 words) — default ON. A channel
  // spec can restyle it or opt out (textStyle "none"); we never write "no
  // text" into a prompt (negations backfire on FLUX-class models).
  const wantsText = spec
    ? !!spec.textStyle && (spec.maxWords ?? 0) > 0 && !/\b(none|no text)\b/i.test(spec.textStyle)
    : true;
  const textClause = wantsText
    ? ` Bold ${spec?.textStyle || "condensed sans-serif"} overlay text reading "${overlayWords(title, spec?.maxWords ?? 3)}", huge and legible at feed size.`
    : "";
  // Feed-size legibility is THE constraint every concept shares (#35.3):
  // thumbnails are judged at ~120px next to ten competitors.
  const legibility =
    "composition that still reads instantly when shrunk to postage-stamp size, large simple forms, nothing important near the edges";

  // Concept 1: subject close-up — one dominant focal subject, emotion, depth.
  const closeUp =
    `${label}, ${style}. Extreme close-up of ${spec?.focalObject || `the single most striking subject of "${title}"`}, ` +
    `one dominant focal subject filling about 60% of the frame, placed on a rule-of-thirds intersection, ` +
    `intense emotion and tension in the subject, razor-sharp foreground subject with a softly blurred background for depth, ` +
    `${contrast}, ${legibility}.${textClause}`;

  // Concept 2: scene/contrast — the angle as a dramatic moment with negative space.
  const scene =
    `${label}, ${style}. Dramatic scene: ${angle} — one clear focal point on a rule-of-thirds line, ` +
    `strong visual contrast between the subject and its surroundings, ` +
    `${spec?.negativeSpace || "generous negative space around the subject"}, ` +
    `moody directional lighting, distinct foreground and background layers for depth, ${contrast}, ` +
    `${legibility}.${textClause}`;

  const prompts = [closeUp, scene];

  // Concept 3 (#35.3): pattern-led — modeled on the strongest deconstructed
  // winner for this niche. Only the pattern's SHAPE (composition, palette,
  // emotion) transfers; the subject is always THIS video's.
  const top = input.patterns?.[0];
  if (top) {
    const d = top.detail ?? {};
    const parts = [
      d.composition,
      d.subjectTreatment ? `the subject of "${title}" treated as: ${d.subjectTreatment}` : `the single most striking subject of "${title}"`,
      d.palette,
      d.emotion,
    ].filter(Boolean);
    prompts.push(
      `${label}, ${style}. Composition modeled on a proven winner ("${top.label}"): ${parts.join("; ")}. ` +
        `${contrast}, ${legibility}.${textClause}`,
    );
  }

  return prompts;
}
