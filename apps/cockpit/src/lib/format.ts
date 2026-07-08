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

/** "7 Jul, 03:50" — for timestamps in tables. */
export function fmtDateTime(d: Date | string): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  const hh = String(dt.getHours()).padStart(2, "0");
  const mm = String(dt.getMinutes()).padStart(2, "0");
  return `${dt.getDate()} ${MONTHS[dt.getMonth()]}, ${hh}:${mm}`;
}

/** "7 Jul 2026" — for dates where the time is noise. */
export function fmtDate(d: Date | string): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  return `${dt.getDate()} ${MONTHS[dt.getMonth()]} ${dt.getFullYear()}`;
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
};
export const prodStatusLabel = (s: string) => PROD_STATUS[s] ?? s.replace(/_/g, " ");

export const gateKindLabel = (k: string) =>
  k === "script_review" ? "Script review" : k === "thumbnail_review" ? "Final review" : k.replace(/_/g, " ");

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

const IDEA_SOURCE: Record<string, string> = { agent: "Agent", manual: "Manual", research: "Research" };
export const ideaSourceLabel = (s: string) => IDEA_SOURCE[s] ?? s;

const ALERT_KIND: Record<string, string> = {
  underperformance: "Underperformance",
  low_retention: "Low retention",
  demonetisation: "Demonetisation",
  copyright_claim: "Copyright claim",
  comment_sentiment: "Comment sentiment",
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
  { key: "producing_assets", label: "Assets" },
  { key: "assembling", label: "Assembling" },
  { key: "thumbnail_review", label: "Final review" },
  { key: "ready", label: "Ready" },
  { key: "scheduled", label: "Scheduled" },
];
