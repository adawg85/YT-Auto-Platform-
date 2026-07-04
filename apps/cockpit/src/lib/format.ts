export function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, "") + "M";
  if (n >= 1_000) return Math.round(n / 100) / 10 + "K";
  return String(Math.round(n));
}

export function fmtWhen(d: Date): string {
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export const TIERS = ["T0 manual", "T1 assisted", "T2 supervised", "T3 exception-only"];
export const tierLabel = (t: number) => TIERS[t] ?? `T${t}`;

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
