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
  /** Quota, upload limits, a stale render bundle. Nothing about the video is wrong. */
  "external_retryable",
  /** A guard fired: duplicate publish, revision limit, no approved script. */
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
    summary: "An external system was unavailable (quota, upload limit, a stale render bundle). The production is fine.",
    recommendedAction: "Wait for the window to clear, then force_forward. No content change is needed.",
    canAutoRetry: true,
    recoveryRebills: false,
  },
  precondition: {
    summary: "A guard stopped this before or after work — usually a config or lineage problem, not a content problem.",
    recommendedAction:
      "Fix the underlying condition (retire the duplicate, correct the config, approve or replace the script), then retry_production.",
    canAutoRetry: false,
    recoveryRebills: false,
  },
};

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
const BLOCKED_STATUSES: readonly string[] = ["on_hold", "failed", "rejected"];

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
    row.status === "rejected"
      ? "human_decision"
      : row.haltKind && (HALT_KINDS as readonly string[]).includes(row.haltKind)
        ? (row.haltKind as HaltKind)
        : row.status === "failed"
          ? "external_retryable"
          : "precondition";
  const policy = haltPolicy(kind);
  const at = row.updatedAt ? new Date(row.updatedAt) : null;
  const mins =
    at && !Number.isNaN(at.getTime()) ? Math.floor((now.getTime() - at.getTime()) / 60_000) : null;
  return {
    kind,
    status: row.status,
    reason: row.failureReason ?? null,
    summary: policy.summary,
    recommendedAction: policy.recommendedAction,
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
