"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@/components/ui";
import {
  dedupeRealImagesAction,
  generateShotClipAction,
  regenerateShotPromptAction,
  removeShotImageAction,
  swapShotImageAction,
} from "../../actions";

// Engine choices for the edit-pane dropdowns. Kept as local literals — the
// @ytauto/core barrel pulls node:crypto and can't be imported into a client
// component — but must stay in sync with IMAGE_ENGINES / VIDEO_ENGINES there.
type ImageEngine = "nano-banana" | "qwen" | "seedream";
type VideoEngine = "wan" | "minimax" | "seedance" | "kling";
const IMAGE_ENGINE_OPTS: { value: ImageEngine; label: string }[] = [
  { value: "nano-banana", label: "Nano Banana (hero)" },
  { value: "qwen", label: "Qwen" },
  { value: "seedream", label: "Seedream" },
];
const VIDEO_ENGINE_OPTS: { value: VideoEngine; label: string }[] = [
  { value: "wan", label: "Wan" },
  { value: "minimax", label: "Minimax" },
  { value: "seedance", label: "Seedance" },
  { value: "kling", label: "Kling" },
];
/** Map a served-engine name (stored on the asset) back to a dropdown value. */
function servedToImageEngine(served: string | null): ImageEngine {
  if (served === "qwen-image") return "qwen";
  if (served === "seedream") return "seedream";
  return "nano-banana"; // gemini / null / anything else
}

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
  /** Visual Director (#37): its plan for this shot, when directed */
  shotScale: string | null;
  directorIntent: string | null;
  /** the engine that actually generated this still (null for archival/older) */
  engineServed: string | null;
  /** true when engineServed was a silent fallback from what was requested */
  engineFallback: boolean;
  /** stored video clip for this shot (render prefers it over the still) */
  clipKey: string | null;
  /** this shot's on-screen seconds (null until the voiceover is timed) */
  shotSec: number | null;
  /** rough $ for one AI clip of this shot (engine-priced), null when unknown */
  clipEstUsd: number | null;
  /** hard block — no button (only when there's no voiceover to time against) */
  animateHardBlock: string | null;
  /** advisory caution shown ABOVE an enabled button (null = none) */
  animateWarn: string | null;
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
  const [clipRemoved, setClipRemoved] = useState(false);
  // Animate this shot (2026-07-14): optional motion brief + queued state
  const [motionPrompt, setMotionPrompt] = useState("");
  const [clipQueued, setClipQueued] = useState<number | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // 2026-07-16: one Regenerate button + a model dropdown, one Animate button +
  // a video-engine dropdown — instead of a button per engine.
  const [regenEngine, setRegenEngine] = useState<ImageEngine>("nano-banana");
  const [videoEngine, setVideoEngine] = useState<VideoEngine>("wan");
  // "Regenerate prompt" (2026-07-16): re-run the prompt-scripting agent for THIS
  // shot so a thin/failed prompt can be pushed individually. Separate busy flag
  // so it spins independently of the image/animate buttons.
  const [promptBusy, setPromptBusy] = useState(false);

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
    setMotionPrompt("");
    setClipQueued(null);
    setClipRemoved(false);
    setConfirmRemove(false);
    setError(null);
    setSwapped(false);
    // default the model dropdown to whatever actually made this still
    setRegenEngine(servedToImageEngine(it.engineServed));
    setPromptBusy(false);
  };

  const remove = () => {
    if (!openItem) return;
    setBusy("remove");
    setError(null);
    startTransition(async () => {
      const res = await removeShotImageAction(productionId, openItem.id);
      setBusy(null);
      if (res.error) {
        setError(res.error);
        return;
      }
      setSwapCount((n) => n + 1); // surfaces the "Retry from render" reminder
      setOpenItem(null);
      router.refresh();
    });
  };

  // mode "real" = archival search; otherwise regenerate on the chosen model.
  // nano-banana implies hero quality (handled server-side).
  const run = (mode: "real" | "regen") => {
    if (!openItem) return;
    setBusy(mode);
    setError(null);
    startTransition(async () => {
      const characterId = refSel.startsWith("char:") ? refSel.slice(5) : undefined;
      const res = await swapShotImageAction(
        productionId,
        openItem.id,
        mode === "real" ? "real" : regenEngine === "nano-banana" ? "hero" : "standard",
        {
          // prefilled-and-unchanged still posts the same text — harmless
          prompt: prompt.trim() || undefined,
          useReference: mode !== "real" && refSel === "current",
          ...(mode !== "real" && characterId ? { characterId } : {}),
          ...(mode !== "real" ? { engine: regenEngine } : {}),
        },
      );
      setBusy(null);
      if (res.error) {
        setError(res.error);
        return;
      }
      setSwapped(true);
      if (res.clipRemoved) setClipRemoved(true);
      setSwapCount((n) => n + 1);
      router.refresh();
    });
  };

  // Re-run the prompt-scripting agent for THIS shot (director's instructions →
  // one detailed prompt) and drop it into the box for review before regenerating.
  const regeneratePrompt = () => {
    if (!openItem) return;
    setPromptBusy(true);
    setError(null);
    startTransition(async () => {
      const res = await regenerateShotPromptAction(productionId, openItem.id);
      setPromptBusy(false);
      if (res.error) {
        setError(res.error);
        return;
      }
      if (res.prompt) setPrompt(res.prompt);
    });
  };

  const animate = () => {
    if (!openItem) return;
    setBusy("animate");
    setError(null);
    startTransition(async () => {
      const res = await generateShotClipAction(productionId, openItem.id, {
        prompt: motionPrompt.trim() || undefined,
        engine: videoEngine,
      });
      setBusy(null);
      if (res.error) {
        setError(res.error);
        return;
      }
      setClipQueued(res.durationSec ?? null);
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

  // engine transparency (2026-07-16): which stills were served by a DIFFERENT
  // engine than requested (a silent fallback — failed/keyless → degraded)
  const fellBack = items.filter((i) => i.engineFallback);
  const fellBackEngines = Array.from(new Set(fellBack.map((i) => i.engineServed).filter(Boolean)));

  // #37: did the Visual Director cut these shots? (director shots carry a scale
  // / intent) — surfaced so it's obvious whether the director fired.
  const directed = items.some((i) => i.shotScale || i.directorIntent);

  // storyboard timecodes: shots run in order, so each start = the sum of the
  // durations before it. Unknown as soon as a shot has no timing yet.
  const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const timeline = (() => {
    let acc = 0;
    let ok = true;
    return items.map((it) => {
      if (it.shotSec == null || !ok) {
        ok = false;
        return { start: null as number | null, end: null as number | null };
      }
      const start = acc;
      acc += it.shotSec;
      return { start, end: acc };
    });
  })();
  const ENGINE_LABEL: Record<string, string> = {
    gemini: "Nano Banana",
    "qwen-image": "Qwen",
    seedream: "Seedream",
    fal: "fal",
    "mock-media": "mock",
  };
  const prettyEngine = (e: string | null) => (e ? (ENGINE_LABEL[e] ?? e) : null);

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 10px" }}>
        {directed ? (
          <span className="chip good" title="A director agent storyboarded this video — shots cut on meaning, framing and medium chosen per shot.">
            Directed — AI storyboard
          </span>
        ) : (
          <span className="chip" title="Shots were cut mechanically by the Rhythm setting. Turn on 'Visual director' on the Profile tab (then produce a new video) to storyboard them.">
            Rhythm cut
          </span>
        )}
      </div>
      {fellBack.length > 0 && (
        <div className="callout warn" style={{ margin: "0 0 10px" }}>
          <span>
            <strong>{fellBack.length}</strong> of {items.length} image
            {fellBack.length === 1 ? " was" : "s were"} served by a{" "}
            <strong>fallback engine</strong>
            {fellBackEngines.length ? ` (${fellBackEngines.join(", ")})` : ""} — the requested model
            failed or has no key/credits, so these are off-model. Check the engine&apos;s
            billing/quota (Gemini → <code>/api/diag/media</code>; fal/DashScope → the vendor console),
            then Regenerate the affected shots.
          </span>
        </div>
      )}
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
      <div className="sb-table">
        <div className="sb-head" aria-hidden="true">
          <span>#</span>
          <span>Time</span>
          <span>Scene &amp; narration</span>
          <span>Visual</span>
          <span></span>
        </div>
        {items.map((img, i) => {
          const t = timeline[i]!;
          const medium = img.clipKey ? "Clip" : img.source ? "Real" : "AI";
          const eng = prettyEngine(img.engineServed);
          // the director's intent reads better than the raw prompt when present
          const look = img.directorIntent || (img.source ? (img.entity ?? "archival photo") : (img.prompt ?? ""));
          return (
            <div
              key={img.id}
              className="sb-row"
              role="button"
              tabIndex={0}
              onClick={() => open(img)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  open(img);
                }
              }}
              title="Click to swap, regenerate, or animate this shot"
            >
              <div className="sb-num">{img.idx + 1}</div>
              <div className="sb-time">
                {t.start != null && t.end != null ? (
                  <>
                    <span>
                      {fmtTime(t.start)}–{fmtTime(t.end)}
                    </span>
                    {img.shotSec != null && <span className="dur">{img.shotSec.toFixed(1)}s</span>}
                  </>
                ) : (
                  <span className="dur">{img.shotSec != null ? `${img.shotSec.toFixed(1)}s` : "—"}</span>
                )}
              </div>
              <div className="sb-scene">
                {(img.hero || img.character || img.shotScale) && (
                  <div className="top">
                    {img.hero && <span className="chip">hero</span>}
                    {img.shotScale && <span className="chip">{img.shotScale}</span>}
                    {img.character && <span className="chip acc">{img.character}</span>}
                  </div>
                )}
                <p>{img.narration ?? <span className="muted">(no narration recorded for this shot)</span>}</p>
                {look && <div className="look">{look}</div>}
              </div>
              <div className="sb-vis">
                <div className="sb-thumb">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/media/${img.storageKey}`} alt={`Shot ${img.idx + 1} visual`} />
                  {img.clipKey && (
                    <span className="play">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    </span>
                  )}
                </div>
                <div className="sb-tags">
                  <span className={`chip ${img.clipKey ? "good" : ""}`}>{medium}</span>
                  {eng && <span className="chip">{eng}</span>}
                  {img.engineFallback && (
                    <span
                      className="chip warn"
                      title={`Served by ${img.engineServed ?? "a fallback engine"} — the requested model was unavailable`}
                    >
                      ⚠ {eng ?? "fallback"}
                    </span>
                  )}
                </div>
              </div>
              <span className="sb-edit">Edit ▸</span>
            </div>
          );
        })}
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
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <label className="field-label" htmlFor="swap-prompt" style={{ marginBottom: 0 }}>
                  Prompt for regeneration <span className="muted" style={{ fontWeight: 500 }}>— edit in place; empty reuses the shot&apos;s stored prompt</span>
                </label>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={pending || promptBusy}
                  onClick={regeneratePrompt}
                  title="Re-run the prompt-scripting agent for this shot (the director's instructions) — use it when the auto prompt came out thin, then Regenerate."
                >
                  {promptBusy ? "Writing prompt…" : "Regenerate prompt"}
                </button>
              </div>
              <textarea
                id="swap-prompt"
                rows={4}
                placeholder="Describe exactly what you want in this frame."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                style={{ marginTop: 6 }}
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

            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button type="button" className="btn" disabled={pending} onClick={() => run("regen")}>
                {busy === "regen" ? "Generating…" : "Regenerate"}
              </button>
              <select
                aria-label="Image model"
                value={regenEngine}
                onChange={(e) => setRegenEngine(e.target.value as ImageEngine)}
                style={{ height: 34 }}
                title="Which model regenerates this image"
              >
                {IMAGE_ENGINE_OPTS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <button type="button" className="btn ghost" disabled={pending} onClick={() => run("real")} style={{ marginLeft: "auto" }}>
                {busy === "real" ? "Searching archives…" : "Find another real photo"}
              </button>
            </div>
            {swapped && !pending && (
              <p style={{ margin: 0, fontSize: 13 }}>
                Swapped — the grid behind this dialog is updated.
                {clipRemoved && (
                  <>
                    {" "}This shot&apos;s video clip was removed (it showed the old image) — use{" "}
                    <strong>Animate this shot</strong> below to remake it from the new one.
                  </>
                )}{" "}
                Swap more, or close and use <strong>Retry from render</strong> to rebuild the video.
              </p>
            )}

            {/* ── Animate this shot (2026-07-14): image → video clip ── */}
            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
              <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
                <span className="field-label" style={{ margin: 0 }}>Animate this shot</span>
                {openItem.clipKey && <span className="chip acc">has a video clip</span>}
              </div>
              <p className="muted" style={{ margin: "4px 0 8px", fontSize: 12 }}>
                Generates a short AI video FROM this image; the render uses it instead of the
                still. Takes a few minutes on the video engine — it appears in the clip strip
                below the grid when done.
              </p>
              {openItem.clipKey && (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <video
                  src={`/api/media/${openItem.clipKey}`}
                  muted
                  controls
                  preload="metadata"
                  style={{ width: "100%", maxHeight: 200, borderRadius: 8, border: "1px solid var(--border)", marginBottom: 8 }}
                />
              )}
              {openItem.animateHardBlock ? (
                <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>{openItem.animateHardBlock}</p>
              ) : clipQueued !== null ? (
                <div className="callout" style={{ margin: 0 }}>
                  <span>
                    Clip queued (~{clipQueued}s of motion) — generation takes a few minutes.
                    {openItem.clipKey ? " It will replace the current clip." : ""} Refresh the page to see it land.
                  </span>
                </div>
              ) : (
                <>
                  {openItem.animateWarn && (
                    <p className="muted" style={{ margin: "0 0 6px", fontSize: 12 }}>{openItem.animateWarn}</p>
                  )}
                  <textarea
                    rows={2}
                    placeholder="Optional motion notes — e.g. slow push-in on the pendulum, sparks drifting. Empty uses the shot's own scene brief."
                    value={motionPrompt}
                    onChange={(e) => setMotionPrompt(e.target.value)}
                  />
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
                    <button type="button" className="btn ghost" disabled={pending} onClick={animate}>
                      {busy === "animate"
                        ? "Queuing…"
                        : `${openItem.clipKey ? "Re-animate" : "Animate"}${openItem.shotSec ? ` · ~${Math.round(openItem.shotSec)}s` : ""}${openItem.clipEstUsd ? ` · ≈$${openItem.clipEstUsd.toFixed(2)}` : ""}`}
                    </button>
                    <select
                      aria-label="Video model"
                      value={videoEngine}
                      onChange={(e) => setVideoEngine(e.target.value as VideoEngine)}
                      style={{ height: 34 }}
                      title="Which engine animates this shot"
                    >
                      {VIDEO_ENGINE_OPTS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </>
              )}
            </div>

            {/* Remove this shot's image (2026-07-16): delete it; the render holds
                the previous frame over this shot's time. Narration is unchanged. */}
            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
              {confirmRemove ? (
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    Remove this image? The previous frame holds over this shot&apos;s time (the
                    narration is unchanged). Rebuild with <strong>Retry from render</strong>.
                  </span>
                  <button type="button" className="btn danger" disabled={pending} onClick={remove}>
                    {busy === "remove" ? "Removing…" : "Confirm remove"}
                  </button>
                  <button type="button" className="btn ghost sm" disabled={pending} onClick={() => setConfirmRemove(false)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="btn ghost danger-ink"
                  disabled={pending}
                  onClick={() => setConfirmRemove(true)}
                >
                  Remove this image
                </button>
              )}
            </div>
            {error && <div className="err">{error}</div>}
          </div>
        )}
      </Dialog>
    </>
  );
}
