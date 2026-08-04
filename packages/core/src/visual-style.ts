import { z } from "zod";

/**
 * Visual style DNA (#35.1): a channel's look, distilled by a vision agent
 * from ACTUAL example images and versioned like personas. The doc flows into
 * every image + thumbnail prompt; the example images themselves drive
 * image-to-image conditioning (scope/strength dialed per doc version).
 */

/** What the style_distiller vision agent produces (describe-hints, no hard
 * bounds — real models overshoot zod .min/.max; promptSuffix capped because
 * it is appended verbatim to every generation prompt). */
export const visualStyleDistillSchema = z.object({
  palette: z
    .string()
    .describe("dominant colors + the accent trick, as a prompt-ready clause"),
  lighting: z.string().describe("the lighting language shared across the examples"),
  composition: z
    .string()
    .describe("layout habits: subject size/placement, negative space, depth, focal flow"),
  subjectTreatment: z
    .string()
    .describe("how subjects are treated: crop, angle, scale, finish"),
  texture: z.string().describe("grain, film stock, render finish"),
  typography: z
    .string()
    .describe("overlay text treatment seen in the examples, or 'none'"),
  energy: z.string().describe("mood/intensity in a few words"),
  promptSuffix: z
    .string()
    .max(400)
    .describe(
      "ONE reusable 'Style: … Mood: …' sentence distilled from all of the above — appended verbatim to every generation prompt; positive-only phrasing",
    ),
  rationale: z.string().describe("one line: what makes this example set cohere"),
});
export type VisualStyleDistill = z.infer<typeof visualStyleDistillSchema>;

/**
 * The channel's HOUSE IMAGE STYLE, or null when the operator hasn't set one
 * (2026-07-25 operator: "the style section should start blank until I give it —
 * nothing should be influencing it, everything should be influenced BY it").
 *
 * Blank means BLANK. There is deliberately NO fabricated default: every caller
 * OMITS its style clause when this returns null, so an unset channel imposes no
 * look at all rather than a silent "clean flat illustration" that the operator
 * never chose and could not see. Set it in the Style tab or over MCP
 * (`set_channel_config` → `dna.imageStyle`).
 */
export function resolveImageStyle(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  return s.length > 0 ? s : null;
}

/**
 * How much of the style string has to already appear in a prompt for us to treat
 * the register as applied. Long enough that a real house style ("Bold graphic
 * illustration — a painted graphic-novel…") can't collide by accident, short
 * enough that a prompt carrying the style with different trailing wording still
 * counts as styled.
 */
const STYLE_FINGERPRINT_CHARS = 24;

/**
 * Append the channel's render register to a prompt that the image-prompt BUILDER
 * never saw — the single rule behind #93.
 *
 * An authored `imagePrompt` (MCP `author_script`, `edit_shot_prompts`, an
 * operator-typed prompt in the storyboard) skips `buildImagePrompts`, and that
 * builder was the ONLY place `dna.imageStyle` was ever woven in. So authored
 * prompts reached the image model styleless and a channel whose style says
 * "Clearly illustrated and stylised, NOT photographic" rendered photoreal on
 * every shot (ticket 01KZ070KJW60WRJSVCJ778F6D4).
 *
 * "Verbatim" means the SUBJECT/composition is untouched — this only appends the
 * register, and only when it isn't already there, so re-rendering a prompt that
 * was stored WITH its suffix (the pipeline persists `meta.prompt` suffixed)
 * can't stack the clause a second time.
 *
 * Pass the distilled Style-tab `promptSuffix` when one is active — it is built
 * to be appended verbatim to every generation prompt and supersedes the house
 * string, matching the builder's own precedence.
 */
export function applyHouseImageStyle(prompt: string, style: string | null | undefined): string {
  const p = (prompt ?? "").trim();
  const s = resolveImageStyle(style);
  if (!p || !s) return p;
  const fingerprint = s.slice(0, STYLE_FINGERPRINT_CHARS).toLowerCase();
  if (p.toLowerCase().includes(fingerprint)) return p;
  // #95: the register may ALREADY be a "Style: …" clause — a distilled style's
  // promptSuffix is authored that way by the distiller ("ONE reusable
  // 'Style: … Mood: …' sentence"). Prefixing again produced "Style: Style: …"
  // on every authored shot of every channel with a distilled style. The
  // idempotence guard above only catches the whole register repeating, not the
  // register arriving pre-labelled.
  return /^style\s*:/i.test(s) ? `${p} ${s}` : `${p} Style: ${s}`;
}

/** Which register actually steered a generated shot — reported per shot so an
 * operator can see it without paying for a render (#93, 2026-08-03). */
export type StyleSource = "distilled_style" | "channel_image_style" | "none";

