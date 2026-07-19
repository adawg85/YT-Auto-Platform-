"use client";

import { useState, useTransition } from "react";
import { correctPublishedProductionAction } from "../../actions";
import { IconRefresh } from "@/components/icons";

/**
 * "Make a corrected copy" of a published/scheduled video (2026-07-19 operator).
 * A published production is intentionally locked and YouTube can't replace a
 * live video's file, so a fix ships as a NEW upload: this mints a fresh,
 * editable production from the same script + copies of every shot/clip. The
 * optional checkbox opts into auto-deleting the old live video once the
 * corrected copy goes live (default OFF — the operator can remove it manually).
 */
export function CorrectedCopyPanel({ productionId }: { productionId: string }) {
  const [deleteOld, setDeleteOld] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = () =>
    startTransition(async () => {
      setError(null);
      try {
        // redirects to the new production on success
        await correctPublishedProductionAction(productionId, deleteOld);
      } catch (e) {
        // Next throws a redirect "error" on success — never surface that
        if (e && typeof e === "object" && "digest" in e && String((e as { digest?: string }).digest).startsWith("NEXT_REDIRECT")) {
          throw e;
        }
        setError(e instanceof Error ? e.message : "Couldn't make a corrected copy.");
      }
    });

  return (
    <div className="callout" style={{ marginTop: 0 }}>
      <IconRefresh />
      <div>
        <strong>Make a corrected copy</strong>
        <p className="muted" style={{ margin: "4px 0 8px", fontSize: 12.5 }}>
          This video is already published, and YouTube can&apos;t swap the file on a live video. This
          makes a fresh, editable copy (same script, every shot &amp; clip) — re-animate or swap what&apos;s
          wrong, then publish it as a <strong>new</strong> video.
        </p>
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", margin: "0 0 10px", fontSize: 12.5 }}>
          <input
            type="checkbox"
            checked={deleteOld}
            onChange={(e) => setDeleteOld(e.target.checked)}
            style={{ marginTop: 2 }}
          />
          <span>
            Also delete the old video from YouTube once the corrected copy goes live.
            <span className="muted"> Off by default — leave unchecked to keep the original up and remove it yourself.</span>
          </span>
        </label>
        <button type="button" className="btn" disabled={pending} onClick={run}>
          <IconRefresh /> {pending ? "Creating copy…" : "Make a corrected copy"}
        </button>
        {error && <div className="err">{error}</div>}
      </div>
    </div>
  );
}
