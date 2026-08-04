/**
 * The production STAGE machine (2026-08-04 operator design session).
 *
 * The standing complaint: "every time we hit an issue, it pushes me way back to
 * the start". That was structurally true. The pipeline had no notion of a stage
 * you could re-enter — `force_forward` and `retry_production` both re-fire
 * `production/greenlit` and rely on skip-if-present to no-op through completed
 * work, so every recovery LOOKED like a restart, and `resume_production` went
 * further and minted a whole new production row (the sibling lineage behind
 * #94, #96 and #97).
 *
 * This module is the engine for the replacement. It is pure — no DB, no I/O —
 * so the rules that decide what survives a reopen are unit-testable, which
 * matters because getting them wrong destroys paid work.
 *
 * Three operations, all IN PLACE on one production row:
 *   HOLD     — freeze where you are. In-flight generation finishes and is kept;
 *              nothing new is dispatched.
 *   CONTINUE — resume from exactly where the hold happened. No artifact is
 *              touched, nothing is re-billed.
 *   REOPEN   — go back to a named stage. Everything that depends on that stage
 *              is marked STALE and shown as such, and is deleted only when the
 *              reopened stage actually produces new output. Until then the
 *              reopen is reversible, because reopening is often diagnostic —
 *              you frequently cannot tell which stage is at fault until you
 *              open it.
 */

/** The stages a production moves through, in order. */
export const PRODUCTION_STAGES = [
  "script",
  "voiceover",
  "visuals",
  "music",
  "render",
  "thumbnail",
  "publish",
] as const;

export type ProductionStage = (typeof PRODUCTION_STAGES)[number];

export function isProductionStage(v: string): v is ProductionStage {
  return (PRODUCTION_STAGES as readonly string[]).includes(v);
}

/**
 * DIRECT dependencies: reopening the key stage invalidates these outputs
 * because they were DERIVED from it. Transitive closure is computed below, so
 * each entry lists only what depends on that stage *directly*.
 *
 * The one that surprises operators: re-recording the VOICEOVER invalidates the
 * VISUALS. Shot boundaries are cut from word timestamps (`planShots(beats,
 * words, …)`), so new audio re-cuts the shot plan and the existing stills no
 * longer land on the lines they were drawn for. The script survives — the shots
 * cannot.
 *
 * And the ones that deliberately DON'T cascade: music is chosen by mood, not
 * derived from the picture, so re-cutting the visuals must not throw away the
 * operator's chosen track; the thumbnail is a standalone asset, so it survives
 * a voiceover or render redo. Only a SCRIPT change reaches it, because the
 * title and angle it is composed from can change.
 */
const DIRECT_INVALIDATIONS: Record<ProductionStage, ProductionStage[]> = {
  script: ["voiceover", "thumbnail"],
  voiceover: ["visuals"],
  visuals: ["render"],
  music: ["render"],
  render: [],
  thumbnail: [],
  publish: [],
};

/**
 * Every stage invalidated by reopening `stage`, transitively, in pipeline
 * order. Reopening `script` therefore reaches `render` through
 * voiceover → visuals → render without that edge being written down twice.
 */
export function invalidatedBy(stage: ProductionStage): ProductionStage[] {
  const seen = new Set<ProductionStage>();
  const walk = (s: ProductionStage) => {
    for (const next of DIRECT_INVALIDATIONS[s]) {
      if (seen.has(next)) continue;
      seen.add(next);
      walk(next);
    }
  };
  walk(stage);
  return PRODUCTION_STAGES.filter((s) => seen.has(s));
}

/** Asset `kind` values each stage owns, for the delete-on-re-run sweep. */
export const STAGE_ASSET_KINDS: Record<ProductionStage, string[]> = {
  script: [],
  voiceover: ["voiceover"],
  visuals: ["image", "video_clip"],
  music: [],
  render: ["render"],
  thumbnail: [],
  publish: [],
};

/** Stages whose output lives in its own table rather than `assets`. */
export const STAGE_OWNS_SCRIPT_DRAFTS: ProductionStage = "script";
export const STAGE_OWNS_MUSIC: ProductionStage = "music";
export const STAGE_OWNS_THUMBNAILS: ProductionStage = "thumbnail";

/**
 * Where the pipeline re-enters when a reopened stage starts running. The
 * production must never present a status UPSTREAM of work that still exists —
 * that was #98, where a fully built production showed as `greenlit` and read as
 * "kicked back to the script gate".
 */
export function statusForStage(stage: ProductionStage): string {
  switch (stage) {
    case "script":
      return "scripting";
    case "voiceover":
    case "visuals":
    case "music":
      return "producing_assets";
    case "render":
      return "assembling";
    case "thumbnail":
      return "thumbnail_review";
    case "publish":
      return "ready";
  }
}

/**
 * Two ways back into a stage, and they are genuinely different operations
 * (2026-08-04 operator: "I need to be able to CLEAN visuals, like REMOVE
 * visuals that exist, or REFINE PROMPTS for shots").
 *
 *  REOPEN — the stage becomes editable again and KEEPS its own output, so you
 *           can fix individual shots, swap one image, re-prompt three of them.
 *           Everything DOWNSTREAM still goes stale, because it was derived from
 *           a stage that is now in flux.
 *  CLEAN  — the stage's own output is thrown away too and rebuilt from scratch.
 *
 * Getting this wrong in either direction is expensive: a reopen that wipes
 * costs a full re-generation the operator didn't ask for, and a clean that
 * doesn't wipe leaves stale shots in a set the operator believes is fresh.
 */
