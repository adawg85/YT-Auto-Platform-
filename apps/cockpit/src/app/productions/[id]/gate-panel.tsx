"use client";

import { useState, useTransition } from "react";
import { decideGateAction } from "../../actions";
import { Button } from "@/components/ui";
import { IconCheck, IconFilm, IconRevise, IconScript, IconX } from "@/components/icons";

/**
 * The operator's decision panel — Approve / Revise (with notes) / Reject.
 * Notes are recorded in the review gate (compliance evidence log) and, for
 * revisions, fed back to the scriptwriter.
 */
export type ThumbnailCandidate = { id: string; storageKey: string; predictedCtr: number | null };

export function GatePanel({
  gateId,
  kind,
  snapshot,
  thumbnailCandidates = [],
}: {
  gateId: string;
  kind: string;
  snapshot: Record<string, unknown>;
  thumbnailCandidates?: ThumbnailCandidate[];
}) {
  const [notes, setNotes] = useState("");
  const [scheduledFor, setScheduledFor] = useState("");
  const [selectedThumb, setSelectedThumb] = useState<string>(
    thumbnailCandidates[0]?.id ?? "",
  );
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
        await decideGateAction(
          gateId,
          decision,
          notes,
          scheduledFor || undefined,
          decision === "approved" && selectedThumb ? selectedThumb : undefined,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  };

  return (
    <div className="card" style={{ borderColor: "var(--warn)" }}>
      <h2 style={{ marginTop: 0, display: "flex", alignItems: "center", gap: 8 }}>
        {kind === "script_review" ? (
          <IconScript className="ic" />
        ) : (
          <IconFilm className="ic" />
        )}
        {kind === "script_review" ? "Script review" : "Final review"} — decision required
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
      {kind !== "script_review" && thumbnailCandidates.length > 0 && (
        <div style={{ marginTop: "0.6rem" }}>
          <div className="muted" style={{ marginBottom: 4 }}>
            Pick a thumbnail (predicted CTR from the scorer):
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            {thumbnailCandidates.map((t) => (
              <label key={t.id} style={{ textAlign: "center", cursor: "pointer" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  className="thumb"
                  src={`/api/media/${t.storageKey}`}
                  alt="thumbnail candidate"
                  style={{
                    width: 120,
                    outline: selectedThumb === t.id ? "3px solid var(--accent)" : "none",
                  }}
                />
                <div>
                  <input
                    type="radio"
                    name="thumb"
                    checked={selectedThumb === t.id}
                    onChange={() => setSelectedThumb(t.id)}
                  />{" "}
                  {t.predictedCtr !== null ? `${t.predictedCtr}% CTR` : "unscored"}
                </div>
              </label>
            ))}
          </div>
        </div>
      )}
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
      <div style={{ marginTop: "0.7rem", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Button variant="good" disabled={pending} icon={<IconCheck className="ic" />} onClick={() => decide("approved")}>
          Approve
        </Button>
        {kind === "script_review" && (
          <Button variant="warn" disabled={pending} icon={<IconRevise className="ic" />} onClick={() => decide("revise")}>
            Revise
          </Button>
        )}
        <Button variant="danger" disabled={pending} icon={<IconX className="ic" />} onClick={() => decide("rejected")}>
          Reject
        </Button>
        {pending && <span className="muted">…submitting</span>}
      </div>
      {error && (
        <div style={{ color: "var(--crit)", marginTop: 8, fontSize: 13, fontWeight: 500 }}>{error}</div>
      )}
    </div>
  );
}
