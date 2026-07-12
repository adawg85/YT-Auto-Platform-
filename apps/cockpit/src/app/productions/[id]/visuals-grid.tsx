"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@/components/ui";
import { swapShotImageAction } from "../../actions";

/**
 * Beat visuals grid with per-image swap controls (2026-07-12 operator ask):
 * click any image → see its provenance and either pull a DIFFERENT real
 * archival photo (sources already used in this production are skipped) or
 * regenerate on the standard/premium model with an optional prompt. Swaps
 * update the asset in place — the "Retry from render" button rebuilds the
 * video with the new set.
 */
export type VisualItem = {
  id: string;
  idx: number;
  storageKey: string;
  /** real archival image: source page url (null → generated) */
  source: string | null;
  entity: string | null;
  license: string | null;
  prompt: string | null;
};

export function VisualsGrid({ productionId, items }: { productionId: string; items: VisualItem[] }) {
  const router = useRouter();
  const [openItem, setOpenItem] = useState<VisualItem | null>(null);
  const [prompt, setPrompt] = useState("");
  const [useRef, setUseRef] = useState(false);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [swapped, setSwapped] = useState(false);
  const [swapCount, setSwapCount] = useState(0);

  const open = (it: VisualItem) => {
    setOpenItem(it);
    setPrompt("");
    setUseRef(false);
    setError(null);
    setSwapped(false);
  };

  const run = (mode: "real" | "standard" | "hero") => {
    if (!openItem) return;
    setBusy(mode);
    setError(null);
    startTransition(async () => {
      const res = await swapShotImageAction(
        productionId,
        openItem.id,
        mode,
        prompt || undefined,
        mode !== "real" && useRef,
      );
      setBusy(null);
      if (res.error) {
        setError(res.error);
        return;
      }
      setSwapped(true);
      setSwapCount((n) => n + 1);
      router.refresh();
    });
  };

  return (
    <>
      {swapCount > 0 && (
        <div className="callout warn" style={{ margin: "0 0 10px" }}>
          <span>
            {swapCount} image{swapCount === 1 ? "" : "s"} swapped — the rendered video still shows
            the old set. Use <strong>Retry from render</strong> below to rebuild it with the new
            images (script, voiceover and thumbnails are kept).
          </span>
        </div>
      )}
      <div className="beats">
        {items.map((img) => (
          <button
            key={img.id}
            type="button"
            className="beat-swap"
            onClick={() => open(img)}
            title={img.source ? `Real — ${img.entity ?? "archival"} (click to swap)` : "Generated (click to swap)"}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/media/${img.storageKey}`} alt={`Shot ${img.idx + 1} visual`} />
            <span className={`bs-tag ${img.source ? "real" : "gen"}`}>{img.source ? "real" : "AI"}</span>
          </button>
        ))}
      </div>

      <Dialog
        open={!!openItem}
        onClose={() => !pending && setOpenItem(null)}
        title={openItem ? `Shot ${openItem.idx + 1} — swap image` : ""}
      >
        {openItem && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/media/${openItem.storageKey}`}
              alt="Current visual"
              style={{ width: "100%", borderRadius: 10, border: "1px solid var(--border)" }}
            />
            <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
              {openItem.source ? (
                <>
                  Real archival photo{openItem.entity ? <> of <strong>{openItem.entity}</strong></> : null}
                  {openItem.license ? ` · ${openItem.license}` : ""} ·{" "}
                  <a href={openItem.source} target="_blank" rel="noreferrer" style={{ color: "var(--accent-ink)" }}>
                    source
                  </a>
                </>
              ) : (
                <>AI-generated{openItem.prompt ? ` — "${openItem.prompt.slice(0, 140)}…"` : ""}</>
              )}
            </p>

            <div>
              <label className="field-label" htmlFor="swap-prompt">
                Prompt for regeneration <span className="muted" style={{ fontWeight: 500 }}>— optional; empty reuses the shot&apos;s prompt</span>
              </label>
              <textarea
                id="swap-prompt"
                rows={2}
                placeholder="Describe exactly what you want in this frame."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </div>

            <label style={{ display: "flex", gap: 7, alignItems: "center", fontSize: 13, cursor: "pointer" }}>
              <input type="checkbox" checked={useRef} onChange={(e) => setUseRef(e.target.checked)} />
              Use the current image as reference — keep this composition, rework the content
              <span className="muted" style={{ fontSize: 12 }}>(regenerate only)</span>
            </label>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="btn" disabled={pending} onClick={() => run("real")}>
                {busy === "real" ? "Searching archives…" : "Find another real photo"}
              </button>
              <button type="button" className="btn ghost" disabled={pending} onClick={() => run("standard")}>
                {busy === "standard" ? "Generating…" : "Regenerate (fal)"}
              </button>
              <button type="button" className="btn ghost" disabled={pending} onClick={() => run("hero")}>
                {busy === "hero" ? "Generating…" : "Regenerate (nano banana)"}
              </button>
            </div>
            {swapped && !pending && (
              <p style={{ margin: 0, fontSize: 13 }}>
                Swapped — the grid behind this dialog is updated. Swap more, or close and use{" "}
                <strong>Retry from render</strong> to rebuild the video.
              </p>
            )}
            {error && <div className="err">{error}</div>}
          </div>
        )}
      </Dialog>
    </>
  );
}
