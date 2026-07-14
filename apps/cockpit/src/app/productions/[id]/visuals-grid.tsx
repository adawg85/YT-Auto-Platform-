"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@/components/ui";
import { dedupeRealImagesAction, swapShotImageAction } from "../../actions";

/**
 * Beat visuals grid with per-image swap controls (2026-07-12 operator ask):
 * click any image → see its provenance and either pull a DIFFERENT real
 * archival photo (sources already used in this production are skipped) or
 * regenerate on the standard/hero engine with an optional prompt. Swaps
 * update the asset in place — the "Retry from render" button rebuilds the
 * video with the new set.
 *
 * 2026-07-14 operator asks: the dialog now shows the shot's NARRATION and the
 * FULL generation prompt (was a 140-char slice), prefills the prompt box for
 * in-place editing, and the Reference picker can cast a channel character —
 * its canonical description leads the prompt and its reference sheet takes
 * the reference slot, same as the pipeline's own conditioning.
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
  /** the shot's narration slice (stored on new assets from 2026-07-14) */
  narration: string | null;
  character: string | null;
  characterId: string | null;
  hero: boolean;
};

export function VisualsGrid({
  productionId,
  items,
  characters = [],
}: {
  productionId: string;
  items: VisualItem[];
  characters?: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [openItem, setOpenItem] = useState<VisualItem | null>(null);
  const [prompt, setPrompt] = useState("");
  /** reference slot: none | current image | a character sheet */
  const [refSel, setRefSel] = useState<string>("none");
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [swapped, setSwapped] = useState(false);
  const [swapCount, setSwapCount] = useState(0);

  const open = (it: VisualItem) => {
    setOpenItem(it);
    // prefill for in-place editing (2026-07-14) — clearing it still means
    // "reuse the stored prompt" server-side
    setPrompt(it.prompt ?? "");
    setRefSel(
      it.characterId && characters.some((c) => c.id === it.characterId)
        ? `char:${it.characterId}`
        : "none",
    );
    setError(null);
    setSwapped(false);
  };

  const run = (mode: "real" | "standard" | "hero") => {
    if (!openItem) return;
    setBusy(mode);
    setError(null);
    startTransition(async () => {
      const characterId = refSel.startsWith("char:") ? refSel.slice(5) : undefined;
      const res = await swapShotImageAction(productionId, openItem.id, mode, {
        // prefilled-and-unchanged still posts the same text — harmless
        prompt: prompt.trim() || undefined,
        useReference: mode !== "real" && refSel === "current",
        ...(mode !== "real" && characterId ? { characterId } : {}),
      });
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

  const dupCount = (() => {
    const seen = new Set<string>();
    let n = 0;
    for (const it of items) {
      if (!it.source) continue;
      if (seen.has(it.source)) n++;
      else seen.add(it.source);
    }
    return n;
  })();
  const [deduping, startDedupe] = useTransition();
  const [dedupeMsg, setDedupeMsg] = useState<string | null>(null);

  return (
    <>
      {dupCount > 0 && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", margin: "0 0 10px" }}>
          <button
            type="button"
            className="btn ghost"
            disabled={deduping}
            onClick={() => {
              setDedupeMsg(null);
              startDedupe(async () => {
                const res = await dedupeRealImagesAction(productionId);
                if (res.error) setDedupeMsg(res.error);
                else {
                  setDedupeMsg(
                    `Replaced ${res.replaced}/${res.duplicates} duplicates${res.unresolved ? ` — ${res.unresolved} need a manual swap` : ""}.`,
                  );
                  if (res.replaced) setSwapCount((n) => n + (res.replaced ?? 0));
                }
                router.refresh();
              });
            }}
          >
            {deduping ? "Scanning archives…" : `Auto-fix ${dupCount} duplicate real image${dupCount === 1 ? "" : "s"}`}
          </button>
          {dedupeMsg && <span className="muted" style={{ fontSize: 12.5 }}>{dedupeMsg}</span>}
          {deduping && <span className="muted" style={{ fontSize: 12.5 }}>each replacement is vision-checked — can take a minute</span>}
        </div>
      )}
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
            {/* maxHeight: a 9:16 portrait at full dialog width would push the
                prompt + reference controls below the fold (2026-07-14) */}
            <img
              src={`/api/media/${openItem.storageKey}`}
              alt="Current visual"
              style={{
                width: "100%",
                maxHeight: 260,
                objectFit: "contain",
                borderRadius: 10,
                border: "1px solid var(--border)",
                background: "var(--panel-2, transparent)",
              }}
            />

            {openItem.narration && (
              <p className="muted" style={{ margin: 0, fontSize: 12.5, fontStyle: "italic" }}>
                Narration this frame covers: &ldquo;{openItem.narration}&rdquo;
              </p>
            )}

            {openItem.source ? (
              <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                Real archival photo{openItem.entity ? <> of <strong>{openItem.entity}</strong></> : null}
                {openItem.license ? ` · ${openItem.license}` : ""} ·{" "}
                <a href={openItem.source} target="_blank" rel="noreferrer" style={{ color: "var(--accent-ink)" }}>
                  source
                </a>
              </p>
            ) : (
              <div>
                <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
                  <span className="field-label" style={{ margin: 0 }}>Generation prompt</span>
                  {openItem.hero && <span className="chip">hero model</span>}
                  {openItem.character && <span className="chip acc">cast: {openItem.character}</span>}
                </div>
                {openItem.prompt && (
                  <p
                    className="muted"
                    style={{
                      margin: "4px 0 0",
                      fontSize: 12.5,
                      whiteSpace: "pre-wrap",
                      maxHeight: 120,
                      overflowY: "auto",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      padding: "6px 8px",
                    }}
                  >
                    {openItem.prompt}
                  </p>
                )}
              </div>
            )}

            <div>
              <label className="field-label" htmlFor="swap-prompt">
                Prompt for regeneration <span className="muted" style={{ fontWeight: 500 }}>— edit in place; empty reuses the shot&apos;s stored prompt</span>
              </label>
              <textarea
                id="swap-prompt"
                rows={4}
                placeholder="Describe exactly what you want in this frame."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </div>

            <div>
              <label className="field-label" htmlFor="swap-ref">
                Reference <span className="muted" style={{ fontWeight: 500 }}>— regenerate only; one reference per generation</span>
              </label>
              <select id="swap-ref" value={refSel} onChange={(e) => setRefSel(e.target.value)} style={{ height: 34 }}>
                <option value="none">None — fresh generation from the prompt</option>
                <option value="current">Current image — keep composition, rework content</option>
                {characters.map((c) => (
                  <option key={c.id} value={`char:${c.id}`}>
                    Character: {c.name} — inject with their reference sheet
                  </option>
                ))}
              </select>
              {refSel.startsWith("char:") && (
                <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
                  The character&apos;s canonical look leads the prompt and their sheet conditions the
                  image — best on the hero model for identity consistency.
                </p>
              )}
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="btn" disabled={pending} onClick={() => run("real")}>
                {busy === "real" ? "Searching archives…" : "Find another real photo"}
              </button>
              <button type="button" className="btn ghost" disabled={pending} onClick={() => run("standard")}>
                {busy === "standard" ? "Generating…" : "Regenerate (standard)"}
              </button>
              <button type="button" className="btn ghost" disabled={pending} onClick={() => run("hero")}>
                {busy === "hero" ? "Generating…" : "Regenerate (hero · Nano Banana)"}
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
