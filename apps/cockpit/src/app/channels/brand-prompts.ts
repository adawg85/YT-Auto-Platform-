/**
 * Brand-art (logo + banner) prompt composer. ONE pure function builds the
 * final prompt from a structured spec — the dialog composes it live for the
 * operator to see, and the server action composes it again from the same
 * inputs, so what you preview is exactly what runs (2026-07-15 operator ask:
 * ticks for the standard choices, a SMALL free-text field, and references
 * used IN the art — the old flow re-prefixed a cast character's full
 * description server-side and the logo became the character).
 *
 * Pure strings only: this module is imported by BOTH client components and
 * "use server" actions.
 */

export const DEFAULT_BRAND_IMAGE_STYLE = "clean flat vector, bold, high contrast";

export type BrandArtSpec = {
  surface: "logo" | "banner";
  name: string;
  niche: string;
  /** "refine" edits the CURRENT art (attached as the first image) with small
   * changes; "generate" (default) composes a from-scratch brief */
  mode?: "generate" | "refine";
  /** refine only: what to change — the primary instruction */
  changes?: string | null;
  /** render the channel name as typography in the art (refine: ADD it) */
  includeName: boolean;
  /** included as smaller supporting typography when non-empty */
  tagline?: string | null;
  /** flat solid background vs rich styled scene; "keep" (refine) = no clause */
  background: "clear" | "styled" | "keep";
  /** tie the art to the active style guide (when one exists) */
  alignStyle: boolean;
  /** wizard-era free text — the fallback look when no guide applies */
  imageStyle?: string | null;
  /** the ACTIVE style guide's block (styleBlockForImagePrompts) */
  styleBlock?: string | null;
  /** featured IN the composition as one element — never the whole image */
  character?: { name: string; description: string } | null;
  /** a style test scene image is attached (palette/mood only) */
  sceneRef?: boolean;
  /** the current logo/banner is attached (rework in place, generate mode) */
  currentRef?: boolean;
  /** operator's short free-text direction, appended last (generate mode) */
  extra?: string | null;
};

const clipDesc = (desc: string) => {
  const d = desc.trim();
  return d.length > 160 ? `${d.slice(0, 160).trimEnd()}…` : d;
};

/** operator free text joins other clauses — make sure it ends a sentence */
const sentence = (t: string) => (/[.!?…]$/.test(t) ? t : `${t}.`);

/** Refine: edit the attached current art with ONLY the described changes —
 * ticks are additive, unmentioned elements must survive verbatim. */
function composeRefinePrompt(spec: BrandArtSpec): string {
  const parts: string[] = [];
  parts.push(
    `Edit the attached image — the current channel ${spec.surface} for "${spec.name}". ` +
      `Apply ONLY the changes described here; keep the composition, style and every element ` +
      `not mentioned exactly the same.`,
  );
  const changes = spec.changes?.trim();
  if (changes) parts.push(sentence(changes));
  const tagline = spec.tagline?.trim();
  if (spec.includeName) {
    parts.push(`Add the channel name "${spec.name}" as bold, legible typography.`);
  }
  if (tagline) {
    parts.push(`Add the tagline "${tagline}" as smaller, clean supporting typography.`);
  }
  if (spec.background === "clear") parts.push("Change the background to a clean flat solid color.");
  else if (spec.background === "styled") parts.push("Change the background to a rich, styled scene with atmosphere and depth.");
  if (spec.character) {
    parts.push(
      `Integrate the channel's character ${spec.character.name} as ONE additional element inside ` +
        `the composition — never the whole image; the SECOND attached image defines only their ` +
        `look: ${clipDesc(spec.character.description)}`,
    );
  } else if (spec.sceneRef) {
    parts.push("Apply the palette and mood of the second attached image — do not copy its composition or subject.");
  }
  if (spec.alignStyle && spec.styleBlock) {
    return `${parts.join(" ")}\n\n${spec.styleBlock}`;
  }
  return parts.join(" ");
}

export function composeBrandArtPrompt(spec: BrandArtSpec): string {
  if (spec.mode === "refine") return composeRefinePrompt(spec);
  const parts: string[] = [];

  parts.push(
    spec.surface === "logo"
      ? `Channel avatar / logo for a YouTube channel named "${spec.name}" about ${spec.niche}. ` +
          `A single bold centered design — simple, memorable, strong figure-ground contrast, legible at small size.`
      : `Wide channel banner art for a YouTube channel named "${spec.name}" about ${spec.niche}. ` +
          `Cinematic 16:9 composition with the key subject centered in the middle third ` +
          `(YouTube crops the edges on TV/desktop).`,
  );

  // typography: explicit about WHAT text is allowed, so "no text" stays the
  // default and ticked text never comes out as garbled extra lettering
  const tagline = spec.tagline?.trim();
  if (spec.includeName && tagline) {
    parts.push(
      `Include the channel name "${spec.name}" as bold, legible typography and the tagline ` +
        `"${tagline}" as smaller supporting text. No other text or lettering anywhere.`,
    );
  } else if (spec.includeName) {
    parts.push(`Include the channel name "${spec.name}" as bold, legible typography. No other text or lettering.`);
  } else if (tagline) {
    parts.push(`Include the tagline "${tagline}" as clean, legible typography. No other text or lettering.`);
  } else {
    parts.push("No text, letters or words anywhere in the image.");
  }

  if (spec.background === "clear") parts.push("Clean flat solid-color background.");
  else if (spec.background === "styled") parts.push("Rich, styled background scene with atmosphere and depth.");

  if (spec.character) {
    parts.push(
      `Feature the channel's character ${spec.character.name} as ONE element inside the composition — ` +
        `integrated into the design, NEVER the entire image: ${clipDesc(spec.character.description)} ` +
        `The attached reference image defines only the character's look.`,
    );
  } else if (spec.sceneRef) {
    parts.push(
      "The attached reference image is for palette, mood and style only — do not copy its composition or subject.",
    );
  } else if (spec.currentRef) {
    parts.push("Rework the attached current art — keep its composition, apply the changes described here.");
  }

  const extra = spec.extra?.trim();
  if (extra) parts.push(sentence(extra));

  // active style guide replaces the wizard-era free text (2026-07-15)
  if (spec.alignStyle && spec.styleBlock) {
    return `${parts.join(" ")}\n\n${spec.styleBlock}`;
  }
  parts.push(`Style: ${spec.imageStyle?.trim() || DEFAULT_BRAND_IMAGE_STYLE}.`);
  return parts.join(" ");
}
