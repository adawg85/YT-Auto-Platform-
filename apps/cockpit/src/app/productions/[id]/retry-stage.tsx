"use client";

import { useState, useTransition } from "react";
import { retryFromStageAction, type RetryStage } from "../../actions";
import { IconRefresh } from "@/components/icons";

/**
 * Per-step retry (BACKLOG #25): "Retry from here" buttons for a failed/on-hold
 * production. Each wipes that stage's artifacts (DB rows only) and re-fires the
 * pipeline with a fresh attempt nonce — upstream artifacts are reused via the
 * pipeline's skip-if-present short-circuits, so the run effectively resumes
 * from the chosen stage instead of restarting from scratch.
 */

// #78: the cost consequence sits IN the hint — "Retry from visuals" beside
// "Retry from render" silently re-billed 178 images when the wrong one was
// picked; the free retries now say they're free and the billable one says
// it re-bills every image.
const STAGES: { key: RetryStage; label: string; hint: string }[] = [
  { key: "script", label: "Retry from script", hint: "Redrafts the script; REGENERATES AND RE-BILLS all media (voiceover, every image, clips, render)." },
  { key: "visuals", label: "Retry from visuals", hint: "Keeps script + voiceover; REGENERATES AND RE-BILLS every image (and clips), then re-renders. Existing images are discarded." },
  { key: "render", label: "Retry from render", hint: "Keeps everything; re-renders the video. No image/voice re-billing." },
  { key: "publish", label: "Retry publish", hint: "Keeps everything; re-runs the upload and publish steps. No re-billing." },
];

export function RetryStagePanel({ productionId }: { productionId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fired, setFired] = useState<RetryStage | null>(null);

  const run = (stage: RetryStage) =>
    startTransition(async () => {
      setError(null);
      const res = await retryFromStageAction(productionId, stage);
      if (res.error) setError(res.error);
      else setFired(stage);
    });

  return (
    <div className="callout" style={{ marginTop: 0 }}>
      <IconRefresh />
      <div>
        <strong>Retry from a stage</strong>
        <p className="muted" style={{ margin: "4px 0 10px", fontSize: 12.5 }}>
          Re-runs the pipeline from the chosen stage on this production. Earlier stages reuse
          what they already produced; the chosen stage (and everything after it) regenerates.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {STAGES.map((s) => (
            <button
              key={s.key}
              type="button"
              className="btn ghost"
              disabled={pending || fired !== null}
              title={s.hint}
              onClick={() => run(s.key)}
            >
              <IconRefresh /> {s.label}
            </button>
          ))}
        </div>
        {pending && (
          <p className="muted" style={{ margin: "8px 0 0", fontSize: 12.5 }}>Restarting…</p>
        )}
        {fired && !pending && (
          <p className="muted" style={{ margin: "8px 0 0", fontSize: 12.5 }}>
            Pipeline re-fired from {fired === "publish" ? "publish" : `the ${fired} stage`} — progress
            appears on the stepper above.
          </p>
        )}
        {error && <div className="err">{error}</div>}
      </div>
    </div>
  );
}
