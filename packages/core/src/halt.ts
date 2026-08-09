/**
 * P1 — the halt taxonomy.
 *
 * The pipeline has twenty failure exits between greenlight and publish and
 * NINETEEN of them wrote the same status (`on_hold`), distinguished only by a
 * sentence of free text. A reviewer rejecting the visuals and YouTube
 * exhausting its upload quota produced the same row, so the operator's first
 * move on every halt was to read prose and guess which of four recovery verbs
 * was safe — and the destructive one (`retry_production("visuals")`, which
 * re-bills every image) sat next to the harmless ones at equal weight.
 *
 * Tickets #94, #97 and #98 are all variants of "I could not tell what state I
 * was in or what to do about it". This module turns that inference into a
 * lookup: every `on_hold` write names its KIND, and the kind carries the
 * canonical recovery verb plus whether a machine may retry it unattended.
 *
 * Pure and table-driven so the cockpit button, the MCP response and any future
 * auto-retry loop cannot disagree about what a halt means.
 */

/** The five genuinely different reasons a production stops. */
export const HALT_KINDS = [
  /** The operator rejected it. Nothing is broken; it waits on THEM. */
  "human_decision",
  /** Nobody answered a gate in time. The work is intact, often part-approved. */
  "gate_timeout",
  /** An automated judgement said no (factuality, variation, review board). */
  "compliance_block",
  /** Quota, upload limits — a WINDOW that clears on its own. Nothing about the
   * video is wrong. (#78: a stale render bundle is NOT this class — it needs a
   * redeploy, not a wait, and lives under `precondition`.) */
  "external_retryable",
  /** A guard fired: duplicate publish, revision limit, no approved script, a
   * stale Remotion bundle. Something must be FIXED before a retry can work. */
  "precondition",
] as const;

export type HaltKind = (typeof HALT_KINDS)[number];

export type HaltPolicy = {
  kind: HaltKind;
  /** one line, in the operator's language — what actually happened */
  summary: string;
  /** the canonical recovery verb for this class */
  recommendedAction: string;
  /**
   * May a machine re-fire this WITHOUT a human present? True only for the
   * external/transient class — everything else needs judgement, and the repo
   * rule is that nothing changing live behaviour runs unattended.
   */
  canAutoRetry: boolean;
  /** does clearing this cost money? surfaced so the destructive verb is never silent */
  recoveryRebills: boolean;
};

const POLICY: Record<HaltKind, Omit<HaltPolicy, "kind">> = {
  human_decision: {
    summary: "You rejected this at a review gate — it is waiting on your edit, not on the platform.",
    recommendedAction:
      "Make the change (edit_shot_prompts / regenerate_shot / set_publication_metadata), then retry_production from the stage you changed.",
    canAutoRetry: false,
    recoveryRebills: false,
  },
  gate_timeout: {
    summary: "A review gate went unanswered past its window. Every artifact is intact.",
    recommendedAction:
      "Re-open the gate and decide it, or force_forward if you have already reviewed the work elsewhere. Nothing needs regenerating.",
    canAutoRetry: false,
    recoveryRebills: false,
  },
  compliance_block: {
    summary: "An automated compliance check blocked this — it may be correct, or a false positive.",
    recommendedAction:
      "Read the named counterparty/reason first. Fix the substance if the block is real; force_forward only when you have judged it a false positive (that WAIVES the control and is logged).",
    canAutoRetry: false,
    recoveryRebills: false,
  },
  external_retryable: {
    summary: "An external system was unavailable (quota, upload limit). The production is fine.",
    recommendedAction: "Wait for the window to clear, then force_forward. No content change is needed.",
    canAutoRetry: true,
    recoveryRebills: false,
  },
  precondition: {
    summary: "A guard stopped this before or after work — a config, lineage or infrastructure problem, not a content problem.",
    recommendedAction:
      "Fix the underlying condition FIRST — the failureReason names it (retire the duplicate, correct the config, redeploy the stale Remotion bundle) — then continue_production or retry_production. force_forward cannot waive this class.",
    canAutoRetry: false,
    recoveryRebills: false,
  },
};

/**
 * #78: is force_forward even meaningful for this block? A `precondition` halt
 * is an infrastructure/config guard, not a soft check — forcing re-fires the
 * pipeline into the SAME guard (there is nothing to waive), and the old path
 * additionally ERASED the failureReason that carried the fix instructions.
 * Returns the refusal message, or null when force_forward may proceed.
 */
export function forceForwardRefusal(
  status: string,
  haltKind: string | null | undefined,
  failureReason?: string | null,
): string | null {
  if (status !== "on_hold" || haltKind !== "precondition") return null;
  return (
    "Force-forward is not available for this block: it is an infrastructure/config guard (haltKind 'precondition'), not a soft check — there is nothing to waive, and forcing would just re-halt at the same guard. " +
    (failureReason ? `The guard says: ${failureReason} ` : "") +
    "Fix that condition, then continue_production (or retry_production from the stage that needs it)."
  );
}

/** The full policy for a kind. Unknown/legacy values degrade to `precondition`. */
export function haltPolicy(kind: string | null | undefined): HaltPolicy {
  const k = (HALT_KINDS as readonly string[]).includes(kind ?? "")
    ? (kind as HaltKind)
    : "precondition";
  return { kind: k, ...POLICY[k] };
}

/** True when a machine may re-fire this halt with no human present. */
export function haltIsAutoRetryable(kind: string | null | undefined): boolean {
  return haltPolicy(kind).canAutoRetry;
}

/**
 * The health object both surfaces read (P5). `null` means healthy — a caller
 * should never have to parse a status string to answer "is this thing stuck and
 * what do I do about it".
 */
