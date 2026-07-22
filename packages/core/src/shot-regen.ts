/**
 * Per-shot regeneration helpers (ticket 01KY5W4T… / #38). Pure so the mode
 * inference and source classification behind the MCP regenerate_shot /
 * get_production_shots tools are unit-testable without a DB or image provider.
 */

/** The image models a shot can be (re)generated on. */
export type ImageEngine = "qwen" | "seedream" | "nano-banana";

/**
 * Which regenerate mode a set of caller params implies — mirrors the cockpit's
 * per-shot Regenerate/Re-source buttons: a referenceEntity means RE-SOURCE a real
 * photo; otherwise REGENERATE the still on the hero engine for a hero shot, else
 * the standard engine.
 */
export function regenShotMode(input: { referenceEntity?: string | null; heroShot?: boolean }): "real" | "standard" | "hero" {
  if (input.referenceEntity && input.referenceEntity.trim()) return "real";
  return input.heroShot ? "hero" : "standard";
}

/** Whether an image asset was SOURCED (real photo/clip) or GENERATED, from its meta. */
export function imageSourceKind(meta: Record<string, unknown> | null | undefined): "sourced" | "generated" {
  const source = meta?.source;
  return typeof source === "string" && source.length > 0 ? "sourced" : "generated";
}
