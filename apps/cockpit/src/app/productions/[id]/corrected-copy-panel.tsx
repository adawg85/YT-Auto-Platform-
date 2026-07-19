"use client";

import { useState, useTransition } from "react";
import { correctPublishedProductionAction } from "../../actions";
import { IconRefresh } from "@/components/icons";

/**
 * "Fix or rebuild" a published/scheduled video (2026-07-19 operator asked to
 * choose the intent up front). YouTube can't replace a live video's file, so
 * either path ships as a NEW upload. Both keep the approved script and skip the
 * script gate; the choice is what happens to the visuals:
 *   • Fix a few things — reuse everything, land at the visuals gate to swap.
 *   • Rebuild the visuals — regenerate every still/clip fresh.
 * The optional checkbox removes the old live upload once the new one is out.
 */
export function CorrectedCopyPanel({ productionId }: { productionId: string }) {
  const [deleteOld, setDeleteOld] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = (mode: "fix" | "rebuild") =>
    startTransition(async () => {
      setError(null);
      try {
        await correctPublishedProductionAction(productionId, deleteOld, mode); // redirects on success
      } catch (e) {
        if (e && typeof e === "object" && "digest" in e && String((e as { digest?: string }).digest).startsWith("NEXT_REDIRECT")) {
          throw e;
        }
        setError(e instanceof Error ? e.message : "Couldn't start the copy.");
      }
    });

  return (
    <div className="callout" style={{ marginTop: 0 }}>
      <IconRefresh />
      <div>
        <strong>Edit this video &amp; re-upload</strong>
        <p className="muted" style={{ margin: "4px 0 10px", fontSize: 12.5 }}>
          This video is already published, and YouTube can&apos;t swap the file on a live video — so this
          makes a fresh copy that publishes as a <strong>new</strong> video. Pick what you want to do:
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <button type="button" className="btn" disabled={pending} onClick={() => run("fix")} style={{ flex: "none" }}>
              <IconRefresh /> {pending ? "Working…" : "Fix a few things"}
            </button>
            <span className="muted" style={{ fontSize: 12, paddingTop: 2 }}>
              Keeps everything (script, voiceover, all images &amp; clips) and drops you at the visuals
              gate to swap or re-animate the shots you want — then re-render and publish. Cheap and fast.
            </span>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <button type="button" className="btn ghost" disabled={pending} onClick={() => run("rebuild")} style={{ flex: "none" }}>
              <IconRefresh /> Rebuild the visuals
            </button>
            <span className="muted" style={{ fontSize: 12, paddingTop: 2 }}>
              Keeps the approved script but regenerates <strong>every</strong> still and clip from scratch —
              for when the whole look needs redoing. Costs more.
            </span>
          </div>
        </div>

        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", margin: "12px 0 0", fontSize: 12.5 }}>
          <input type="checkbox" checked={deleteOld} onChange={(e) => setDeleteOld(e.target.checked)} style={{ marginTop: 2 }} />
          <span>
            Also delete the old video from YouTube once the new one goes live.
            <span className="muted"> Off by default — leave unchecked to keep the original up.</span>
          </span>
        </label>
        {error && <div className="err">{error}</div>}
      </div>
    </div>
  );
}
