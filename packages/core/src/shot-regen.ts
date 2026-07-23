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

export type ShotEntityRef = { idx: number; entity: string | null };
export type DuplicateRiskGroup = { entity: string; idxs: number[] };

/**
 * Shots that share a referenceEntity with another shot in the SAME production
 * (ticket 01KY6DCD…). A shared entity means a shared source-query pool, which per
 * ticket 01KY1ZNP… is a high duplicate-image RISK (not a certainty). Surfaced on
 * get_production_shots + the visuals gate so an operator sees "N suspect shots
 * still pending" BEFORE approving the gate — after which regenerate_shot is no
 * longer available. Groups are largest-first. Only entity-bearing shots count.
 */
export function duplicateRiskGroups(shots: ShotEntityRef[]): DuplicateRiskGroup[] {
  const byEntity = new Map<string, number[]>();
  for (const s of shots) {
    const e = s.entity?.trim();
    if (!e) continue;
    (byEntity.get(e) ?? byEntity.set(e, []).get(e)!).push(s.idx);
  }
  return [...byEntity.entries()]
    .filter(([, idxs]) => idxs.length >= 2)
    .map(([entity, idxs]) => ({ entity, idxs: idxs.slice().sort((a, b) => a - b) }))
    .sort((a, b) => b.idxs.length - a.idxs.length || a.entity.localeCompare(b.entity));
}

/** Total shots that share an entity with another shot (sum of group sizes). */
export function outstandingDuplicateShotCount(groups: DuplicateRiskGroup[]): number {
  return groups.reduce((n, g) => n + g.idxs.length, 0);
}
