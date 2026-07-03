"use client";

import { useState, useTransition } from "react";
import { decideGateAction } from "../../actions";

/**
 * The operator's decision panel — Approve / Revise (with notes) / Reject.
 * Notes are recorded in the review gate (compliance evidence log) and, for
 * revisions, fed back to the scriptwriter.
 */
export function GatePanel({
  gateId,
  kind,
  snapshot,
}: {
  gateId: string;
  kind: string;
  snapshot: Record<string, unknown>;
}) {
  const [notes, setNotes] = useState("");
  const [scheduledFor, setScheduledFor] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const decide = (decision: "approved" | "rejected" | "revise") => {
    if (decision === "revise" && !notes.trim()) {
      setError("Revision requires notes — tell the writer what to change.");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await decideGateAction(gateId, decision, notes, scheduledFor || undefined);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  };

  return (
    <div className="card" style={{ borderColor: "var(--amber)" }}>
      <h2 style={{ marginTop: 0 }}>
        {kind === "script_review" ? "📝 Script review" : "🎬 Final review"} — decision required
      </h2>
      {kind === "script_review" && typeof snapshot.fullText === "string" && (
        <p className="muted">Review the script on the right, then decide.</p>
      )}
      <textarea
        rows={2}
        placeholder="Editorial notes (required for revise; logged as compliance evidence)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      {kind !== "script_review" && (
        <div style={{ marginTop: "0.5rem", maxWidth: 320 }}>
          <label>
            Publish no earlier than <span className="muted">(optional — leave empty for immediate)</span>
            <input
              type="datetime-local"
              value={scheduledFor}
              onChange={(e) => setScheduledFor(e.target.value)}
            />
          </label>
        </div>
      )}
      <div style={{ marginTop: "0.6rem" }}>
        <button disabled={pending} onClick={() => decide("approved")}>
          ✓ Approve
        </button>{" "}
        {kind === "script_review" && (
          <button disabled={pending} className="warn" onClick={() => decide("revise")}>
            ↻ Revise
          </button>
        )}{" "}
        <button disabled={pending} className="danger" onClick={() => decide("rejected")}>
          ✕ Reject
        </button>
        {pending && <span className="muted"> …submitting</span>}
        {error && <div style={{ color: "var(--red)", marginTop: 6 }}>{error}</div>}
      </div>
    </div>
  );
}
