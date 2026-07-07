"use client";

import { useState, useTransition } from "react";
import { decideGateAction } from "../../actions";
import { IconCheck, IconFileText, IconFilm, IconRefresh, IconX } from "@/components/icons";

/**
 * The operator's decision panel — Approve / Request revision (with notes) /
 * Reject. Notes are recorded in the review gate (compliance evidence log)
 * and, for revisions, fed back to the scriptwriter.
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
  const [selectedThumb, setSelectedThumb] = useState<string>(thumbnailCandidates[0]?.id ?? "");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const isScript = kind === "script_review";

  const decide = (decision: "approved" | "rejected" | "revise") => {
    if (decision === "revise" && !notes.trim()) {
      setError("Add a note telling the writer what to change, then request the revision.");
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
    <div className="decision">
      <div className="decision-head">
        {isScript ? <IconFileText /> : <IconFilm />}
        {isScript ? "Script review" : "Final review"} · your decision
      </div>
      <div className="decision-body">
        {isScript && typeof snapshot.fullText === "string" && (
          <p className="muted" style={{ margin: "0 0 12px", fontSize: 13 }}>
            Read the script below, then approve it, send it back with notes, or reject it.
          </p>
        )}

        <label className="field-label" htmlFor="gate-notes">
          Notes <span className="muted" style={{ fontWeight: 500 }}>— required for a revision, kept in the review log</span>
        </label>
        <textarea
          id="gate-notes"
          rows={2}
          placeholder={isScript ? "e.g. Tighten the second beat — lead with the number." : "Anything worth recording about this cut."}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        {!isScript && thumbnailCandidates.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <span className="field-label">Thumbnail — pick the one to publish</span>
            <div className="tpick">
              {thumbnailCandidates.map((t) => (
                <label key={t.id} className={selectedThumb === t.id ? "on" : ""}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/media/${t.storageKey}`} alt="Thumbnail candidate" />
                  <input
                    type="radio"
                    name="thumb"
                    checked={selectedThumb === t.id}
                    onChange={() => setSelectedThumb(t.id)}
                  />
                  <span className="ctr">
                    {t.predictedCtr !== null ? `Predicted CTR ${t.predictedCtr}%` : "Not scored"}
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}

        {!isScript && (
          <div style={{ marginTop: 14, maxWidth: 320 }}>
            <label className="field-label" htmlFor="gate-schedule">
              Schedule <span className="muted" style={{ fontWeight: 500 }}>— optional, leave empty to publish on approval</span>
            </label>
            <input
              id="gate-schedule"
              type="datetime-local"
              value={scheduledFor}
              onChange={(e) => setScheduledFor(e.target.value)}
            />
          </div>
        )}

        <div className="actions">
          <button disabled={pending} className="btn success" onClick={() => decide("approved")}>
            <IconCheck /> Approve
          </button>
          {isScript && (
            <button disabled={pending} className="btn ghost" onClick={() => decide("revise")}>
              <IconRefresh /> Request revision
            </button>
          )}
          <button disabled={pending} className="btn ghost danger-ink" onClick={() => decide("rejected")}>
            <IconX /> Reject
          </button>
          {pending && <span className="muted" style={{ fontSize: 12.5 }}>Working…</span>}
        </div>
        {error && <div className="err">{error}</div>}
      </div>
    </div>
  );
}
