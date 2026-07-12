import type { Tone } from "@/components/ui/badge";

/**
 * Live-status language (BACKLOG #19, task #21). Every production status maps
 * to ONE of five operator-facing kinds, so the whole cockpit answers the same
 * three questions the same way everywhere: is it moving, is it waiting on me,
 * did it stop?
 *
 *  - working    → the pipeline is actively progressing (animated dot)
 *  - waiting    → blocked on the operator (a gate decision or an unblock)
 *  - scheduled  → parked on the calendar, will fire on its own
 *  - live       → published and out in the world
 *  - halted     → stopped and will NOT progress without intervention
 *  - idle       → pre-pipeline (proposed/scored) — nothing running
 */
export type StatusKind = "working" | "waiting" | "scheduled" | "live" | "halted" | "idle";

const KIND: Record<string, StatusKind> = {
  proposed: "idle",
  scored: "idle",
  greenlit: "working",
  scripting: "working",
  script_review: "waiting",
  profile_review: "waiting",
  producing_assets: "working",
  assembling: "working",
  thumbnail_review: "waiting",
  // transient: the pipeline schedules it immediately after marking ready
  ready: "working",
  scheduled: "scheduled",
  published: "live",
  analysing: "live",
  rejected: "halted",
  failed: "halted",
  // on_hold = a soft gate flagged it; force-forward or halt is an operator call
  on_hold: "waiting",
  halted: "halted",
};

export const statusKind = (status: string): StatusKind => KIND[status] ?? "idle";

export const KIND_TONE: Record<StatusKind, Tone> = {
  working: "accent",
  waiting: "warn",
  scheduled: "accent",
  live: "good",
  halted: "crit",
  idle: "neutral",
};

/** kinds whose dot should pulse — "something is happening right now" */
export const KIND_PULSES: Record<StatusKind, boolean> = {
  working: true,
  waiting: false,
  scheduled: false,
  live: false,
  halted: false,
  idle: false,
};

/** Portfolio / channel system-status counts (the status strip). */
export type StatusSummary = {
  working: number;
  scheduled: number;
  waiting: number; // pending gates + on_hold — "needs you"
  failed: number; // failed only; halted productions were deliberately parked
};

export const WORKING_STATUSES = [
  "greenlit",
  "scripting",
  "producing_assets",
  "assembling",
  "ready",
] as const;
export const WAITING_STATUSES = ["script_review", "profile_review", "thumbnail_review", "on_hold"] as const;
