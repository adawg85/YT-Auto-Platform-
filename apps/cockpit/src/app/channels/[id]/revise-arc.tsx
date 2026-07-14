"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@/components/ui/dialog";
import { IconSparkle } from "@/components/icons";
import { reviseSeriesAction } from "../editorial-actions";

/**
 * "Suggest changes" on a PROPOSED arc (2026-07-14 operator ask): free-text
 * tweaks — drop/add/reorder episodes, retitle, tighten the arc — applied by
 * the reviser agent BEFORE the operator approves. Sits next to Approve/Reject
 * on the Plan tab; the arc stays proposed after a revision so the operator
 * reviews the result and approves (or revises again).
 */
export function ReviseArc({ seriesId, title }: { seriesId: string; title: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const close = () => {
    if (pending) return;
    setOpen(false);
    setNote("");
    setError(null);
    setDone(null);
  };

  const run = () =>
    startTransition(async () => {
      setError(null);
      const res = await reviseSeriesAction(seriesId, note);
      if (res.error) {
        setError(res.error);
        return;
      }
      setDone(
        `Arc revised — now "${res.title}" (${res.episodeCount} episodes). Review it below, then approve.`,
      );
      setNote("");
      router.refresh();
    });

  return (
    <>
      <button type="button" className="btn sm ghost" onClick={() => setOpen(true)}>
        Suggest changes
      </button>
      <Dialog open={open} onClose={close} title={`Suggest changes — ${title}`}>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          Tell the planner what to tweak — it revises this proposed arc (title, description, episode
          list) and keeps everything you didn&apos;t mention. The arc stays proposed until you approve
          it.
        </p>
        <label className="field-label" htmlFor={`arc-note-${seriesId}`}>
          Changes to make
        </label>
        <textarea
          id={`arc-note-${seriesId}`}
          rows={3}
          placeholder='e.g. "Drop episode 4, add one about the Comet disasters, and tighten the arc to 8 episodes."'
          value={note}
          onChange={(ev) => setNote(ev.target.value)}
          disabled={pending}
        />
        <div className="actions" style={{ marginTop: 12 }}>
          {!done && (
            <button type="button" className="btn" disabled={pending || !note.trim()} onClick={run}>
              <IconSparkle /> Revise arc
            </button>
          )}
          <button type="button" className="btn ghost" disabled={pending} onClick={close}>
            {done ? "Close" : "Cancel"}
          </button>
          {pending && (
            <span className="muted" style={{ fontSize: 12.5 }}>
              Revising the arc…
            </span>
          )}
        </div>
        {done && <p style={{ margin: "10px 0 0", fontSize: 13 }}>{done}</p>}
        {error && <div className="err">{error}</div>}
      </Dialog>
    </>
  );
}
