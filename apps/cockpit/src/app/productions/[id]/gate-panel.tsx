"use client";

import { useState, useTransition } from "react";
import { decideGateAction } from "../../actions";
import { ZoomButton } from "@/components/ui";
import { tzAbbr, zonedInputToIso } from "@/lib/format";
import { IconCheck, IconFileText, IconFilm, IconRefresh, IconX } from "@/components/icons";

/**
 * The operator's decision panel — Approve / Request revision (with notes) /
 * Reject. Notes are recorded in the review gate (compliance evidence log)
 * and, for revisions, fed back to the scriptwriter.
 */
export type ThumbnailCandidate = { id: string; storageKey: string; predictedCtr: number | null };

/** the per-video profile axes editable at a profile_review gate */
const PROFILE_AXES: { key: string; label: string; values: string[] }[] = [
  { key: "visualMode", label: "Visual style", values: ["simple", "real_footage", "ai_images", "ai_video", "mixed"] },
  { key: "motion", label: "Motion", values: ["static", "partial", "ai_video"] },
  { key: "rhythm", label: "Rhythm", values: ["sentence", "section", "pause"] },
  { key: "captions", label: "Captions", values: ["on", "off"] },
  { key: "music", label: "Music", values: ["off", "subtle", "standard"] },
  { key: "delivery", label: "Delivery", values: ["measured", "warm", "energetic", "dramatic"] },
  { key: "archivalStrength", label: "Real imagery push", values: ["off", "light", "balanced", "strong", "max"] },
];

type ProfileLike = Record<string, unknown>;
const axisValue = (p: ProfileLike | undefined, key: string): string => {
  const v = p?.[key];
  if (key === "captions") return v === false || v === "off" ? "off" : "on";
  return typeof v === "string" ? v : "";
};

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
  const isProfile = kind === "profile_review";

  // profile_review: start from the AI proposal; every axis stays editable
  const proposed = (snapshot.proposed ?? {}) as ProfileLike;
  const channelDefaults = (snapshot.channelProfile ?? {}) as ProfileLike;
  const tweaks = (snapshot.tweaks ?? null) as {
    accept?: boolean;
    rationale?: string;
    changes?: { axis: string; to: string; why: string }[];
  } | null;
  const [profileEdit, setProfileEdit] = useState<Record<string, string>>(() =>
    Object.fromEntries(PROFILE_AXES.map((a) => [a.key, axisValue(proposed, a.key)])),
  );

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
          // the input is Melbourne wall time — convert to UTC here; letting the
          // server parse the naive string would interpret it in SERVER time
          scheduledFor ? zonedInputToIso(scheduledFor) : undefined,
          decision === "approved" && selectedThumb ? selectedThumb : undefined,
          isProfile && decision === "approved"
            ? { ...profileEdit, captions: profileEdit.captions !== "off" }
            : undefined,
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
        {isScript ? "Script review" : isProfile ? "Production profile" : "Final review"} · your decision
      </div>
      <div className="decision-body">
        {isProfile && (
          <div style={{ marginBottom: 14 }}>
            <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
              How THIS video gets produced — the AI read the approved script and{" "}
              {tweaks?.accept === false && tweaks?.changes?.length
                ? "proposed the tweaks below"
                : "accepted the channel defaults"}
              . Adjust any axis, then approve. Reject keeps the channel defaults.
            </p>
            {tweaks?.rationale && (
              <p className="muted" style={{ margin: "0 0 10px", fontSize: 12.5, fontStyle: "italic" }}>
                {tweaks.rationale}
              </p>
            )}
            {(tweaks?.changes ?? []).map((c, i) => (
              <div key={i} className="chip" style={{ marginRight: 6, marginBottom: 6 }}>
                {c.axis}: {axisValue(channelDefaults, c.axis)} → {c.to} · {c.why}
              </div>
            ))}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(190px,1fr))", gap: 10, marginTop: 10 }}>
              {PROFILE_AXES.map((a) => {
                const differs = profileEdit[a.key] !== axisValue(channelDefaults, a.key);
                return (
                  <div key={a.key}>
                    <label className="field-label" htmlFor={`pa-${a.key}`}>
                      {a.label}
                      {differs && (
                        <span className="muted" style={{ fontWeight: 500 }}> — channel: {axisValue(channelDefaults, a.key)}</span>
                      )}
                    </label>
                    <select
                      id={`pa-${a.key}`}
                      value={profileEdit[a.key]}
                      onChange={(e) => setProfileEdit((p) => ({ ...p, [a.key]: e.target.value }))}
                    >
                      {a.values.map((v) => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {isScript && typeof snapshot.fullText === "string" && (
          <p className="muted" style={{ margin: "0 0 12px", fontSize: 13 }}>
            Read the script below, then approve it, send it back with notes, or reject it.
          </p>
        )}
        {isScript && !!snapshot.factualityProof && (
          <div style={{ marginBottom: 12 }}>
            <span className="chip good">
              <IconCheck /> Factuality proof passed — every claim checked against the verified facts
            </span>
          </div>
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
                  {/* radio FIRST: a label activates its first interactive
                      element — with the zoom button first, image clicks opened
                      the lightbox instead of selecting (operator-reported) */}
                  <input
                    type="radio"
                    name="thumb"
                    checked={selectedThumb === t.id}
                    onChange={() => setSelectedThumb(t.id)}
                  />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/media/${t.storageKey}`} alt="Thumbnail candidate" />
                  <ZoomButton src={`/api/media/${t.storageKey}`} alt="Thumbnail candidate" />
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
              Schedule{" "}
              <span className="muted" style={{ fontWeight: 500 }}>
                — Melbourne time ({tzAbbr()}); leave empty to publish on approval
              </span>
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
            <IconX /> {isProfile ? "Keep channel defaults" : "Reject"}
          </button>
          {pending && <span className="muted" style={{ fontSize: 12.5 }}>Working…</span>}
        </div>
        {error && <div className="err">{error}</div>}
      </div>
    </div>
  );
}
