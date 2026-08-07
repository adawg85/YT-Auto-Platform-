"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
// TYPE-ONLY: @ytauto/core's barrel re-exports `inngest`, which pulls
// node:async_hooks and cannot be bundled for the browser. Types erase; the
// stage list is rebuilt locally below.
import type { ProductionStage, ReopenMode, ReopenImpact } from "@ytauto/core";
import { Dialog } from "@/components/ui";
import { continueProductionAction, reopenStageAction, cancelReopenAction } from "../../actions";
import { IconRefresh, IconZap, IconAlertTriangle } from "@/components/icons";

/**
 * CONTINUE / REOPEN / CANCEL REOPEN — the in-place recovery verbs.
 *
 * The stage re-entry engine shipped MCP-only, so the cockpit's halted
 * production offered exactly two buttons: "Resume — reuse script" (legacy;
 * mints a SIBLING production row) and "Force forward" (skips the review gates
 * and publishes). Neither is the everyday answer, and the operator hit the trap
 * this was built to prevent: on a production carrying 122 hand-recorded
 * voiceover takes, the only visible "carry on" button was the one that starts a
 * NEW production — where per-production takes do not follow.
 *
 * Continue leads because it is the safe default: same row, nothing deleted,
 * nothing re-billed. Reopen is the deliberate step back, and it previews its
 * impact (server-computed, the same `reopenImpact` the MCP tool returns) before
 * anything changes — so the two surfaces can never describe the same
 * destructive action differently.
 */

/** Every stage, with what reopening it costs. Typed as a total Record over
 *  ProductionStage, so adding a stage in core fails the build here until it has
 *  a hint — the list below is derived from it rather than duplicated. */
const STAGE_HINT: Record<ProductionStage, string> = {
  script: "Redraft the narration. Invalidates the voiceover and everything after it.",
  voiceover: "Re-assemble or re-record the narration. Also re-cuts the visuals — shot timings come from the voiceover.",
  visuals: "Go back to the shots. Keeps the script, voiceover and music.",
  music: "Pick a different bed. Keeps the script, voiceover and shots.",
  render: "Re-render the video from the existing assets.",
  thumbnail: "Redo the thumbnail only.",
  publish: "Go back to the upload/publish step.",
};

/** Pipeline order, mirroring core's PRODUCTION_STAGES (which can't be imported
 *  here — see the type-only import above). */
const STAGES = Object.keys(STAGE_HINT) as ProductionStage[];

export function RecoveryPanel({
  productionId,
  status,
  reopenedStage = null,
}: {
  productionId: string;
  status: string;
  /** set when a reopen is in flight — downstream work is stale but NOT yet deleted */
  reopenedStage?: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<ProductionStage>("voiceover");
  const [mode, setMode] = useState<ReopenMode>("reopen");
  const [preview, setPreview] = useState<ReopenImpact | null>(null);

  const canContinue = ["halted", "on_hold", "failed"].includes(status);

  const doContinue = () =>
    startTransition(async () => {
      setError(null);
      const res = await continueProductionAction(productionId);
      if (res.error) setError(res.error);
      else router.refresh();
    });

  // preview FIRST — nothing changes until the operator confirms the impact
  const openPreview = () =>
    startTransition(async () => {
      setError(null);
      const res = await reopenStageAction(productionId, stage, { mode, confirm: false });
      if (res.error) setError(res.error);
      else if (res.impact) setPreview(res.impact);
    });

  const confirmReopen = () =>
    startTransition(async () => {
      setError(null);
      const res = await reopenStageAction(productionId, stage, { mode, confirm: true });
      if (res.error) setError(res.error);
      else {
        setPreview(null);
        router.refresh();
      }
    });

  const doCancelReopen = () =>
    startTransition(async () => {
      setError(null);
      const res = await cancelReopenAction(productionId);
      if (res.error) setError(res.error);
      else router.refresh();
    });

  return (
    <>
      {reopenedStage && (
        <div className="callout warn" style={{ marginTop: 0 }}>
          <IconAlertTriangle />
          <div>
            <strong>Reopened at {reopenedStage} — not yet committed</strong>
            <p className="muted" style={{ margin: "4px 0 10px", fontSize: 12.5 }}>
              Everything downstream of {reopenedStage} is marked stale but is still on disk. It is
              destroyed only when {reopenedStage} actually produces new output, so this is still
              reversible.
            </p>
            <button type="button" className="btn ghost" disabled={pending} onClick={doCancelReopen}>
              {pending ? "Cancelling…" : "Cancel reopen — restore untouched"}
            </button>
          </div>
        </div>
      )}

      {canContinue && (
        <div className="callout" style={{ marginTop: 0 }}>
          <IconZap />
          <div>
            <strong>Continue — pick up where it stopped</strong>
            <p className="muted" style={{ margin: "4px 0 10px", fontSize: 12.5 }}>
              Resumes <strong>this</strong> production, in place. Nothing is deleted, nothing is
              re-billed, and no new production row is created — everything already built (including
              any voiceover takes you recorded) stays attached. This is the normal way back in from
              a Hold; the review gates still apply.
            </p>
            <button type="button" className="btn" disabled={pending} onClick={doContinue}>
              <IconZap /> {pending ? "Continuing…" : "Continue this production"}
            </button>
          </div>
        </div>
      )}

      <div className="callout" style={{ marginTop: 0 }}>
        <IconRefresh />
        <div>
          <strong>Reopen a stage</strong>
          <p className="muted" style={{ margin: "4px 0 10px", fontSize: 12.5 }}>
            Go back to one stage on <strong>this</strong> production. You&apos;ll see exactly what is
            discarded and what is kept before anything changes, and it stays reversible until the
            reopened stage produces new output.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <select
              value={stage}
              disabled={pending}
              onChange={(e) => setStage(e.target.value as ProductionStage)}
              aria-label="Stage to reopen"
            >
              {STAGES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select
              value={mode}
              disabled={pending}
              onChange={(e) => setMode(e.target.value as ReopenMode)}
              aria-label="Reopen mode"
            >
              <option value="reopen">Reopen — keep this stage&apos;s output, refine it</option>
              <option value="clean">Clean — rebuild this stage from scratch</option>
            </select>
            <button type="button" className="btn ghost" disabled={pending} onClick={openPreview}>
              <IconRefresh /> {pending ? "Checking…" : "Preview impact"}
            </button>
          </div>
          <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
            {STAGE_HINT[stage]}
          </p>
        </div>
      </div>

      {error && <div className="err">{error}</div>}

      <Dialog
        open={preview !== null}
        onClose={() => !pending && setPreview(null)}
        title={`Reopen ${preview?.stage ?? ""}`}
        footer={
          <>
            <button type="button" className="btn ghost" disabled={pending} onClick={() => setPreview(null)}>
              Cancel
            </button>
            <button
              type="button"
              className={preview?.discards.length ? "btn danger" : "btn"}
              disabled={pending}
              onClick={confirmReopen}
            >
              {pending ? "Reopening…" : `Reopen ${preview?.stage ?? ""}`}
            </button>
          </>
        }
      >
        {preview && (
          <>
            <div className={preview.discards.length ? "callout warn" : "callout"} style={{ marginBottom: 12 }}>
              <IconAlertTriangle />
              <span>{preview.warning}</span>
            </div>
            {preview.keeps.length > 0 && (
              <p style={{ margin: "0 0 12px", fontSize: 13 }}>
                <strong>Kept:</strong> {preview.keeps.join(", ")}.
              </p>
            )}
            <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
              {preview.deletesWhen}
            </p>
          </>
        )}
      </Dialog>
    </>
  );
}
