export function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, "") + "M";
  if (n >= 1_000) return Math.round(n / 100) / 10 + "K";
  return String(Math.round(n));
}

/** Money for cost surfaces: cents matter under $1, don't show noise above it. */
export function fmtMoney(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

export function fmtWhen(d: Date): string {
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ── Display timezone (BACKLOG #20) ────────────────────────────────────────
// The operator runs the platform from Melbourne, so EVERY cockpit timestamp
// renders in Australia/Melbourne (AEST/AEDT) and every schedule input is
// interpreted as Melbourne wall time — regardless of where the server (UTC on
// Render) or the browser happens to be. Storage stays UTC throughout.

export const DISPLAY_TZ = process.env.NEXT_PUBLIC_DISPLAY_TZ || "Australia/Melbourne";

const TZ_DTF = new Intl.DateTimeFormat("en-GB", {
  timeZone: DISPLAY_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export type ZonedParts = { y: number; m: number; d: number; hh: number; mm: number; ss: number };

/** The instant's wall-clock parts in DISPLAY_TZ (m is 0-based like Date). */
export function zonedParts(d: Date | string): ZonedParts {
  const dt = typeof d === "string" ? new Date(d) : d;
  const map: Record<string, string> = {};
  for (const p of TZ_DTF.formatToParts(dt)) map[p.type] = p.value;
  return { y: +map.year!, m: +map.month! - 1, d: +map.day!, hh: +map.hour!, mm: +map.minute!, ss: +map.second! };
}

const TZ_NAME_DTF = new Intl.DateTimeFormat("en-AU", { timeZone: DISPLAY_TZ, timeZoneName: "short" });

/** The zone label at an instant — "AEST" or "AEDT" (DST-aware). */
export function tzAbbr(d: Date | string = new Date()): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  return TZ_NAME_DTF.formatToParts(dt).find((p) => p.type === "timeZoneName")?.value ?? "";
}

/** ms the DISPLAY_TZ wall clock is ahead of UTC at the given instant. */
function wallOffsetMs(at: Date): number {
  const p = zonedParts(at);
  return Date.UTC(p.y, p.m, p.d, p.hh, p.mm, p.ss) - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * A "YYYY-MM-DDTHH:mm" datetime-local value, entered as DISPLAY_TZ wall time,
 * → UTC ISO. Two-pass offset lookup keeps DST transition edges correct.
 */
export function zonedInputToIso(naive: string): string {
  const m = naive.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return new Date(naive).toISOString();
  const guess = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
  const once = guess - wallOffsetMs(new Date(guess));
  return new Date(guess - wallOffsetMs(new Date(once))).toISOString();
}

/** "7 Jul, 03:50" (Melbourne wall time) — for timestamps in tables. */
export function fmtDateTime(d: Date | string): string {
  const p = zonedParts(d);
  return `${p.d} ${MONTHS[p.m]}, ${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
}

/** "7 Jul 2026" (Melbourne) — for dates where the time is noise. */
export function fmtDate(d: Date | string): string {
  const p = zonedParts(d);
  return `${p.d} ${MONTHS[p.m]} ${p.y}`;
}

/** Seconds → "M:SS" (or "SSs" under a minute). */
export function fmtDuration(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export const TIERS = ["T0 · Manual", "T1 · Assisted", "T2 · Supervised", "T3 · Exception-only"];
export const tierLabel = (t: number) => TIERS[t] ?? `T${t}`;

// ── Human labels for enum values (nothing raw ever renders) ──────────────

const PROD_STATUS: Record<string, string> = {
  proposed: "Proposed",
  scored: "Scored",
  greenlit: "Greenlit",
  scripting: "Scripting",
  script_review: "Script review",
  profile_review: "Profile review",
  voiceover_recording: "Recording voiceover",
  visuals_review: "Visuals review",
  producing_assets: "Producing assets",
  assembling: "Assembling",
  thumbnail_review: "Final review",
  ready: "Ready",
  scheduled: "Scheduled",
  published: "Published",
  analysing: "Analysing",
  rejected: "Rejected",
  failed: "Failed",
  on_hold: "On hold",
  halted: "Halted — returned to ideas",
  superseded: "Superseded — replaced by a corrected copy",
};
export const prodStatusLabel = (s: string) => PROD_STATUS[s] ?? s.replace(/_/g, " ");

export const gateKindLabel = (k: string) =>
  k === "script_review"
    ? "Script review"
    : k === "profile_review"
      ? "Profile review"
      : k === "voiceover_recording"
        ? "Voiceover recording"
        : k === "visuals_review"
          ? "Visuals review"
          : k === "thumbnail_review"
            ? "Final review"
            : k.replace(/_/g, " ");

const GATE_DECISION: Record<string, string> = {
  approved: "Approved",
  rejected: "Rejected",
  revise: "Revision requested",
};
export const gateDecisionLabel = (d: string) => GATE_DECISION[d] ?? d;

const IDEA_STATUS: Record<string, string> = {
  inbox: "Inbox",
  scored: "Scored",
  greenlit: "Greenlit",
  rejected: "Rejected",
  archived: "Archived",
};
export const ideaStatusLabel = (s: string) => IDEA_STATUS[s] ?? s;

const IDEA_SOURCE: Record<string, string> = { agent: "Agent", manual: "Manual", research: "Research", editorial: "Editorial" };
export const ideaSourceLabel = (s: string) => IDEA_SOURCE[s] ?? s;

// Editorial episode lifecycle → plain English (no raw enums in the UI).
const EPISODE_STATUS: Record<string, string> = {
  planned: "Queued to research",
  researching: "Researching",
  verifying: "Fact-checking",
  briefed: "Brief ready",
  queued: "Ready to produce",
  produced: "Produced",
  published: "Published",
  cut: "Cut — no facts held up",
};
export const episodeStatusLabel = (s: string) => EPISODE_STATUS[s] ?? s.replace(/_/g, " ");

const CLAIM_STATUS: Record<string, string> = {
  verified: "Verified",
  attributed: "Attributed",
  cut: "Cut",
  unverified: "Unverified",
};
export const claimStatusLabel = (s: string) => CLAIM_STATUS[s] ?? s;

const CLAIM_TIER: Record<string, string> = {
  established: "Established fact",
  emerging: "Emerging",
  contested: "Contested",
};
export const claimTierLabel = (t: string) => CLAIM_TIER[t] ?? t;

const ALERT_KIND: Record<string, string> = {
  underperformance: "Underperformance",
  low_retention: "Low retention",
  demonetisation: "Demonetisation",
  copyright_claim: "Copyright claim",
  comment_sentiment: "Comment sentiment",
  viability: "Channel viability",
  capacity: "Platform capacity",
};
export const alertKindLabel = (k: string) => ALERT_KIND[k] ?? k.replace(/_/g, " ");

const ALERT_SEVERITY: Record<string, string> = { info: "Info", warning: "Warning", critical: "Critical" };
export const alertSeverityLabel = (s: string) => ALERT_SEVERITY[s] ?? s;

const COST_CATEGORY: Record<string, string> = {
  llm: "LLM",
  voice: "Voice",
  media: "Media",
  render: "Render",
  publish: "Publish",
  research: "Research",
};
export const costCategoryLabel = (c: string) => COST_CATEGORY[c] ?? c;

export const channelStatusLabel = (s: string) =>
  s === "active" ? "Active" : s === "paused" ? "Paused" : s === "archived" ? "Archived" : s;

// In-flight production statuses, in pipeline order, for the "In production" board.
export const PIPELINE_STAGES: { key: string; label: string }[] = [
  { key: "scripting", label: "Scripting" },
  { key: "script_review", label: "Script review" },
  { key: "profile_review", label: "Profile review" },
  { key: "producing_assets", label: "Assets" },
  { key: "visuals_review", label: "Visuals review" },
  { key: "assembling", label: "Assembling" },
  { key: "thumbnail_review", label: "Final review" },
  { key: "ready", label: "Ready" },
  { key: "scheduled", label: "Scheduled" },
];
