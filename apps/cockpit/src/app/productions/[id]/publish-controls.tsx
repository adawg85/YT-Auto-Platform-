"use client";

import { useState, useTransition } from "react";
import {
  cancelScheduledReleaseAction,
  releasePublicationAction,
  reschedulePublicationAction,
} from "../../actions";
import { IconCalendar, IconUpload, IconX } from "@/components/icons";
import { tzAbbr, zonedInputToIso } from "@/lib/format";

/**
 * Operator controls on an uploaded publication (#20, YouTube-native
 * scheduling): publish-now (circumvents a pending schedule / releases a
 * legacy private upload) and reschedule (one videos.update moving publishAt).
 * Actions return { error } so real messages surface in prod.
 */
export function PublishControls({
  publicationId,
  privacyStatus,
}: {
  publicationId: string;
  privacyStatus: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [newTime, setNewTime] = useState("");
  const scheduled = privacyStatus === "scheduled";

  const releaseNow = () =>
    startTransition(async () => {
      setError(null);
      const res = await releasePublicationAction(publicationId);
      if (res?.error) setError(res.error);
    });

  const reschedule = () =>
    startTransition(async () => {
      if (!newTime) {
        setError("Pick the new date and time first.");
        return;
      }
      setError(null);
      const res = await reschedulePublicationAction(publicationId, zonedInputToIso(newTime));
      if (res?.error) setError(res.error);
      else setNewTime("");
    });

  const cancelSchedule = () =>
    startTransition(async () => {
      setError(null);
      const res = await cancelScheduledReleaseAction(publicationId);
      if (res?.error) setError(res.error);
    });

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" className="btn" disabled={pending} onClick={releaseNow}>
          <IconUpload /> {scheduled ? "Publish now — skip the schedule" : "Release to public"}
        </button>
        {pending && <span className="muted" style={{ fontSize: 12.5 }}>Working…</span>}
      </div>
      <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
        {scheduled
          ? "Flips the video public immediately instead of waiting for the scheduled time."
          : "Flips the YouTube video from private to public immediately."}
      </p>

      {/* Set OR move a schedule — always available on an uploaded video, so a
          private upload (e.g. one halted mid-publish) can be given a date too. */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 12 }}>
        <input
          type="datetime-local"
          value={newTime}
          onChange={(e) => setNewTime(e.target.value)}
          aria-label={`${scheduled ? "New" : "Scheduled"} release time (${tzAbbr()})`}
        />
        <button type="button" className="btn ghost" disabled={pending} onClick={reschedule}>
          <IconCalendar /> {scheduled ? "Move schedule" : "Set schedule"}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>Melbourne time ({tzAbbr()})</span>
        {scheduled && (
          <button type="button" className="btn ghost danger-ink" disabled={pending} onClick={cancelSchedule}>
            <IconX /> Cancel schedule
          </button>
        )}
      </div>
      <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
        {scheduled
          ? "Move the release to a new time, or cancel to keep it private until you release it."
          : "Give this uploaded video a future release time — YouTube flips it public automatically at the slot (it stays private until then)."}
      </p>
      {error && <div className="err">{error}</div>}
    </div>
  );
}