export type ReopenMode = "reopen" | "clean";

export type ArtifactCounts = {
  voiceover?: number;
  images?: number;
  clips?: number;
  render?: number;
  thumbnails?: number;
  music?: number;
};

export type ReopenImpact = {
  stage: ProductionStage;
  mode: ReopenMode;
  /** stages whose output becomes stale, in pipeline order */
  staleStages: ProductionStage[];
  /** what will actually be destroyed, once the reopened stage re-runs */
  discards: string[];
  /** stages explicitly NOT touched — as important to state as what is */
  keeps: string[];
  /** the sentence the confirm dialog leads with */
  warning: string;
  /** when the discard actually happens */
  deletesWhen: string;
  reversible: true;
};

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The warning payload for a reopen. Both surfaces render this — the cockpit
 * dialog and the MCP tool response — so chat and the UI can never describe the
 * same destructive action differently.
 *
 * It names what is KEPT as well as what is lost: the operator's recurring
 * question is "will I lose the script if I redo the voiceover?", and answering
 * only half of it is why reopening felt unsafe.
 */
export function reopenImpact(
  stage: ProductionStage,
  have: ArtifactCounts = {},
  mode: ReopenMode = "reopen",
): ReopenImpact {
  // CLEAN also throws away the reopened stage's OWN output; REOPEN keeps it so
  // the operator can refine in place.
  const stale = mode === "clean" ? [stage, ...invalidatedBy(stage)] : invalidatedBy(stage);
  const discards: string[] = [];
  if (stale.includes("voiceover") && have.voiceover) discards.push("the voiceover");
  if (stale.includes("visuals")) {
    if (have.images) discards.push(plural(have.images, "image"));
    if (have.clips) discards.push(plural(have.clips, "motion clip"));
  }
  if (stale.includes("render") && have.render) discards.push("the render");
  if (stale.includes("thumbnail") && have.thumbnails) {
    discards.push(plural(have.thumbnails, "thumbnail"));
  }
  if (stale.includes("music") && have.music) discards.push("the music bed");

  const keeps: string[] = [];
  if (!stale.includes("script") && stage !== "script") keeps.push("the approved script");
  if (!stale.includes("voiceover") && have.voiceover) keeps.push("the voiceover");
  if (!stale.includes("visuals") && have.images) {
    keeps.push(
      mode === "reopen" && stage === "visuals"
        ? "every existing shot (refine them individually)"
        : "every rendered shot",
    );
  }
  if (!stale.includes("music") && have.music) keeps.push("the chosen music bed");
  if (!stale.includes("thumbnail") && have.thumbnails) keeps.push("the thumbnail");

  // The voiceover→visuals edge is the non-obvious one, so it gets said outright
  // rather than left for the operator to infer from a list of counts.
  const because =
    stage === "voiceover" && stale.includes("visuals")
      ? " Shot timings are cut from the voiceover's word timestamps, so new audio re-cuts the shot plan and the existing shots no longer match their lines."
      : "";

  const verb = mode === "clean" ? `Cleaning ${stage}` : `Re-running ${stage}`;
  const warning = discards.length
    ? `${verb} will discard ${listOf(discards)}.${because} Nothing is deleted yet.`
    : `${mode === "clean" ? "Cleaning" : "Reopening"} ${stage} discards nothing — there is no work to lose.`;

  return {
    stage,
    mode,
    staleStages: stale,
    discards,
    keeps,
    warning,
    deletesWhen: `When ${stage} actually produces new output. Until then this is reversible — cancel the reopen and the production is exactly as it was.`,
    reversible: true,
  };
}

function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "nothing";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Is this asset stale? An asset belongs to a stage; if that stage is in the
 * reopened stage's invalidation set, the asset is showing the operator work
 * that is about to be replaced and must be badged as such — an image that
 * looks current but isn't is worse than no image.
 */
export function stageOfAssetKind(kind: string): ProductionStage | null {
  for (const stage of PRODUCTION_STAGES) {
    if (STAGE_ASSET_KINDS[stage].includes(kind)) return stage;
  }
  return null;
}

export function isStaleAsset(
  kind: string,
  reopenedStage: string | null | undefined,
  mode: ReopenMode = "reopen",
): boolean {
  if (!reopenedStage || !isProductionStage(reopenedStage)) return false;
  const stage = stageOfAssetKind(kind);
  if (!stage) return false;
  const stale =
    mode === "clean" ? [reopenedStage, ...invalidatedBy(reopenedStage)] : invalidatedBy(reopenedStage);
  return stale.includes(stage);
}

/**
 * Where CONTINUE resumes a held production. Continue is not a retry: it must
 * land on the work that exists, never upstream of it, and must re-bill nothing.
 * Derived from artifacts rather than the stored status, because the stored
 * status is exactly what recovery paths have historically got wrong.
 */
export function continueStatusFor(have: ArtifactCounts & { script?: boolean }): string {
  if (have.render) return "assembling";
  if (have.images) return "producing_assets";
  if (have.voiceover) return "producing_assets";
  if (have.script) return "scripting";
  return "greenlit";
}
