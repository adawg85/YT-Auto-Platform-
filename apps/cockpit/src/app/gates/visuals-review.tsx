"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { decideGateAction } from "../actions";
import { IconCheck, IconChevronRight, IconRefresh, IconX } from "@/components/icons";

type Shot = { idx: number; narration: string; imageUrl: string; animated: boolean };

/**
 * Remediation §5.3: review a whole visual set on the queue — all shots + their
 * narration on one screen, approvable in ONE action, with keyboard shortcuts
 * (a = approve, r = revise, x = reject) so a sitting of twenty is minutes, not an
 * evening. Per-shot fixes still happen on the production page (the exception).
 */
export function VisualsReviewCard({
  gateId,
  productionId,
  title,
  channelName,
  shots,
}: {
  gateId: string;
  productionId: string;
  title: string;
  channelName: string;
  shots: Shot[];
}) {
  const [notes, setNotes] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const decide = (decision: "approved" | "rejected" | "revise") => {
    if (decision === "revise" && !notes.trim()) {
      setError("Add a note telling the pipeline what to change, then open the production to fix it.");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await decideGateAction(gateId, decision, notes);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key.toLowerCase() === "a") decide("approved");
    else if (e.key.toLowerCase() === "r") decide("revise");
    else if (e.key.toLowerCase() === "x") decide("rejected");
  };

  return (
    <div className="card" tabIndex={0} onKeyDown={onKeyDown} style={{ outline: "none" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "baseline" }}>
        <div>
          <Link href={`/productions/${productionId}`} style={{ fontWeight: 650 }}>
            {title}
          </Link>
          <span className="muted" style={{ fontSize: 12.5, marginLeft: 8 }}>{channelName}</span>
          <span className="muted" style={{ fontSize: 12.5, marginLeft: 8 }}>{shots.length} shots</span>
        </div>
        <Link className="btn ghost sm" href={`/productions/${productionId}`}>
          Fix a shot <IconChevronRight />
        </Link>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
          gap: 8,
          margin: "12px 0",
          maxHeight: 320,
          overflowY: "auto",
        }}
      >
        {shots.map((s) => (
          <figure key={s.idx} style={{ margin: 0 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={s.imageUrl}
              alt={`shot ${s.idx + 1}`}
              style={{ width: "100%", aspectRatio: "16/9", objectFit: "cover", borderRadius: 6, display: "block" }}
            />
            <figcaption className="muted" style={{ fontSize: 11, marginTop: 3, lineHeight: 1.3 }}>
              {s.idx + 1}. {s.animated ? "🎬 " : ""}
              {s.narration.slice(0, 90)}
            </figcaption>
          </figure>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
        <input
          type="text"
          placeholder="Notes — required to request a revision"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          style={{ flex: "1 1 200px", minWidth: 160 }}
        />
        <button disabled={pending} className="btn success sm" onClick={() => decide("approved")} title="a">
          <IconCheck /> Approve <kbd style={{ opacity: 0.6, fontSize: 10 }}>a</kbd>
        </button>
        <button disabled={pending} className="btn ghost sm" onClick={() => decide("revise")} title="r">
          <IconRefresh /> Revise <kbd style={{ opacity: 0.6, fontSize: 10 }}>r</kbd>
        </button>
        <button disabled={pending} className="btn ghost sm danger-ink" onClick={() => decide("rejected")} title="x">
          <IconX /> Reject <kbd style={{ opacity: 0.6, fontSize: 10 }}>x</kbd>
        </button>
      </div>
      {pending && <span className="muted" style={{ fontSize: 12 }}>Working…</span>}
      {error && <span className="err">{error}</span>}
    </div>
  );
}
