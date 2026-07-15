"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { retryFromStageAction } from "../../actions";
import { IconRefresh } from "@/components/icons";

/**
 * "Regenerate all beat visuals" (2026-07-15 operator ask): the visuals-review
 * gate lets you swap ONE image at a time, but after activating a style guide
 * or a character there was no way to rebuild the whole set — halt+resume
 * silently reused the old images. This deletes every beat image + the render
 * (retryFromStageAction "visuals") and re-runs generation from the current
 * script, active style guide and characters. Per-image swaps stay for
 * targeted fixes.
 */
export function RegenerateVisuals({ productionId }: { productionId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fired, setFired] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const run = () =>
    startTransition(async () => {
      setError(null);
      const res = await retryFromStageAction(productionId, "visuals");
      if (res.error) {
        setError(res.error);
        return;
      }
      setFired(true);
      router.refresh();
    });

  if (fired) {
    return (
      <p className="muted" style={{ margin: "0 0 12px", fontSize: 12.5 }}>
        Regenerating every beat image from the current script, style guide and characters —
        progress shows on the stepper above.
      </p>
    );
  }

  return (
    <div style={{ margin: "0 0 12px", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      {confirming ? (
        <>
          <span style={{ fontSize: 12.5 }}>
            Replace <strong>every</strong> beat image? Keeps the script + voiceover.
          </span>
          <button type="button" className="btn sm" disabled={pending} onClick={run}>
            {pending ? "Restarting…" : "Yes, regenerate all"}
          </button>
          <button type="button" className="btn ghost sm" disabled={pending} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </>
      ) : (
        <>
          <button type="button" className="btn ghost sm" onClick={() => setConfirming(true)}>
            <IconRefresh /> Regenerate all beat visuals
          </button>
          <span className="muted" style={{ fontSize: 12 }}>
            — rebuilds every image from the current style guide + characters (use after
            activating a style or adding a character)
          </span>
        </>
      )}
      {error && <div className="err">{error}</div>}
    </div>
  );
}