/**
 * Pick the render register for a prompt the image-prompt BUILDER never saw.
 *
 * The 2026-08-02/03 passes gated the house style on "no distilled Style-tab
 * style is active", on the stated grounds that an active distilled style rides
 * authored prompts as reference-image conditioning instead. **That was wrong**,
 * and it is why #93 reproduced on a live render (`01KZ3T4RJARG54GSSKEEF33Q6R`):
 *
 *  - the distilled style's TEXT (`styleBlock`) is woven in by `buildImagePrompts`
 *    — which authored prompts skip by definition, so it never arrives;
 *  - the distilled style's reference-image conditioning only fires on
 *    **nano-banana** (it is deliberately dropped on qwen/seedream, where an edit
 *    model mangles a style ref), and only within its conditioning scope;
 *  - so on a seedream channel with an active distilled style and authored
 *    prompts, ALL THREE carriers missed and the prompt reached the model with no
 *    register at all — the exact "NOT photographic" channel rendering photoreal.
 *
 * There is therefore no carve-out: a builder-skipped prompt always gets a TEXT
 * register. The distilled style wins when one is active (its `promptSuffix` is
 * the sentence built to be appended verbatim to every generation prompt, and it
 * is what the builder would have woven in); otherwise the channel's house
 * `dna.imageStyle`. Reference conditioning, when it also fires, stacks on top —
 * exactly as it does for builder-written prompts.
 */
export function resolveShotStyleRegister(input: {
  /** the active distilled Style-tab style's promptSuffix, if a style is active */
  distilledPromptSuffix?: string | null;
  /** the channel's house dna.imageStyle */
  houseImageStyle?: string | null;
}): { register: string | null; source: StyleSource } {
  const distilled = resolveImageStyle(input.distilledPromptSuffix);
  if (distilled) return { register: distilled, source: "distilled_style" };
  const house = resolveImageStyle(input.houseImageStyle);
  if (house) return { register: house, source: "channel_image_style" };
  return { register: null, source: "none" };
}

export type ConditioningScope = "off" | "thumbnails" | "thumbs_hero" | "all_generated";

export type StyleConditioning = { scope: ConditioningScope; strength: number };

const CONDITIONING_SCOPES: ConditioningScope[] = ["off", "thumbnails", "thumbs_hero", "all_generated"];

/** Conditioning config with safe defaults (style transfer wants a LIGHTER
 * flux strength than the swap dialog's 0.8 rework). */
export function resolveConditioning(
  doc: { conditioning?: { scope?: string; strength?: number } | null } | null | undefined,
): StyleConditioning {
  const raw = doc?.conditioning;
  const scope = CONDITIONING_SCOPES.includes(raw?.scope as ConditioningScope)
    ? (raw!.scope as ConditioningScope)
    : "thumbs_hero";
  const strength = Math.min(0.9, Math.max(0.1, raw?.strength ?? 0.45));
  return { scope, strength };
}

/** Deterministic ref rotation (the #31 duplicate-reals lesson: precompute,
 * never share state across parallel steps; consecutive shots vary refs). */
export function styleRefKeyForIndex(refKeys: string[], i: number): string | undefined {
  if (refKeys.length === 0) return undefined;
  return refKeys[((i % refKeys.length) + refKeys.length) % refKeys.length];
}

/** The CHANNEL VISUAL STYLE block for the image-prompt builder's user prompt. */
export function styleBlockForImagePrompts(doc: {
  palette: string;
  lighting: string;
  composition: string;
  subjectTreatment: string;
  texture: string;
  energy: string;
  promptSuffix: string;
}): string {
  return [
    "CHANNEL VISUAL STYLE (distilled from the channel's own reference images — this look is bedded down):",
    `- palette: ${doc.palette}`,
    `- lighting: ${doc.lighting}`,
    `- composition: ${doc.composition}`,
    `- subject treatment: ${doc.subjectTreatment}`,
    `- texture: ${doc.texture}`,
    `- energy: ${doc.energy}`,
    `- style suffix (include VERBATIM in the shared Style/Mood suffix): ${doc.promptSuffix}`,
  ].join("\n");
}

/**
 * The channel style block for a SOLO CHARACTER IDENTITY PLATE — the RENDER
 * REGISTER only (palette, lighting, texture, energy, style suffix). It
 * deliberately OMITS `composition` and `subjectTreatment`, which describe the
 * channel's SCENE framing/scale/crop and were dragging channel-thematic scenery
 * and moodboard/collage layouts into isolated plates (tickets 01KYA1AK…/#56 and
 * 01KYB5BQ…/#57 finding #3). The plate supplies its OWN neutral framing (single
 * figure, plain ground), so the channel need only lend its look, not its staging.
 */
export function styleBlockForCharacterPlate(doc: {
  palette: string;
  lighting: string;
  texture: string;
  energy: string;
  promptSuffix: string;
}): string {
  return [
    "CHANNEL VISUAL STYLE — render register ONLY (this is a solo character plate; the channel's scene composition, scale and staging are deliberately excluded — the figure's own framing governs):",
    `- palette: ${doc.palette}`,
    `- lighting: ${doc.lighting}`,
    `- texture: ${doc.texture}`,
    `- energy: ${doc.energy}`,
    `- style suffix (include VERBATIM in the shared Style/Mood suffix): ${doc.promptSuffix}`,
  ].join("\n");
}
