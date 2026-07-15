/**
 * Thumbnail prompt composer (2026-07-15 operator ask: format presets, title
 * text, style + character references, and a live "final prompt" preview). One
 * PURE function builds the prompt from a structured spec — the studio dialog
 * composes it live for the operator, and the server action composes it again
 * from the same inputs, so what you preview is what runs. Client-safe (no
 * @ytauto/core import — its barrel pulls node:crypto).
 */

export const THUMB_FORMATS = [
  { value: "subject_text", label: "Bold subject + short text" },
  { value: "big_face", label: "Big face + reaction" },
  { value: "before_after", label: "Before / after split" },
  { value: "number_list", label: "Number / list hook" },
] as const;

export type ThumbFormat = (typeof THUMB_FORMATS)[number]["value"];

export type ThumbSpec = {
  title: string;
  angle: string;
  isLong: boolean;
  format: string;
  /** overlay the title text on the thumbnail */
  includeTitle: boolean;
  /** exact overlay words; empty → auto-shortened from the title */
  titleText?: string | null;
  /** featured in the thumbnail (identity anchor) */
  character?: { name: string; description: string } | null;
  /** a style test scene image is attached (palette/mood only) */
  sceneRef?: boolean;
  /** the ACTIVE distilled style block (replaces imageStyle when set) */
  styleBlock?: string | null;
  /** wizard-era free text fallback look */
  imageStyle?: string | null;
  /** operator's short extra direction */
  extra?: string | null;
};

/** ≤`max` punchy words from the title, uppercased — the feed-legible default. */
export function autoTitleWords(title: string, max = 3): string {
  return title
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, Math.max(1, max))
    .join(" ")
    .toUpperCase();
}

const clip = (d: string) => {
  const t = d.trim();
  return t.length > 160 ? `${t.slice(0, 160).trimEnd()}…` : t;
};
const sentence = (t: string) => (/[.!?…]$/.test(t) ? t : `${t}.`);

export function composeThumbnailPrompt(spec: ThumbSpec): string {
  const label = spec.isLong ? "YouTube thumbnail, 16:9 landscape" : "YouTube Shorts thumbnail, 9:16 vertical";
  const subject = spec.character ? spec.character.name : `the single most striking subject of "${spec.title}"`;
  const legibility =
    "Composition that still reads instantly at postage-stamp feed size — large simple forms, one clear focal point, strong figure-ground separation, nothing important near the edges.";

  const parts: string[] = [];
  // character identity anchor first, verbatim (matches the beat/test-scene path)
  if (spec.character) parts.push(clip(spec.character.description));
  parts.push(`${label}.`);

  switch (spec.format) {
    case "big_face":
      parts.push(
        `Extreme close-up of ${subject}${spec.character ? "" : " (an expressive person)"} filling ~50% of the frame, ` +
          `a strong exaggerated emotional reaction, razor-sharp face with a softly blurred background for depth.`,
      );
      break;
    case "before_after":
      parts.push(
        `Two-panel split composition of ${subject}: a clear BEFORE on the left and AFTER on the right, ` +
          `divided by a bold vertical line or arrow, strong visual contrast between the two sides.`,
      );
      break;
    case "number_list":
      parts.push(
        `A huge bold number or "#1"-style focal element beside ${subject}, ranking/countdown energy, ` +
          `the number dominating one third of the frame.`,
      );
      break;
    case "subject_text":
    default:
      parts.push(
        `One dominant focal subject — ${subject} — filling ~60% of the frame on a rule-of-thirds intersection, ` +
          `intense emotion and tension, razor-sharp foreground with a softly blurred background for depth.`,
      );
  }

  const words = spec.includeTitle ? (spec.titleText?.trim() || autoTitleWords(spec.title)) : "";
  if (words) {
    parts.push(`Bold condensed sans-serif overlay text reading "${words}", huge and legible at feed size. No other text or lettering.`);
  } else {
    parts.push("No text, letters or words anywhere in the image.");
  }

  if (spec.sceneRef && !spec.character) {
    parts.push("The attached reference image is for palette, mood and style only — do not copy its composition or subject.");
  }
  if (spec.extra?.trim()) parts.push(sentence(spec.extra.trim()));
  parts.push(legibility);

  if (spec.styleBlock) return `${parts.join(" ")}\n\n${spec.styleBlock}`;
  parts.push(`Style: ${spec.imageStyle?.trim() || "clean, bold, high-contrast, saturated accent on a muted background"}.`);
  return parts.join(" ");
}

/** Refine prompt — edit the current thumbnail with only the described changes. */
export function composeThumbnailRefinePrompt(changes: string, character?: { name: string; description: string } | null): string {
  const parts = [
    "Edit the attached thumbnail image — apply ONLY the changes described here; keep the composition, " +
      "style and every element not mentioned exactly the same.",
    sentence(changes.trim()),
  ];
  if (character) {
    parts.push(
      `Integrate the channel's character ${character.name} — the SECOND attached image defines only their look: ${clip(character.description)}`,
    );
  }
  return parts.join(" ");
}
