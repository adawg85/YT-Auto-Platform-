"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { applyThumbnailAction } from "../../actions";
import { promoteAssetStyleRefAction } from "../../channels/style-actions";

/**
 * Thumbnail control (2026-07-12). Once the video is on YouTube any candidate
 * can be pushed to it directly — one videos.thumbnails.set call.
 *
 * `live` = there is a video on YouTube to push to. When false the gallery
 * still renders (2026-08-05): candidates are generated long before publish,
 * and hiding them until a successful upload meant a production whose upload
 * failed showed no thumbnails at all — including the Download that exists for
 * exactly that case (unverified channels can't take a custom thumbnail via the
 * API, so the operator uploads it in Studio by hand). Click-to-apply is the
 * only thing that genuinely needs a live video, so that is all `live` gates.
 */
export function ThumbnailGallery({
  live,
  productionId,
  channelId,
  candidates,
}: {
  /** a video exists on YouTube, so a candidate can be pushed to it */
  live: boolean;
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
  // reason-aware guidance: an `invalidImage` 400 is an image problem (size/
  // format), NOT the verification wall — telling the operator to "verify their
  // channel" for it is a wrong lead (2026-07-19). We now re-encode to a safe
  // JPEG on push, so for that case the fix is simply to click-to-retry.
  const errText = (failed?.applyError ?? "").toLowerCase();
  const isImageErr = errText.includes("invalidimage") || errText.includes("image content is invalid");
  const isVerifyErr =
    errText.includes("403") ||
    errText.includes("forbidden") ||
    errText.includes("verif") ||
    errText.includes("not enabled");

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
      <h2>{live ? "Thumbnail — live on YouTube" : "Thumbnail candidates"}</h2>
      {failed && (
        <div className="callout warn" style={{ marginBottom: 10 }}>
          <span>
            <strong>Your selected thumbnail wasn&apos;t applied to YouTube</strong> — the video is
            showing a plain frame instead.{" "}
            {isImageErr ? (
              <>
                YouTube rejected the image (too large or an unsupported format). We now re-encode
                thumbnails to a YouTube-safe JPEG on upload, so just <strong>click a thumbnail below
                to push it again</strong> — it should stick.
              </>
            ) : isVerifyErr ? (
              <>
                Custom thumbnails need a <strong>verified YouTube channel</strong>{" "}
                (youtube.com/verify). Once verified, click your thumbnail below to push it to the
                live video.
              </>
            ) : (
              <>Click a thumbnail below to push it to the live video again.</>
            )}
            <span className="muted" style={{ display: "block", marginTop: 4, fontSize: 12 }}>
              Reason: {failed.applyError}
            </span>
          </span>
        </div>
      )}
      <p className="muted" style={{ margin: "0 0 8px", fontSize: 12.5 }}>
        {live
          ? "The highlighted candidate is what YouTube shows. Click another to swap it on the live video — takes effect within minutes."
          : "The highlighted candidate is the one the pipeline chose. Nothing is on YouTube yet, so these can't be applied — download the one you want and set it in YouTube Studio."}
      </p>
      <div className="tpick">
        {candidates.map((t) => (
          <label
            key={t.id}
            className={t.selected ? "on" : ""}
            style={{ cursor: !live ? "default" : pending ? "wait" : "pointer" }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/media/${t.storageKey}`}
              alt="Thumbnail candidate"
              onClick={() => live && !pending && !t.selected && apply(t.id)}
            />
            <span className="ctr">
              {busy === t.id
                ? "Applying…"
                : t.selected
                  ? live
                    ? "Live"
                    : "Chosen"
                  : t.predictedCtr !== null
                    ? `CTR ${t.predictedCtr}%${live ? " — click to use" : ""}`
                    : live
                      ? "Click to use"
                      : "Candidate"}
            </span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
              {/* YouTube rejects custom thumbnails on unverified channels — a
                  manual download lets the operator upload it in YouTube Studio.
                  ?download=1 rather than the `download` attribute, which mobile
                  browsers ignore; and the filename now carries the real
                  extension (it was extensionless, so the saved file opened in
                  nothing). */}
              <a
                className="btn ghost sm"
                style={{ fontSize: 11, padding: "2px 8px" }}
                href={`/api/media/${t.storageKey}?download=1&filename=thumbnail-${t.id}${t.storageKey.slice(
                  t.storageKey.lastIndexOf("."),
                )}`}
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
