"use client";

import { useState, useTransition } from "react";
import { decideGateAction } from "../actions";

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
      setError("Revise needs notes");
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
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <input
        type="text"
        placeholder="notes (evidence log)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        style={{ width: 180 }}
      />
      <button disabled={pending} onClick={() => decide("approved")}>
        ✓
      </button>
      <button disabled={pending} className="warn" onClick={() => decide("revise")}>
        ↻
      </button>
      <button disabled={pending} className="danger" onClick={() => decide("rejected")}>
        ✕
      </button>
      {error && <span style={{ color: "var(--red)" }}>{error}</span>}
    </div>
  );
}
