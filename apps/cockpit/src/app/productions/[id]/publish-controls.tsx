"use client";

import { useState, useTransition } from "react";
import { releasePublicationAction, reschedulePublicationAction } from "../../actions";
import { IconCalendar, IconUpload } from "@/components/icons";

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
      const res = await reschedulePublicationAction(publicationId, new Date(newTime).toISOString());
      if (res?.error) setError(res.error);
      else setNewTime("");
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
      {scheduled && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 12 }}>
          <input
            type="datetime-local"
            value={newTime}
            onChange={(e) => setNewTime(e.target.value)}
            aria-label="New release time"
          />
          <button type="button" className="btn ghost" disabled={pending} onClick={reschedule}>
            <IconCalendar /> Move schedule
          </button>
        </div>
      )}
      {error && <div className="err">{error}</div>}
    </div>
  );
}
