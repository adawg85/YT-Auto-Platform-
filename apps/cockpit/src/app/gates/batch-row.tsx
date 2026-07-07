"use client";

import { useState, useTransition } from "react";
import { decideGateAction } from "../actions";
import { IconCheck, IconRefresh, IconX } from "@/components/icons";

/**
 * Batch review (spec §5.6): decide script gates inline from the queue —
 * this is how operator judgment scales across many channels.
 */
export function BatchDecide({ gateId }: { gateId: string }) {
  const [notes, setNotes] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const decide = (decision: "approved" | "rejected" | "revise") => {
    if (decision === "revise" && !notes.trim()) {
      setError("Add a note telling the writer what to change.");
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end", flex: "1 1 260px", maxWidth: 400 }}>
      <input
        type="text"
        placeholder="Notes — required to request a revision"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        style={{ width: "100%" }}
      />
      <div style={{ display: "flex", gap: 6 }}>
        <button disabled={pending} className="btn success sm" onClick={() => decide("approved")}>
          <IconCheck /> Approve
        </button>
        <button disabled={pending} className="btn ghost sm" onClick={() => decide("revise")}>
          <IconRefresh /> Revise
        </button>
        <button disabled={pending} className="btn ghost sm danger-ink" onClick={() => decide("rejected")}>
          <IconX /> Reject
        </button>
      </div>
      {pending && <span className="muted" style={{ fontSize: 12 }}>Working…</span>}
      {error && <span className="err">{error}</span>}
    </div>
  );
}
