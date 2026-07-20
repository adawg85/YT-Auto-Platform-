"use client";

import { useState, useTransition } from "react";
import { retryFromStageAction } from "../../actions";
import { IconAlertTriangle, IconRefresh } from "@/components/icons";

/**
 * Flags when the current render doesn't include changes made since (animated
 * clips, a selected music track) and offers a one-click re-render. The render
 * stamps what it baked in (meta.clipIdxs / meta.musicKey); the page diffs that
 * against the live clips + selected music (2026-07-17 operator: a render went
 * out without the animated shots / music and there was no signal).
 */
export function StaleRenderBanner({
  productionId,
  missingClips,
  removedClips = 0,
  missingMusic,
}: {
  productionId: string;
  missingClips: number;
  /** clips baked into the render that are no longer live (operator removed them
   * with "Use the still instead") — the render still shows the old clip */
  removedClips?: number;
  missingMusic: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [fired, setFired] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = () =>
    startTransition(async () => {
      setError(null);
      const res = await retryFromStageAction(productionId, "render");
      if (res.error) setError(res.error);
      else setFired(true);
    });

  const bits = [
    missingClips > 0 ? `${missingClips} animated clip${missingClips === 1 ? "" : "s"}` : null,
    removedClips > 0
      ? `${removedClips} clip${removedClips === 1 ? "" : "s"} you removed (still baked in — re-render to use the stills)`
      : null,
    missingMusic ? "your selected music" : null,
  ].filter(Boolean);
  const what =
    bits.length === 3
      ? `${bits[0]}, ${bits[1]} and ${bits[2]}`
      : bits.length === 2
        ? `${bits[0]} and ${bits[1]}`
        : bits[0];

  return (
    <div className="callout warn" style={{ margin: "0 0 12px" }}>
      <IconAlertTriangle />
      <div>
        <strong>This render is out of date — it doesn&apos;t match {what}.</strong>
        <p className="muted" style={{ margin: "4px 0 8px", fontSize: 12.5 }}>
          {missingClips > 0
            ? "The clips likely finished animating after the render started. "
            : ""}
          Re-render to rebuild the final video with your current shots (~2&nbsp;min) — nothing else changes.
        </p>
        {fired ? (
          <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
            Re-render fired — progress appears on the stepper above.
          </p>
        ) : (
          <button type="button" className="btn" disabled={pending} onClick={run}>
            <IconRefresh /> {pending ? "Re-rendering…" : "Retry from render"}
          </button>
        )}
        {error && <div className="err">{error}</div>}
      </div>
    </div>
  );
}
