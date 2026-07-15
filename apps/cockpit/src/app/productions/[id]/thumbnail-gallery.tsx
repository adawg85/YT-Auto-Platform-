"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { applyThumbnailAction } from "../../actions";
import { promoteAssetStyleRefAction } from "../../channels/style-actions";

/**
 * Post-upload thumbnail control (2026-07-12): once the video is on YouTube,
 * any candidate can be pushed to it directly — one videos.thumbnails.set
 * call. Shown on the production page whenever a publication exists; the
 * currently-live pick is highlighted.
 */
export function ThumbnailGallery({
  productionId,
  channelId,
  candidates,
}: {
  productionId: string;
  /** #35.1: enables "Save to style refs" on each candidate */
  channelId?: string;
  candidates: { id: string; storageKey: string; predictedCtr: number | null; selected: boolean; applyError?: string | null }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  if (candidates.length === 0) return null;

  // the pipeline marks the chosen thumbnail if its YouTube push failed at
  // publish — surface it here so a "plain video frame is live" is never silent
  const failed = candidates.find((t) => t.selected && t.applyError) ?? candidates.find((t) => t.applyError);

  const apply = (id: string) => {
    setBusy(id);
    setMsg(null);
    startTransition(async () => {
      const res = await applyThumbnailAction(productionId, id);
      setBusy(null);
      setMsg(res.error ?? "Thumbnail updated on YouTube.");
      if (!res.error) router.refresh();
    });
  };

  return (
    <>
      <h2>Thumbnail — live on YouTube</h2>
      {failed && (
        <div className="callout warn" style={{ marginBottom: 10 }}>
          <span>
            <strong>Your selected thumbnail wasn&apos;t applied to YouTube</strong> — the video is
            showing a plain frame instead. Reason: {failed.applyError}. Custom thumbnails need a{" "}
            <strong>verified YouTube channel</strong> (youtube.com/verify). Once verified, click your
            thumbnail below to push it to the live video.
          </span>
        </div>
      )}
      <p className="muted" style={{ margin: "0 0 8px", fontSize: 12.5 }}>
        The highlighted candidate is what YouTube shows. Click another to swap it on the live
        video — takes effect within minutes.
      </p>
      <div className="tpick">
        {candidates.map((t) => (
          <label key={t.id} className={t.selected ? "on" : ""} style={{ cursor: pending ? "wait" : "pointer" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/media/${t.storageKey}`}
              alt="Thumbnail candidate"
              onClick={() => !pending && !t.selected && apply(t.id)}
            />
            <span className="ctr">
              {busy === t.id
                ? "Applying…"
                : t.selected
                  ? "Live"
                  : t.predictedCtr !== null
                    ? `CTR ${t.predictedCtr}% — click to use`
                    : "Click to use"}
            </span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
              {/* YouTube rejects custom thumbnails on unverified channels — a
                  manual download lets the operator upload it in YouTube Studio */}
              <a
                className="btn ghost sm"
                style={{ fontSize: 11, padding: "2px 8px" }}
                href={`/api/media/${t.storageKey}`}
                download={`thumbnail-${t.id}`}
                onClick={(e) => e.stopPropagation()}
              >
                Download
              </a>
              {channelId && (
                <button
                  type="button"
                  className="btn ghost sm"
                  style={{ fontSize: 11, padding: "2px 8px" }}
                  disabled={pending}
                  onClick={(e) => {
                    e.preventDefault();
                    setMsg(null);
                    startTransition(async () => {
                      const res = await promoteAssetStyleRefAction(channelId, { thumbnailId: t.id });
                      setMsg(res.error ?? "Saved to the channel's style references.");
                    });
                  }}
                >
                  Save to style refs
                </button>
              )}
            </div>
          </label>
        ))}
      </div>
      {msg && <p className="muted" style={{ margin: "8px 0 0", fontSize: 12.5 }}>{msg}</p>}
    </>
  );
}
