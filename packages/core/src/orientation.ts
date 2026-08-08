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

/**
 * Is this channel making LONG-FORM video? The single definition, because the
 * cockpit and the worker used to disagree (2026-07-25 operator: "the Enoch images
 * — although saying 16:9 — are being created as portrait").
 *
 * A channel set to `contentFormat: "both"` with a long `targetLengthSec` IS
 * long-form. The worker knew that; six cockpit actions tested only
 * `contentFormat === "long"`, so every image REGENERATED from the cockpit on a
 * "both" channel was requested as 9:16 and came back portrait, while the
 * pipeline's own images were 16:9. Same production, two shapes.
 */
export function isLongForm(input: {
  contentFormat?: string | null;
  targetLengthSec?: number | null;
}): boolean {
  return input.contentFormat === "long" || (input.targetLengthSec ?? 0) > 90;
}

/**
 * The frame shape a channel's videos use — the ONE place that decides it.
 *
 * Precedence: the Production Profile's EXPLICIT `orientation` (landscape /
 * portrait) wins; "auto" or unset falls back to the derived rule (long-form →
 * 16:9, Shorts → 9:16). Use this for every image, clip and render request so the
 * cockpit and the worker can never disagree again.
 */
export function videoAspect(input: {
  contentFormat?: string | null;
  targetLengthSec?: number | null;
  /** ProductionProfile.orientation — "auto" | "landscape" | "portrait" */
  orientation?: string | null;
}): "9:16" | "16:9" {
  if (input.orientation === "landscape") return "16:9";
  if (input.orientation === "portrait") return "9:16";
  return isLongForm(input) ? "16:9" : "9:16";
}

/**
 * #105 (reopen): does THIS production's shot planner run in long-form mode?
 *
 * The render has always answered this with `videoAspect(...) === "16:9"` —
 * i.e. an explicit `productionProfile.orientation` wins over the channel-level
 * derivation. Every OTHER shot-planning caller tested only
 * `contentFormat === "long" || targetLengthSec > 90`, which ignores orientation.
 *
 * That divergence is the same class of bug `videoAspect` was created to kill.
 * On a `contentFormat: "both"` channel with a 1200s target, a 2-minute
 * `orientation: "portrait"` Short was cut SHORT-FORM by the render and
 * LONG-FORM by the projection, by `regenerate_shot`'s re-plan, and by clip
 * generation — which claims in its own comment to "cut it the SAME way the
 * render did". So `shotPlan` described a plan that would not run, and the
 * short-form shot rules were unreachable for an author who had done everything
 * right except own a separate Shorts channel.
 *
 * Use THIS for shot planning. Identical to the old rule whenever `orientation`
 * is "auto"/unset, which is every channel that hasn't deliberately overridden it.
 */
export function isLongFormShotPlan(input: {
  contentFormat?: string | null;
  targetLengthSec?: number | null;
  /** ProductionProfile.orientation — "auto" | "landscape" | "portrait" */
  orientation?: string | null;
}): boolean {
  return videoAspect(input) === "16:9";
}
