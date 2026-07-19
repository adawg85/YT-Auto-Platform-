import { fmtDateTime } from "@/lib/format";
import { IconAlertTriangle, IconCheck } from "@/components/icons";

/**
 * Live per-production pipeline stepper (task #21): Script → Voiceover →
 * Visuals → Assemble → Final review → Publish. Server-rendered, so it
 * advances automatically via the /api/live SSE refresh — spinner on the
 * active stage, check on done, amber when a stage waits on the operator,
 * red "Halted" with the reason when the pipeline stopped.
 */

export type StepState = "done" | "active" | "waiting" | "halted" | "pending";
export type Step = { key: string; label: string; state: StepState; sub?: string };

export type StepperInput = {
  status: string;
  failureReason: string | null;
  draftCount: number;
  hasVoiceover: boolean;
  imageCount: number;
  hasRender: boolean;
  /** the publication row, if one exists (created at schedule time) */
  scheduledFor: Date | null;
  publishedAt: Date | null;
};

const STAGES = [
  { key: "script", label: "Script" },
  { key: "voiceover", label: "Voiceover" },
  { key: "visuals", label: "Visuals" },
  { key: "assemble", label: "Assemble" },
  { key: "final", label: "Final review" },
  { key: "publish", label: "Publish" },
] as const;

const STOPPED = new Set(["failed", "rejected", "halted", "on_hold"]);

export function buildProductionSteps(p: StepperInput): Step[] {
  // Which stage is the pipeline at? Status is authoritative while running;
  // for stopped productions the surviving artifacts say how far it got.
  let cur: number;
  switch (p.status) {
    case "proposed":
    case "scored":
    case "greenlit":
    case "scripting":
    case "script_review":
      cur = 0;
      break;
    case "profile_review":
    case "voiceover_recording": // #27: the recording booth pends before TTS spend
      cur = 1; // decided before voice/visuals spend
      break;
    case "producing_assets":
      cur = p.hasVoiceover ? 2 : 1;
      break;
    case "visuals_review":
      cur = 2; // review the image set before any render spend
      break;
    case "assembling":
      cur = 3;
      break;
    case "thumbnail_review":
      cur = 4;
      break;
    case "ready":
    case "scheduled":
      cur = 5;
      break;
    case "published":
    case "analysing":
    case "superseded": // was fully published, then replaced by a corrected copy
      cur = STAGES.length; // everything done
      break;
    default:
      // stopped — infer progress from artifacts
      cur = !p.draftCount ? 0 : !p.hasVoiceover ? 1 : !p.imageCount ? 2 : !p.hasRender ? 3 : p.publishedAt || p.scheduledFor ? 5 : 4;
  }

  const stopped = STOPPED.has(p.status);
  const waitingOnYou =
    p.status === "script_review" ||
    p.status === "profile_review" ||
    p.status === "voiceover_recording" ||
    p.status === "visuals_review" ||
    p.status === "thumbnail_review";

  return STAGES.map((s, i) => {
    if (i < cur) return { ...s, state: "done", sub: doneSub(s.key, p) };
    if (i > cur) return { ...s, state: "pending" };
    if (stopped) {
      // on_hold is recoverable from the production page (force-forward);
      // failed/rejected/halted are hard stops — both read as "not moving".
      return { ...s, state: "halted", sub: p.failureReason ?? "Stopped — open for details" };
    }
    if (waitingOnYou) return { ...s, state: "waiting", sub: "Waiting on your review" };
    return { ...s, state: "active", sub: activeSub(s.key, p) };
  });
}

function doneSub(key: string, p: StepperInput): string | undefined {
  switch (key) {
    case "script":
      return p.draftCount ? `${p.draftCount} draft${p.draftCount === 1 ? "" : "s"}` : undefined;
    case "visuals":
      return p.imageCount ? `${p.imageCount} image${p.imageCount === 1 ? "" : "s"}` : undefined;
    case "final":
      return "Approved";
    case "publish":
      return p.publishedAt ? `Live ${fmtDateTime(p.publishedAt)}` : undefined;
    default:
      return undefined;
  }
}

function activeSub(key: string, p: StepperInput): string | undefined {
  if (key === "publish") {
    if (p.status === "scheduled" && p.scheduledFor) return `Scheduled ${fmtDateTime(p.scheduledFor)}`;
    return "Scheduling";
  }
  return "In progress";
}

export function ProductionStepper({ steps }: { steps: Step[] }) {
  return (
    <div className="stepper" role="list" aria-label="Production pipeline progress">
      {steps.map((s, i) => (
        <div key={s.key} className={`step ${s.state}`} role="listitem">
          <div className="snode">
            <span className="sdot" aria-hidden>
              {s.state === "done" ? (
                <IconCheck />
              ) : s.state === "halted" ? (
                <IconAlertTriangle />
              ) : s.state === "active" ? (
                <span className="spinner" />
              ) : (
                <span className="d" />
              )}
            </span>
            {i < steps.length - 1 && <span className="sbar" />}
          </div>
          <div className="slabel">{s.label}</div>
          {s.sub && <div className="ssub">{s.sub}</div>}
        </div>
      ))}
    </div>
  );
}
