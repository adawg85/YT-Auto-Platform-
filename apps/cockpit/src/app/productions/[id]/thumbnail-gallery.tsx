"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { applyThumbnailAction } from "../../actions";

/**
 * Post-upload thumbnail control (2026-07-12): once the video is on YouTube,
 * any candidate can be pushed to it directly — one videos.thumbnails.set
 * call. Shown on the production page whenever a publication exists; the
 * currently-live pick is highlighted.
 */
export function ThumbnailGallery({
  productionId,
  candidates,
}: {
  productionId: string;
  candidates: { id: string; storageKey: string; predictedCtr: number | null; selected: boolean }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  if (candidates.length === 0) return null;

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
          </label>
        ))}
      </div>
      {msg && <p className="muted" style={{ margin: "8px 0 0", fontSize: 12.5 }}>{msg}</p>}
    </>
  );
}
