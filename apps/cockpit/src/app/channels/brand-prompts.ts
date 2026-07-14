/**
 * Default prompt templates for channel brand art (logo + banner). Extracted
 * from the Settings-tab generate actions (2026-07-14 operator ask: "I can't
 * even see what's being prompted for those images") so the Settings tab can
 * SHOW the exact prompt in an editable textarea before generation, and the
 * actions fall back to the same text when the operator doesn't edit it.
 * The wizard keeps its own pre-creation variants (no channel row yet).
 */

export const DEFAULT_BRAND_IMAGE_STYLE = "clean flat vector, bold, high contrast";

export function buildChannelLogoPrompt(name: string, niche: string, imageStyle?: string | null): string {
  const style = imageStyle?.trim() || DEFAULT_BRAND_IMAGE_STYLE;
  return (
    `Channel avatar / logo for a YouTube channel named "${name}" about ${niche}. ` +
    `${style}. A single bold centered emblem or icon — simple, memorable mark with strong ` +
    `figure-ground contrast, legible at small size, flat background, no text.`
  );
}

export function buildChannelBannerPrompt(name: string, niche: string, imageStyle?: string | null): string {
  const style = imageStyle?.trim() || DEFAULT_BRAND_IMAGE_STYLE;
  return (
    `Wide channel banner art for a YouTube channel named "${name}" about ${niche}. ` +
    `${style}. Cinematic 16:9 composition with the key subject centered in the middle third ` +
    `(YouTube crops the edges on TV/desktop), rich atmospheric background, room for the channel ` +
    `name to sit over it later, no text.`
  );
}
