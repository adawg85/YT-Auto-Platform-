/**
 * Default prompt templates for channel brand art (logo + banner). Extracted
 * from the Settings-tab generate actions (2026-07-14 operator ask: "I can't
 * even see what's being prompted for those images") so the Settings tab can
 * SHOW the exact prompt in an editable textarea before generation, and the
 * actions fall back to the same text when the operator doesn't edit it.
 * The wizard keeps its own pre-creation variants (no channel row yet).
 */

export const DEFAULT_BRAND_IMAGE_STYLE = "clean flat vector, bold, high contrast";

/**
 * When the channel has an ACTIVE distilled style guide (2026-07-15 operator
 * ask), its style block REPLACES the wizard-era imageStyle free text — that
 * initial text is exactly what goes stale once a guide is bedded down — and
 * rides the prompt as its own paragraph. Channels without an active guide
 * keep the imageStyle → default fallback unchanged.
 */
export function buildChannelLogoPrompt(
  name: string,
  niche: string,
  imageStyle?: string | null,
  styleBlock?: string | null,
): string {
  const style = styleBlock ? "" : `${imageStyle?.trim() || DEFAULT_BRAND_IMAGE_STYLE}. `;
  return (
    `Channel avatar / logo for a YouTube channel named "${name}" about ${niche}. ` +
    `${style}A single bold centered emblem or icon — simple, memorable mark with strong ` +
    `figure-ground contrast, legible at small size, flat background, no text.` +
    (styleBlock ? `\n\n${styleBlock}` : "")
  );
}

export function buildChannelBannerPrompt(
  name: string,
  niche: string,
  imageStyle?: string | null,
  styleBlock?: string | null,
): string {
  const style = styleBlock ? "" : `${imageStyle?.trim() || DEFAULT_BRAND_IMAGE_STYLE}. `;
  return (
    `Wide channel banner art for a YouTube channel named "${name}" about ${niche}. ` +
    `${style}Cinematic 16:9 composition with the key subject centered in the middle third ` +
    `(YouTube crops the edges on TV/desktop), rich atmospheric background, room for the channel ` +
    `name to sit over it later, no text.` +
    (styleBlock ? `\n\n${styleBlock}` : "")
  );
}
