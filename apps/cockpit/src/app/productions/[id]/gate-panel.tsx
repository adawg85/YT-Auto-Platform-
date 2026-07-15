"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { decideGateAction } from "../../actions";
import { ZoomButton } from "@/components/ui";
import { tzAbbr, zonedInputToIso } from "@/lib/format";
import { AXIS_OPTIONS, axisOptionLabel } from "@/lib/axis-options";
import { IconCheck, IconFileText, IconFilm, IconRefresh, IconX } from "@/components/icons";
import { ThumbnailStudio, ThumbnailTweak } from "./thumbnail-studio";

/**
 * The operator's decision panel — Approve / Request revision (with notes) /
 * Reject. Notes are recorded in the review gate (compliance evidence log)
 * and, for revisions, fed back to the scriptwriter.
 */
export type ThumbnailCandidate = { id: string; storageKey: string; predictedCtr: number | null };

/** the per-video profile axes editable at a profile_review gate — options and
 * their meanings come from the SHARED vocabulary (lib/axis-options), so this
 * popup can never drift from the Profile tab again (2026-07-14 operator ask) */
const PROFILE_AXES: { key: string; label: string }[] = [
  { key: "visualMode", label: "Visual style" },
  { key: "motion", label: "Motion" },
  { key: "rhythm", label: "Rhythm" },
  { key: "captions", label: "Captions" },
  { key: "music", label: "Music" },
  { key: "delivery", label: "Delivery" },
  { key: "archivalStrength", label: "Real imagery push" },
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
  productionId,
  renderStale = false,
  thumbReferences = [],
  thumbTitleAuto = "",
  thumbTitle = "",
  thumbIsLong = false,
  thumbStyleBlock = null,
  thumbImageStyle = null,
}: {
  gateId: string;
  kind: string;
  snapshot: Record<string, unknown>;
  thumbnailCandidates?: ThumbnailCandidate[];
  /** enables the thumbnail-regenerate controls at the final gate */
  productionId?: string;
  /** images were changed AFTER the render — approving would publish the old
   * cut, so Approve is blocked until a re-render (2026-07-12 incident) */
  renderStale?: boolean;
  /** thumbnail studio references (characters w/ description + style scenes) */
  thumbReferences?: { value: string; label: string; description?: string }[];
  /** auto-shortened title words (prefill for the title-text field) */
  thumbTitleAuto?: string;
  /** the video title (for the prompt composer's subject/auto-words) */
  thumbTitle?: string;
  thumbIsLong?: boolean;
  /** active distilled style block, else null */
  thumbStyleBlock?: string | null;
  /** wizard-era image style fallback */
  thumbImageStyle?: string | null;
}) {
  const router = useRouter();
  const [notes, setNotes] = useState("");
  const [scheduledFor, setScheduledFor] = useState("");
  const [selectedThumb, setSelectedThumb] = useState<string>(thumbnailCandidates[0]?.id ?? "");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const isScript = kind === "script_review";
  const isProfile = kind === "profile_review";
  const isVisuals = kind === "visuals_review";
  const isRecording = kind === "voiceover_recording";
  const isFinal = !isScript && !isProfile && !isVisuals && !isRecording;

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
          // thumbnail pick belongs to the FINAL gate only (2026-07-12 bug:
          // approving another gate kind silently sent the default candidate
          // and overwrote the operator's selection)
          isFinal && decision === "approved" && selectedThumb
            ? selectedThumb
            : undefined,
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
        {isScript ? "Script review" : isProfile ? "Production profile" : isVisuals ? "Visuals review" : isRecording ? "Voiceover recording" : "Final review"} · your decision
      </div>
      <div className="decision-body">
        {isVisuals && (
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            The image set is ready — nothing has rendered yet, so every change here is free.
            Review the Beat visuals below: swap for other real photos, regenerate on the standard
            or hero engine, run the duplicate auto-fix. When the set looks right, approve — the video renders ONCE
            from exactly these images. Reject puts the production on hold.
          </p>
        )}
        {isRecording && (
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            Record your takes in the <strong>Recording booth</strong> below — one beat at a time,
            re-take freely. Approve when you&apos;re done: beats you recorded use YOUR voice, any
            you skipped are TTS-filled in the channel voice. Reject switches this video back to
            full TTS (your saved takes are kept for voice-clone material either way).
          </p>
        )}
        {isFinal && renderStale && (
          <div className="callout warn" style={{ marginBottom: 14 }}>
            <span>
              <strong>The video below is out of date.</strong> You changed images after this
              render — approving now would publish the OLD cut without your swaps. Use{" "}
              <strong>Retry from render</strong> (panel above, ~2 min) to rebuild, then approve the
              fresh cut. Approve stays locked until then.
            </span>
          </div>
        )}
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
                {PROFILE_AXES.find((a) => a.key === c.axis)?.label ?? c.axis}:{" "}
                {axisOptionLabel(c.axis, axisValue(channelDefaults, c.axis))} →{" "}
                {axisOptionLabel(c.axis, c.to)} · {c.why}
              </div>
            ))}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 10, marginTop: 10 }}>
              {PROFILE_AXES.map((a) => {
                const options = AXIS_OPTIONS[a.key] ?? [];
                const differs = profileEdit[a.key] !== axisValue(channelDefaults, a.key);
                const aiWhy = tweaks?.changes?.find((c) => c.axis === a.key)?.why;
                const selected = options.find((o) => o.value === profileEdit[a.key]);
                return (
                  <div key={a.key}>
                    <label className="field-label" htmlFor={`pa-${a.key}`}>
                      {a.label}
                      {differs && (
                        <span className="muted" style={{ fontWeight: 500 }}>
                          {" "}— channel: {axisOptionLabel(a.key, axisValue(channelDefaults, a.key))}
                        </span>
                      )}
                    </label>
                    <select
                      id={`pa-${a.key}`}
                      value={profileEdit[a.key]}
                      onChange={(e) => setProfileEdit((p) => ({ ...p, [a.key]: e.target.value }))}
                    >
                      {options.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                    {/* explainer for the CURRENT selection (2026-07-14 operator ask) */}
                    {selected && (
                      <p className="muted" style={{ margin: "3px 0 0", fontSize: 11.5 }}>
                        {selected.hint}
                      </p>
                    )}
                    {aiWhy && (
                      <p className="muted" style={{ margin: "3px 0 0", fontSize: 11.5, fontStyle: "italic" }}>
                        AI: {aiWhy}
                      </p>
                    )}
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

        {isFinal && productionId && (
          <ThumbnailStudio
            productionId={productionId}
            references={thumbReferences}
            title={thumbTitle}
            titleAuto={thumbTitleAuto}
            isLong={thumbIsLong}
            styleBlock={thumbStyleBlock}
            imageStyle={thumbImageStyle}
          />
        )}

        {isFinal && thumbnailCandidates.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <span className="field-label">Thumbnail — pick the one to publish, or Tweak any candidate</span>
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
                  {/* Tweak in normal flow BELOW the card — the top-right corner
                      is reserved for the hover ZoomButton (image lightbox). */}
                  {productionId && (
                    <span style={{ display: "block", marginTop: 4 }}>
                      <ThumbnailTweak productionId={productionId} thumbnailId={t.id} references={thumbReferences} />
                    </span>
                  )}
                </label>
              ))}
            </div>
          </div>
        )}

        {isFinal && (
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
          <button
            disabled={pending || (isFinal && renderStale)}
            className="btn success"
            title={
              !isScript && !isProfile && renderStale
                ? "Blocked: the render is older than your image changes — rebuild first"
                : undefined
            }
            onClick={() => decide("approved")}
          >
            <IconCheck /> Approve
          </button>
          {isScript && (
            <button disabled={pending} className="btn ghost" onClick={() => decide("revise")}>
              <IconRefresh /> Request revision
            </button>
          )}
          <button disabled={pending} className="btn ghost danger-ink" onClick={() => decide("rejected")}>
            <IconX /> {isProfile ? "Keep channel defaults" : isRecording ? "Skip — use TTS" : "Reject"}
          </button>
          {pending && <span className="muted" style={{ fontSize: 12.5 }}>Working…</span>}
        </div>
        {error && <div className="err">{error}</div>}
      </div>
    </div>
  );
}
