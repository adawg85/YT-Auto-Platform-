"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@/components/ui";
import {
  cancelClipAction,
  clipStatusAction,
  dedupeRealImagesAction,
  fillThinPromptsAction,
  generateShotClipAction,
  regenerateShotPromptAction,
  removeShotImageAction,
  saveShotPromptAction,
  suggestMotionPromptAction,
  swapShotImageAction,
} from "../../actions";

/** Inline spinner (reuses the global .spinner). */
const Spinner = () => <span className="spinner" aria-hidden="true" style={{ display: "inline-block", verticalAlign: "-2px" }} />;

/** Live status of one shot's async Animate request. */
type ClipStatus = {
  status: "queued" | "done" | "failed";
  idx: number;
  queuedAt: number;
  /** the clip's updatedAt at queue time (null = none) — for clock-skew-proof
   * completion detection (a clip newer than this, or that now exists, = done). */
  prevClipAt?: number | null;
  error?: string;
};

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
// compact labels for the inline per-row selects (space is tight)
const IMG_SHORT: { value: ImageEngine; label: string }[] = [
  { value: "nano-banana", label: "Nano" },
  { value: "qwen", label: "Qwen" },
  { value: "seedream", label: "Seedream" },
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
  /** generated shot whose prompt never got elaborated (thin fallback draft) */
  promptThin: boolean;
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
  // Click a row thumbnail to preview it in place (2026-07-17 operator): the
  // still opens full-size, a shot with a clip plays the video — no need to open
  // Edit or scroll to the clips list below.
  const [preview, setPreview] = useState<VisualItem | null>(null);
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
  const [motionBusy, setMotionBusy] = useState(false);
  const [clipQueued, setClipQueued] = useState<number | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // 2026-07-16: one Regenerate button + a model dropdown, one Animate button +
  // a video-engine dropdown — instead of a button per engine.
  const [regenEngine, setRegenEngine] = useState<ImageEngine>("nano-banana");
  const [videoEngine, setVideoEngine] = useState<VideoEngine>("seedance");
  // "Regenerate prompt" (2026-07-16): re-run the prompt-scripting agent for THIS
  // shot so a thin/failed prompt can be pushed individually. Separate busy flag
  // so it spins independently of the image/animate buttons.
  const [promptBusy, setPromptBusy] = useState(false);
  // Inline per-row rapid-fire (2026-07-16): a global model pick + Prompt/Image/
  // Animate buttons on every row that fire INDEPENDENTLY (per-row busy keys), so
  // the operator can click across many shots and let them run concurrently. The
  // page refreshes once, when the last in-flight action settles.
  const [rowBusy, setRowBusy] = useState<Set<string>>(new Set());
  // Live Animate status per row (2026-07-17 operator: needs a real in-progress /
  // done / failed signal — clips generate async in the worker over minutes).
  // A poller (below) resolves each "queued" entry to done/failed by asking the
  // server, so the operator always knows whether a clip is coming or dead.
  const [clipState, setClipState] = useState<Record<string, ClipStatus>>({});
  // Inline row actions (Prompt/Image) used to swallow every failure — a
  // server-side error or a thrown exception left the button to just stop, so a
  // failed regenerate looked like "nothing happened" (2026-07-17 operator:
  // Krypton images weren't regenerating). Surface the reason instead.
  const [rowErr, setRowErr] = useState<string | null>(null);
  const inflight = useRef(0);
  // Image-regen QUEUE (2026-07-17 operator: stacking regens only ran one; the
  // rest were dropped, and results needed a manual refresh). Clicks enqueue
  // here and process one-at-a-time; on success the new key lands in imgOverride
  // so the thumbnail updates INSTANTLY, no refresh. imgQueued = ids waiting or
  // running (head is the running one); imgRunning guards the processor.
  const [imgQueued, setImgQueued] = useState<string[]>([]);
  const [imgOverride, setImgOverride] = useState<Record<string, string>>({});
  const imgRunning = useRef(false);
  // per-row inline controls (2026-07-16): each row picks its own image model,
  // video model, character, and has an editable prompt — no dialog needed.
  const [imgEngById, setImgEngById] = useState<Record<string, ImageEngine>>({});
  const [vidEngById, setVidEngById] = useState<Record<string, VideoEngine>>({});
  const [charById, setCharById] = useState<Record<string, string>>({});
  const [promptEdits, setPromptEdits] = useState<Record<string, string>>({});
  // per-row suggested motion prompt (inline "✨ Motion" button). Undefined = none
  // yet; a string (even "") = shown + editable, and passed to Animate.
  const [motionByRow, setMotionByRow] = useState<Record<string, string>>({});
  // the generation prompt collapses to ONE line per row (2026-07-17 operator: it
  // ate the whole screen); focusing/clicking expands it to the full text.
  const [promptOpen, setPromptOpen] = useState<Record<string, boolean>>({});

  const imgEngOf = (img: VisualItem): ImageEngine => imgEngById[img.id] ?? servedToImageEngine(img.engineServed);
  const vidEngOf = (img: VisualItem): VideoEngine => vidEngById[img.id] ?? "seedance";
  const charOf = (img: VisualItem): string =>
    charById[img.id] ??
    (img.characterId && characters.some((c) => c.id === img.characterId) ? img.characterId : "none");
  const promptOf = (img: VisualItem): string => promptEdits[img.id] ?? img.prompt ?? "";

  const setBusyKey = (key: string, on: boolean) =>
    setRowBusy((prev) => {
      const n = new Set(prev);
      if (on) n.add(key);
      else n.delete(key);
      return n;
    });
  // Regenerate the PROMPT for this shot; drop the result straight into the row's
  // editable box (and it's persisted server-side) so the change shows at once.
  const rowPrompt = (img: VisualItem) => {
    const key = `${img.id}:prompt`;
    if (rowBusy.has(key)) return;
    setRowErr(null);
    setBusyKey(key, true);
    inflight.current += 1;
    regenerateShotPromptAction(productionId, img.id, { persist: true })
      .then((res) => {
        if (res.error) setRowErr(res.error);
        else if (res.prompt) setPromptEdits((p) => ({ ...p, [img.id]: res.prompt! }));
      })
      .catch((e) => setRowErr(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setBusyKey(key, false);
        inflight.current -= 1;
        if (inflight.current === 0) router.refresh();
      });
  };
  // Regenerate the IMAGE — enqueue this row (a no-op if it's already waiting or
  // running). The processor effect below drains the queue one at a time.
  const rowRegen = (img: VisualItem) => {
    setRowErr(null);
    setImgQueued((q) => (q.includes(img.id) ? q : [...q, img.id]));
  };
  // Drain the image queue one at a time: run the head, drop the new key into
  // imgOverride (instant thumbnail update), then dequeue so the effect re-fires
  // for the next. imgRunning guards against double-processing on re-render.
  useEffect(() => {
    if (imgRunning.current || imgQueued.length === 0) return;
    const id = imgQueued[0]!;
    const img = items.find((it) => it.id === id);
    if (!img) {
      setImgQueued((q) => q.filter((x) => x !== id));
      return;
    }
    imgRunning.current = true;
    const engine = imgEngById[id] ?? servedToImageEngine(img.engineServed);
    const character = charById[id] ?? (img.characterId && characters.some((c) => c.id === img.characterId) ? img.characterId : "none");
    const promptText = (promptEdits[id] ?? img.prompt ?? "").trim();
    setBusyKey(`${id}:image`, true);
    swapShotImageAction(productionId, id, engine === "nano-banana" ? "hero" : "standard", {
      engine,
      prompt: promptText || undefined,
      ...(character !== "none" ? { characterId: character } : {}),
    })
      .then((res) => {
        if (res.error) setRowErr(`Shot ${img.idx + 1}: ${res.error}`);
        else if (res.storageKey) setImgOverride((o) => ({ ...o, [id]: res.storageKey! }));
      })
      .catch((e) => setRowErr(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setBusyKey(`${id}:image`, false);
        imgRunning.current = false;
        setImgQueued((q) => {
          const next = q.filter((x) => x !== id);
          if (next.length === 0) router.refresh(); // sync badges/clip state once the batch drains
          return next;
        });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imgQueued, productionId]);
  // Animate is async (the worker polls the vendor for minutes). Queue it, then
  // the poller below drives the row to done/failed — the operator never has to
  // guess whether a clip is coming. A queue-time error fails the row outright.
  const rowAnimate = (img: VisualItem) => {
    const key = `${img.id}:animate`;
    if (rowBusy.has(key)) return;
    setBusyKey(key, true);
    setClipState((s) => {
      const n = { ...s };
      delete n[img.id];
      return n;
    });
    const motion = motionByRow[img.id]?.trim() || undefined;
    generateShotClipAction(productionId, img.id, { engine: vidEngOf(img), ...(motion ? { prompt: motion } : {}) })
      .then((res) => {
        if (res?.error) {
          setClipState((s) => ({ ...s, [img.id]: { status: "failed", idx: img.idx, queuedAt: Date.now(), error: res.error } }));
        } else {
          setClipState((s) => ({
            ...s,
            [img.id]: { status: "queued", idx: img.idx, queuedAt: res?.queuedAt ?? Date.now(), prevClipAt: res?.prevClipAt ?? null },
          }));
        }
      })
      .catch((e) => setClipState((s) => ({ ...s, [img.id]: { status: "failed", idx: img.idx, queuedAt: Date.now(), error: String(e) } })))
      .finally(() => setBusyKey(key, false));
  };
  // Cancel a queued/animating clip on purpose — stops the worker run (Inngest
  // cancelOn) and clears the row's status. The clip won't land.
  const rowCancelAnimate = (img: VisualItem) => {
    setClipState((s) => {
      const n = { ...s };
      delete n[img.id];
      return n;
    });
    void cancelClipAction(productionId, img.idx);
  };
  // Cancel a WAITING image regen — drop it from the queue before it runs. (The
  // one currently generating can't be aborted mid-call; it just finishes.)
  const cancelImageRegen = (img: VisualItem) => setImgQueued((q) => q.filter((x) => x !== img.id));
  // Inline "✨ Motion": write a motion prompt from this frame + its image prompt
  // (the current text, if any, steers it). Reveals an editable box that Animate
  // then uses. Same agent as the dialog's Suggest button.
  const rowSuggestMotion = (img: VisualItem) => {
    const key = `${img.id}:motion`;
    if (rowBusy.has(key)) return;
    setRowErr(null);
    setBusyKey(key, true);
    suggestMotionPromptAction(productionId, img.id, motionByRow[img.id]?.trim() || undefined)
      .then((res) => {
        if (res.error) setRowErr(`Shot ${img.idx + 1}: ${res.error}`);
        else setMotionByRow((m) => ({ ...m, [img.id]: res.prompt ?? "" }));
      })
      .catch((e) => setRowErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusyKey(key, false));
  };
  // Poll the server for each queued clip until it actually lands (done) or the
  // worker records a real failure. NO wall-clock timeout (2026-07-17 operator: a
  // clip that DID animate got falsely flagged failed after 8 min because several
  // were queued and Seedance runs them one at a time — the wait is expected, not
  // an error). It only fails on a genuine error; Cancel stops one on purpose.
  const queuedIds = Object.entries(clipState)
    .filter(([, c]) => c.status === "queued")
    .map(([id]) => id);
  const queuedKey = queuedIds.join(",");
  useEffect(() => {
    if (!queuedKey) return;
    let cancelled = false;
    const tick = async () => {
      const entries = Object.entries(clipState).filter(([, c]) => c.status === "queued");
      for (const [id, c] of entries) {
        try {
          const res = await clipStatusAction(productionId, c.idx, c.queuedAt, c.prevClipAt);
          if (cancelled) return;
          if (res.status === "done") {
            setClipState((s) => (s[id] ? { ...s, [id]: { ...s[id]!, status: "done" } } : s));
            router.refresh();
          } else if (res.status === "failed") {
            setClipState((s) => (s[id] ? { ...s, [id]: { ...s[id]!, status: "failed", error: res.error } } : s));
          }
        } catch {
          /* transient — next tick retries */
        }
      }
    };
    const iv = setInterval(tick, 5000);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queuedKey, productionId]);
  // Persist the queues across a page reload (2026-07-17 operator: queued items
  // vanished on reload). Waiting image regens resume; animate work is already
  // running server-side, so restoring its "queued" entries just re-attaches the
  // live poller (the clip lands regardless). sessionStorage = survives reload,
  // per tab. Read once on mount (client-only, so no SSR mismatch).
  const qKey = `vg-queue-${productionId}`;
  const persistMounted = useRef(false);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(qKey);
      if (!raw) return;
      const saved = JSON.parse(raw) as { imgQueued?: string[]; clips?: Record<string, ClipStatus> };
      if (saved.imgQueued?.length) setImgQueued((q) => Array.from(new Set([...saved.imgQueued!, ...q])));
      if (saved.clips && Object.keys(saved.clips).length) setClipState((s) => ({ ...saved.clips, ...s }));
    } catch {
      /* corrupt/blocked storage — ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // skip the mount run so we don't overwrite saved state before hydration lands
    if (!persistMounted.current) {
      persistMounted.current = true;
      return;
    }
    try {
      const clips = Object.fromEntries(Object.entries(clipState).filter(([, c]) => c.status === "queued"));
      if (imgQueued.length === 0 && Object.keys(clips).length === 0) sessionStorage.removeItem(qKey);
      else sessionStorage.setItem(qKey, JSON.stringify({ imgQueued, clips }));
    } catch {
      /* ignore */
    }
  }, [imgQueued, clipState, qKey]);
  // persist an inline prompt edit on blur (only when it actually changed)
  const savePromptEdit = (img: VisualItem) => {
    const edited = promptEdits[img.id];
    if (edited === undefined || edited.trim() === (img.prompt ?? "").trim()) return;
    void saveShotPromptAction(productionId, img.id, edited);
  };

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
  // Suggest a motion prompt from THIS frame + its image prompt (operator can
  // seed a direction in the box first; it's honoured). Fills the box for review.
  const suggestMotion = () => {
    if (!openItem || motionBusy) return;
    setMotionBusy(true);
    setError(null);
    suggestMotionPromptAction(productionId, openItem.id, motionPrompt.trim() || undefined)
      .then((res) => {
        if (res.error) setError(res.error);
        else if (res.prompt) setMotionPrompt(res.prompt);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setMotionBusy(false));
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

  // "Fill thin prompts" (2026-07-16): shots whose prompt never got elaborated
  const thinCount = items.filter((i) => i.promptThin).length;
  const [filling, startFill] = useTransition();
  const [fillMsg, setFillMsg] = useState<string | null>(null);

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
      {thinCount > 0 && (
        <div className="callout warn" style={{ margin: "0 0 10px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ flex: 1, minWidth: 220 }}>
            <strong>{thinCount}</strong> shot{thinCount === 1 ? "" : "s"} never got a detailed prompt (the
            builder fell back to a thin brief). Fill them from the director&apos;s instructions, then
            Regenerate those images.
          </span>
          <button
            type="button"
            className="btn sm"
            disabled={filling}
            onClick={() => {
              setFillMsg(null);
              startFill(async () => {
                const res = await fillThinPromptsAction(productionId);
                if (res.error) setFillMsg(res.error);
                else setFillMsg(`Filled ${res.filled ?? 0}/${res.thin ?? 0} — now Regenerate the affected images.`);
                router.refresh();
              });
            }}
          >
            {filling ? "Writing prompts…" : `Fill ${thinCount} thin prompt${thinCount === 1 ? "" : "s"}`}
          </button>
          {fillMsg && <span className="muted" style={{ fontSize: 12.5, width: "100%" }}>{fillMsg}</span>}
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
      {imgQueued.length > 0 && (
        <div className="callout" style={{ margin: "0 0 10px" }}>
          <span>
            <Spinner /> Regenerating <strong>{imgQueued.length}</strong> image{imgQueued.length === 1 ? "" : "s"} —
            running in order; each thumbnail updates the moment it lands.
          </span>
        </div>
      )}
      {queuedIds.length > 0 && (
        <div className="callout" style={{ margin: "0 0 10px" }}>
          <span>
            <Spinner /> <strong>{queuedIds.length}</strong> clip{queuedIds.length === 1 ? "" : "s"} animating —
            the vendor takes a few minutes each; this updates itself as each one lands.
          </span>
        </div>
      )}
      {rowErr && (
        <div className="callout warn" style={{ margin: "0 0 10px" }}>
          <span>Regenerate failed — {rowErr}</span>
        </div>
      )}
      <div className="sb-table">
        <div className="sb-head" aria-hidden="true">
          <span>#</span>
          <span>Time</span>
          <span>Scene &amp; narration</span>
          <span>Visual</span>
          <span>Actions</span>
        </div>
        {items.map((img, i) => {
          const t = timeline[i]!;
          const medium = img.clipKey ? "Clip" : img.source ? "Real" : "AI";
          const eng = prettyEngine(img.engineServed);
          // the director's intent reads better than the raw prompt when present
          const look = img.directorIntent || (img.source ? (img.entity ?? "archival photo") : (img.prompt ?? ""));
          return (
            <div key={img.id} className="sb-row">
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
                {img.source ? (
                  // archival: no editable prompt — show the subject/source line (now wrapped)
                  look && <div className="look">{look}</div>
                ) : (
                  <textarea
                    className="sb-prompt-edit"
                    value={promptOf(img)}
                    rows={1}
                    placeholder="Generation prompt — click to expand & edit; Image regenerates with it."
                    aria-label={`Generation prompt for shot ${img.idx + 1}`}
                    title={promptOpen[img.id] ? undefined : "Click to expand & edit"}
                    style={promptOpen[img.id] ? undefined : { cursor: "pointer" }}
                    onChange={(e) => setPromptEdits((p) => ({ ...p, [img.id]: e.target.value }))}
                    onFocus={() => setPromptOpen((p) => ({ ...p, [img.id]: true }))}
                    onBlur={() => {
                      savePromptEdit(img);
                      setPromptOpen((p) => ({ ...p, [img.id]: false }));
                    }}
                    ref={(el) => {
                      if (!el) return;
                      if (promptOpen[img.id]) {
                        // expanded: grow to fit the whole prompt
                        el.style.height = "auto";
                        el.style.height = `${el.scrollHeight}px`;
                      } else {
                        // collapsed: a single line (the CSS min-height), rest clipped
                        el.style.height = "";
                      }
                    }}
                  />
                )}
              </div>
              <div className="sb-vis">
                <div
                  className="sb-thumb"
                  role="button"
                  tabIndex={0}
                  style={{ cursor: "zoom-in" }}
                  title={img.clipKey ? "Play this shot's clip" : "View full image"}
                  onClick={() => setPreview(img)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setPreview(img);
                    }
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/media/${imgOverride[img.id] ?? img.storageKey}`} alt={`Shot ${img.idx + 1} visual`} />
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
              <div className="sb-actions">
                <div className="sb-act-line">
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={rowBusy.has(`${img.id}:prompt`)}
                    onClick={() => rowPrompt(img)}
                    title="Regenerate this shot's prompt from the director instructions"
                  >
                    {rowBusy.has(`${img.id}:prompt`) ? (
                      <>
                        <Spinner /> Prompt…
                      </>
                    ) : (
                      "Prompt"
                    )}
                  </button>
                  {/* Character picker is always shown so it's never mistaken for
                      missing; disabled with a hint when the channel has no
                      enabled character (add one on the channel's Characters tab). */}
                  <select
                    value={charOf(img)}
                    onChange={(e) => setCharById((c) => ({ ...c, [img.id]: e.target.value }))}
                    disabled={characters.length === 0}
                    aria-label="Include character"
                    title={
                      characters.length
                        ? "Include a character in this shot"
                        : "No characters on this channel yet — add one on the channel's Characters tab"
                    }
                  >
                    <option value="none">{characters.length ? "No character" : "No characters on this channel"}</option>
                    {characters.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="sb-act-line">
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={rowBusy.has(`${img.id}:image`)}
                    onClick={() =>
                      imgQueued.includes(img.id) && !rowBusy.has(`${img.id}:image`)
                        ? cancelImageRegen(img)
                        : rowRegen(img)
                    }
                    title="Regenerate the image on the selected model, using the prompt above. Stack as many as you like — they queue and run in order; click a queued one to cancel it."
                  >
                    {rowBusy.has(`${img.id}:image`) ? (
                      <>
                        <Spinner /> Image…
                      </>
                    ) : imgQueued.includes(img.id) ? (
                      `✕ Queued #${imgQueued.indexOf(img.id) + 1}`
                    ) : (
                      "Image"
                    )}
                  </button>
                  <select
                    value={imgEngOf(img)}
                    onChange={(e) => setImgEngById((m) => ({ ...m, [img.id]: e.target.value as ImageEngine }))}
                    aria-label="Image model"
                  >
                    {IMG_SHORT.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                {!img.animateHardBlock && (
                  <>
                    <div className="sb-act-line">
                      <button
                        type="button"
                        className="btn ghost"
                        disabled={rowBusy.has(`${img.id}:animate`) || clipState[img.id]?.status === "queued"}
                        onClick={() => rowAnimate(img)}
                        title="Animate this shot on the selected video model (generates in the background)"
                      >
                        {rowBusy.has(`${img.id}:animate`) ? (
                          <>
                            <Spinner /> Queuing…
                          </>
                        ) : clipState[img.id]?.status === "queued" ? (
                          <>
                            <Spinner /> Animating…
                          </>
                        ) : img.clipKey || clipState[img.id]?.status === "done" ? (
                          "Re-animate"
                        ) : (
                          "Animate"
                        )}
                      </button>
                      <select
                        value={vidEngOf(img)}
                        onChange={(e) => setVidEngById((m) => ({ ...m, [img.id]: e.target.value as VideoEngine }))}
                        aria-label="Video model"
                      >
                        {VIDEO_ENGINE_OPTS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      {clipState[img.id]?.status === "queued" && (
                        <button
                          type="button"
                          className="btn ghost"
                          onClick={() => rowCancelAnimate(img)}
                          title="Cancel this animation — stops the worker run; the clip won't land."
                        >
                          ✕ Cancel
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn ghost"
                        disabled={rowBusy.has(`${img.id}:motion`)}
                        onClick={() => rowSuggestMotion(img)}
                        title="Write a motion prompt from this frame; Animate then uses it. Edit the box that appears to steer it."
                      >
                        {rowBusy.has(`${img.id}:motion`) ? (
                          <>
                            <Spinner /> Motion…
                          </>
                        ) : (
                          "✨ Motion"
                        )}
                      </button>
                    </div>
                    {motionByRow[img.id] !== undefined && (
                      <textarea
                        className="sb-prompt-edit"
                        rows={2}
                        value={motionByRow[img.id]}
                        placeholder="Motion prompt — what moves + camera. Animate uses this."
                        aria-label={`Motion prompt for shot ${img.idx + 1}`}
                        onChange={(e) => setMotionByRow((m) => ({ ...m, [img.id]: e.target.value }))}
                        style={{ marginTop: 4 }}
                      />
                    )}
                    {clipState[img.id] && (
                      <div className="sb-clip-status" style={{ fontSize: 12, marginTop: 2 }}>
                        {clipState[img.id]!.status === "queued" && (
                          <span className="muted">
                            <Spinner /> Animating on the vendor — takes a few minutes. This updates itself.
                          </span>
                        )}
                        {clipState[img.id]!.status === "done" && (
                          <span style={{ color: "var(--good, #16a34a)" }}>✓ Clip ready — playing below / click the thumbnail.</span>
                        )}
                        {clipState[img.id]!.status === "failed" && (
                          <span style={{ color: "var(--danger, #dc2626)" }}>✗ Animate failed — {clipState[img.id]!.error}</span>
                        )}
                      </div>
                    )}
                  </>
                )}
                <button type="button" className="btn ghost sb-edit-btn" onClick={() => open(img)}>
                  Edit ▸
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* In-place media preview: image full-size, or the shot's clip played,
          without leaving the board (2026-07-17 operator ask). */}
      <Dialog
        open={!!preview}
        onClose={() => setPreview(null)}
        title={
          preview
            ? `Shot ${preview.idx + 1}${preview.clipKey ? " — clip" : ""}`
            : ""
        }
      >
        {preview && (
          <div style={{ display: "flex", justifyContent: "center" }}>
            {preview.clipKey ? (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video
                src={`/api/media/${preview.clipKey}`}
                controls
                autoPlay
                playsInline
                style={{ maxWidth: "100%", maxHeight: "80vh", borderRadius: 8, background: "#000" }}
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/media/${preview.storageKey}`}
                alt={`Shot ${preview.idx + 1} visual`}
                style={{ maxWidth: "100%", maxHeight: "80vh", borderRadius: 8, objectFit: "contain" }}
              />
            )}
          </div>
        )}
      </Dialog>

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
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
                    <span className="muted" style={{ fontSize: 12 }}>Motion prompt (optional)</span>
                    <button
                      type="button"
                      className="btn ghost sm"
                      disabled={motionBusy}
                      onClick={suggestMotion}
                      title="Write a motion prompt from this frame + its image prompt. Type a direction above first and it'll be honoured."
                    >
                      {motionBusy ? (
                        <>
                          <Spinner /> Suggesting…
                        </>
                      ) : (
                        "✨ Suggest from image"
                      )}
                    </button>
                  </div>
                  <textarea
                    rows={2}
                    placeholder="Optional motion notes — e.g. slow push-in on the pendulum, sparks drifting. Empty uses the shot's own scene brief, or ✨ Suggest one from the image."
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
