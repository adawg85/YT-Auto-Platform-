/**
 * Orientation enforcement (2026-07-25 operator: "all prompts for image and
 * animations need to take their orientation setting for video and have it
 * appended to any prompt in production — this is to ensure it always will make
 * the image to that spec").
 *
 * Every generation request already carries an `aspect` (16:9 for long-form,
 * 9:16 for Shorts, 1:1 for avatars), but image and video models treat that API
 * parameter as a HINT and routinely return the wrong shape — a portrait still in
 * a 16:9 render either letterboxes or centre-crops, which destroys the
 * composition the prompt was written for (ticket 01KY9EBK…/#50).
 *
 * The fix is belt-and-braces: keep passing `aspect`, AND state the orientation
 * in the prompt text, where models actually obey it. `withOrientation` is applied
 * centrally in the provider factory, so it covers EVERY prompt — pipeline beats,
 * hero shots, thumbnails, per-shot regenerations, animation/i2v motion prompts,
 * and operator/Claude-authored verbatim prompts alike.
 */
export type GenAspect = "9:16" | "16:9" | "1:1";

/** The sentence appended to a prompt to pin its frame shape. */
export function orientationClause(aspect: GenAspect): string {
  switch (aspect) {
    case "16:9":
      return "Wide 16:9 landscape orientation — a horizontal widescreen frame, wider than it is tall.";
    case "9:16":
      return "Vertical 9:16 portrait orientation — a tall phone-screen frame, taller than it is wide.";
    case "1:1":
      return "Square 1:1 orientation — equal width and height.";
  }
}

/** Detects a clause we (or the author) already added, so it is never doubled. */
function alreadyStated(prompt: string, aspect: GenAspect): boolean {
  const p = prompt.toLowerCase();
  if (aspect === "16:9") return /16:9|widescreen|landscape orientation/.test(p);
  if (aspect === "9:16") return /9:16|portrait orientation|vertical video/.test(p);
  return /1:1|square orientation/.test(p);
}

/**
 * Append the orientation clause unless the prompt already pins that shape.
 * Idempotent, so re-running a prompt through it never stacks clauses.
 */
export function withOrientation(prompt: string, aspect: GenAspect): string {
  const base = prompt.trim();
  if (!base) return base;
  if (alreadyStated(base, aspect)) return base;
  const sep = /[.!?]$/.test(base) ? " " : ". ";
  return `${base}${sep}${orientationClause(aspect)}`;
}

/** The frame shape a channel's videos use: long-form is 16:9, Shorts are 9:16. */
export function aspectForFormat(contentFormat: string | null | undefined): "9:16" | "16:9" {
  return contentFormat === "long" ? "16:9" : "9:16";
}