export type ProductionBlock = {
  kind: HaltKind;
  status: string;
  /** the raw failureReason, which now carries the counterparty where one exists */
  reason: string | null;
  summary: string;
  recommendedAction: string;
  canAutoRetry: boolean;
  since: Date | string | null;
  stuckForMinutes: number | null;
};

/** Statuses that mean "stopped and needing a decision". */
const BLOCKED_STATUSES: readonly string[] = ["on_hold", "failed", "rejected", "halted"];

/**
 * #103 — `halted` is a stop, and it was the one stop `blocked` did not cover.
 *
 * A halt is deliberate: the operator pressed Halt (or called `halt_production`),
 * and that path writes `failureReason: null` by design because nothing failed.
 * The result was a production reading `status: "halted", blocked: null` — the
 * exact "healthy" shape, on a run that had stopped — leaving no reason and no
 * recommendedAction, which is the situation `blocked` exists to prevent.
 *
 * It is a human decision, so the KIND is right; only the prose needed to change,
 * because the human_decision copy describes a gate rejection and the recovery
 * verbs for a halt are the in-place ones.
 */
const HALTED_COPY = {
  summary:
    "You halted this deliberately — the run stopped where it was. Nothing failed, and every artifact you did not discard at the halt is still attached.",
  recommendedAction:
    "continue_production resumes IN PLACE from where it stopped (nothing re-billed, no sibling row). Use reopen_stage to go back to a specific stage and redo it — e.g. the voiceover, if that is what you halted over. resume_production is the legacy path and mints a sibling production.",
} as const;

/**
 * Build the health object for one production. `now` is injected so this stays
 * pure and testable.
 */
export function productionBlock(
  row: {
    status: string;
    failureReason?: string | null;
    haltKind?: string | null;
    updatedAt?: Date | string | null;
  },
  now: Date,
): ProductionBlock | null {
  if (!BLOCKED_STATUSES.includes(row.status)) return null;
  // `failed` is the retries-exhausted crash path and `rejected` is a human's
  // final no — neither carries a haltKind from the pipeline's off-ramps, so map
  // them explicitly rather than letting them fall through to `precondition`.
  const kind: HaltKind =
    row.status === "rejected" || row.status === "halted"
      ? "human_decision"
      : row.haltKind && (HALT_KINDS as readonly string[]).includes(row.haltKind)
        ? (row.haltKind as HaltKind)
        : row.status === "failed"
          ? "external_retryable"
          : "precondition";
  const policy = haltPolicy(kind);
  // a halt shares the kind with a gate rejection but not the recovery verbs
  const copy = row.status === "halted" ? HALTED_COPY : policy;
  const at = row.updatedAt ? new Date(row.updatedAt) : null;
  const mins =
    at && !Number.isNaN(at.getTime()) ? Math.floor((now.getTime() - at.getTime()) / 60_000) : null;
  return {
    kind,
    status: row.status,
    reason: row.failureReason ?? null,
    summary: copy.summary,
    recommendedAction: copy.recommendedAction,
    canAutoRetry: policy.canAutoRetry,
    since: row.updatedAt ?? null,
    stuckForMinutes: mins,
  };
}

/**
 * P6 — the three authoring intentions.
 *
 * `externalScript` was one boolean governing three unrelated behaviours: skip
 * the human script gate, skip the image-prompt builder (use authored prompts
 * verbatim), and honour authored motion prompts. When `resume_production`
 * dropped it (#94), an authored production silently became a generated one —
 * the gate reappeared, the builder rewrote 126 authored prompts, and the motion
 * prompts were ignored, with nothing to say so because the consequences had no
 * names.
 *
 * Resolving them through one function means a copy boundary carries a STRUCT,
 * not a flag, and a partial pass (your script, the platform's prompts) becomes
 * expressible instead of impossible.
 */
export type AuthoringIntents = {
  scriptAuthored: boolean;
  promptsAuthored: boolean;
  motionAuthored: boolean;
};

export function resolveAuthoringIntents(row: {
  externalScript?: boolean | null;
  scriptAuthored?: boolean | null;
  promptsAuthored?: boolean | null;
  motionAuthored?: boolean | null;
}): AuthoringIntents {
  // null = inherit the legacy flag, so existing rows behave identically
  const legacy = row.externalScript === true;
  return {
    scriptAuthored: row.scriptAuthored ?? legacy,
    promptsAuthored: row.promptsAuthored ?? legacy,
    motionAuthored: row.motionAuthored ?? legacy,
  };
}

/**
 * #100: tell a LOCAL failure apart from a YouTube rejection.
 *
 * `setThumbnail` re-encodes the image with `sharp` BEFORE calling YouTube, so a
 * missing native binary threw inside our own process — and both call sites
 * reported it as "YouTube rejected the thumbnail". The operator went looking at
 * image dimensions and file size for a fault that was a deploy problem and had
 * never reached YouTube at all.
 */
export function describeThumbnailApplyError(err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  // sharp's own loader error, plus the generic native-module shapes
  const local =
    /could not load sharp|sharp.*runtime|Cannot find module|MODULE_NOT_FOUND|\.node\b|libvips/i.test(
      reason,
    );
  if (local) {
    return (
      `Thumbnail processing failed BEFORE upload — YouTube was never called. ${reason} ` +
      `This is a deploy/runtime problem (the image library's native binary is missing on the host), not a problem with the image. ` +
      `Nothing about the video or the candidate needs changing; it will work once the host is rebuilt with the binary present.`
    );
  }
  return (
    `YouTube rejected the thumbnail: ${reason}. ` +
    `If it's a permission error, re-consent the channel with the youtube thumbnails.set scope on /account; ` +
    `custom thumbnails also require a verified YouTube channel.`
  );
}
