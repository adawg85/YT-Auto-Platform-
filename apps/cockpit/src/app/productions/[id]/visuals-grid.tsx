"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@/components/ui";
import {
  cancelClipAction,
  clipStatusAction,
  dedupeRealImagesAction,
  generateShotClipAction,
  reassignShotImageAction,
  removeShotClipAction,
  removeShotImageAction,
  saveShotPromptAction,
  saveShotMotionPromptAction,
  suggestMotionPromptAction,
  queueShotOpAction,
  requeueStalledClipsAction,
} from "../../actions";

/** Inline spinner (reuses the global .spinner). */
const Spinner = () => <span className="spinner" aria-hidden="true" style={{ display: "inline-block", verticalAlign: "-2px" }} />;

/** Live status of one shot's async Animate request. */
type ClipStatus = {
  /** stalled: the durable job row is still open but no worker run is behind it
   * — a dropped run (usually a redeploy). Re-queueable, not a vendor failure. */
  status: "queued" | "done" | "failed" | "stalled";
  idx: number;
  /** the request's unique token — the worker stamps it on the finished clip (and
   * any failure), so the poller confirms THIS animate by exact match. */
  reqToken: string;
  error?: string;
};

// Engine choices for the edit-pane dropdowns. Kept as local literals — the
// @ytauto/core barrel pulls node:crypto and can't be imported into a client
// component — but must stay in sync with IMAGE_ENGINES / VIDEO_ENGINES there.
type ImageEngine = "nano-banana" | "qwen" | "seedream";
type VideoEngine = "wan" | "minimax" | "seedance" | "seedance-pro" | "kling";
const IMAGE_ENGINE_OPTS: { value: ImageEngine; label: string }[] = [
  { value: "nano-banana", label: "Nano Banana (hero)" },
  { value: "qwen", label: "Qwen" },
  { value: "seedream", label: "Seedream" },
];
const VIDEO_ENGINE_OPTS: { value: VideoEngine; label: string }[] = [
  { value: "seedance", label: "Seedance Mini" },
  { value: "seedance-pro", label: "Seedance Pro (cinematic)" },
  { value: "wan", label: "Wan" },
  { value: "minimax", label: "Minimax" },
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
  /** cache-bust stamp for the still (updatedAt ms) — key is deterministic */
  storageVer: number;
  /** cache-bust stamp for the clip (updatedAt ms), null when no clip */
  clipVer: number | null;
  /** real archival image: source page url (null → generated) */
  source: string | null;
  entity: string | null;
  license: string | null;
  prompt: string | null;
  /** the shot's stored MOTION prompt — what Animate sends (2026-08-26: it is
   * persisted now, so a generated one survives navigating away) */
  motionPrompt: string | null;
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
  /** #122: the stored image is a mock PLACEHOLDER SVG, not a real generation —
   * the engine was never able to serve this shot (empty prompt, or every engine
   * failed). It renders as a grey card in the finished video. */
  placeholder: boolean;
  /** stored video clip for this shot (render prefers it over the still) */
  clipKey: string | null;
  /** #112: the clip is operator-recorded footage (never deleted by a regen) */
  operatorClip: boolean;
  /** this shot's on-screen seconds (null until the voiceover is timed) */
  shotSec: number | null;
  /** rough $ for one AI clip of this shot (engine-priced), null when unknown */
  clipEstUsd: number | null;
  /** hard block — no button (only when there's no voiceover to time against) */
  animateHardBlock: string | null;
  /** advisory caution shown ABOVE an enabled button (null = none) */
  animateWarn: string | null;
  /** duplicate flag: same image file used on >1 shot — a short group label
   * (A, B, …) shared by every shot showing that same picture, else null */
  dupGroup: string | null;
};

export function VisualsGrid({
  productionId,
  items,
  characters = [],
  activeJobs = [],
  stalledJobs = [],
}: {
  productionId: string;
  items: VisualItem[];
  characters?: { id: string; name: string }[];
  /** queued/running worker jobs for this production (2026-07-25 operator: the
   * button used to go straight back to clickable with nothing to show) */
  activeJobs?: {
    assetId: string | null;
    op: string;
    status: string;
    /** clip jobs carry the shot idx + this request's token, so the live poller
     * can re-attach to an animate queued before this page load */
    detail?: { idx?: number; reqToken?: string } | null;
  }[];
  /** queued/running rows nothing is coming back for — an Inngest run cancelled
   * by a worker redeploy never closes its row (2026-08-26 operator: animates
   * "say they are queuing but sometimes will stop"). Shown as re-queueable. */
  stalledJobs?: { id: string; assetId: string | null; op: string; detail?: { idx?: number; reqToken?: string } | null }[];
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
  // dialog "Regenerate prompt" queued acknowledgement (the rewrite runs on the
  // worker; the new text lands in the row, not in this open dialog)
  const [promptQueuedNote, setPromptQueuedNote] = useState(false);
  // Inline per-row rapid-fire (2026-07-16): a global model pick + Prompt/Image/
  // Animate buttons on every row that fire INDEPENDENTLY (per-row busy keys), so
  // the operator can click across many shots and let them run concurrently. The
  // page refreshes once, when the last in-flight action settles.
  const [rowBusy, setRowBusy] = useState<Set<string>>(new Set());
  // rows with a queued/running WORKER job also read as busy, so a regenerate
  // stays visibly in flight after the queue call returns (and can't be
  // double-queued) — the button used to go straight back to clickable.
  const jobBusy = new Set(
    activeJobs
      .filter((j) => j.assetId && (j.op === "image" || j.op === "prompt"))
      .map((j) => `${j.assetId}:${j.op}`),
  );
  const isRowBusy = (key: string) => rowBusy.has(key) || jobBusy.has(key);
  // Server-side queue rollups (operator ask, 2026-08-09: prompt rewrites should
  // flag as in-queue like images/clips do — they always queued on the worker,
  // but nothing SHOWED it): counts drive a banner + per-row "In queue" labels,
  // and the SSE live-refresh now watches shot_jobs so these update themselves.
  const promptJobsActive = activeJobs.filter((j) => j.op === "prompt").length;
  const fillJobActive = activeJobs.some((j) => j.op === "fill-prompts");
  // When a queued prompt rewrite LANDS (its job leaves activeJobs on a refresh),
  // drop any stale local edit for that row so the fresh server prompt shows —
  // promptEdits used to mask a landed rewrite indefinitely.
  const prevPromptJobIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    const current = new Set(
      activeJobs.filter((j) => j.op === "prompt" && j.assetId).map((j) => j.assetId as string),
    );
    for (const id of prevPromptJobIds.current) {
      if (!current.has(id)) {
        setPromptEdits((prev) => {
          if (!(id in prev)) return prev;
          const n = { ...prev };
          delete n[id];
          return n;
        });
      }
    }
    prevPromptJobIds.current = current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJobs]);
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
  // Animates are durable server-side jobs now, so their in-flight state no
  // longer lives only in this tab (2026-08-26 operator: queued clips "say they
  // are queuing but sometimes will stop"). Seeding clipState from the server's
  // own rows means the "Animating…" state — and the poller behind it — come
  // back after navigating away, in a new tab, or on another device, instead of
  // the row reading as idle while the worker is still generating.
  const serverClipJobs = activeJobs.filter(
    (j) => j.op === "clip" && j.assetId && typeof j.detail?.idx === "number" && j.detail?.reqToken,
  );
  const serverClipKey = serverClipJobs.map((j) => `${j.assetId}:${j.detail!.reqToken}`).join(",");
  useEffect(() => {
    if (!serverClipKey) return;
    setClipState((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const j of serverClipJobs) {
        const id = j.assetId!;
        // never clobber a local entry that already resolved this same request
        if (next[id]?.reqToken === j.detail!.reqToken) continue;
        next[id] = { status: "queued", idx: j.detail!.idx!, reqToken: j.detail!.reqToken! };
        changed = true;
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverClipKey]);
  const stalledClips = stalledJobs.filter((j) => j.op === "clip");
  const [requeuing, setRequeuing] = useState(false);
  const requeueStalled = () => {
    if (requeuing) return;
    setRequeuing(true);
    setRowErr(null);
    requeueStalledClipsAction(productionId)
      .then((res) => {
        if (res.error) setRowErr(res.error);
        router.refresh();
      })
      .catch((e) => setRowErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setRequeuing(false));
  };
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
  // per-row motion prompt EDITS. The stored `img.motionPrompt` is the fallback,
  // so a prompt written by ✨ Motion is still there after navigating away
  // (2026-08-26 operator: "the generate video prompt works but can disappear" —
  // it used to live only here, and this map starts empty on every page load).
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
  /** the motion prompt this row would animate with — a live edit, else the one
   * stored on the shot. `undefined` = none yet, so the box stays hidden. */
  const motionOf = (img: VisualItem): string | undefined => motionByRow[img.id] ?? img.motionPrompt ?? undefined;

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
    if (isRowBusy(key)) return;
    setRowErr(null);
    setBusyKey(key, true);
    inflight.current += 1;
    // queued on the WORKER so it survives you leaving the page (2026-07-25 operator)
    queueShotOpAction(productionId, "prompt", { assetId: img.id })
      .then((res) => {
        if (res.error) setRowErr(res.error);
        // queued on the worker — the refresh below picks up the job row, the
        // button flips to "In queue…", and the SSE push repaints when it lands
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
    queueShotOpAction(productionId, "image", {
      assetId: id,
      mode: engine === "nano-banana" ? "hero" : "standard",
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
    if (isRowBusy(key)) return;
    setBusyKey(key, true);
    setClipState((s) => {
      const n = { ...s };
      delete n[img.id];
      return n;
    });
    const motion = motionOf(img)?.trim() || undefined;
    generateShotClipAction(productionId, img.id, { engine: vidEngOf(img), ...(motion ? { prompt: motion } : {}) })
      .then((res) => {
        if (res?.error || !res?.reqToken) {
          setClipState((s) => ({ ...s, [img.id]: { status: "failed", idx: img.idx, reqToken: "", error: res?.error ?? "couldn't queue" } }));
        } else {
          setClipState((s) => ({ ...s, [img.id]: { status: "queued", idx: img.idx, reqToken: res.reqToken! } }));
        }
      })
      .catch((e) => setClipState((s) => ({ ...s, [img.id]: { status: "failed", idx: img.idx, reqToken: "", error: String(e) } })))
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
  // #112: operator-recorded FOOTAGE for one shot. Chunked upload (video files
  // are exactly what the ~20MB per-request platform cap bites) → the worker
  // trims/scales it to the shot window and attaches the clip; the existing
  // Animate poller (reqToken) drives the row to done.
  const footageInputRef = useRef<HTMLInputElement>(null);
  const footageTarget = useRef<VisualItem | null>(null);
  const [footageBusy, setFootageBusy] = useState<Set<string>>(new Set());
  const rowFootage = (img: VisualItem) => {
    footageTarget.current = img;
    footageInputRef.current?.click();
  };
  const FOOTAGE_CHUNK = 8 * 1024 * 1024;
  async function uploadFootage(img: VisualItem, file: File): Promise<{ error?: string; reqToken?: string }> {
    const uploadId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    const total = Math.max(1, Math.ceil(file.size / FOOTAGE_CHUNK));
    for (let seq = 0; seq < total; seq++) {
      const part = file.slice(seq * FOOTAGE_CHUNK, Math.min(file.size, (seq + 1) * FOOTAGE_CHUNK));
      const fd = new FormData();
      fd.append("productionId", productionId);
      fd.append("shotIdx", String(img.idx));
      fd.append("chunk", part);
      fd.append("uploadId", uploadId);
      fd.append("seq", String(seq));
      const isLast = seq === total - 1;
      fd.append("last", String(isLast));
      if (isLast) {
        fd.append("totalBytes", String(file.size));
        fd.append("fileName", file.name);
        fd.append("mime", file.type || "");
      }
      const res = await fetch("/api/shot-footage", { method: "POST", body: fd });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        return { error: body?.error ?? `upload failed (${res.status}) on part ${seq + 1}/${total}` };
      }
      if (isLast) {
        const body = (await res.json().catch(() => null)) as { reqToken?: string } | null;
        return { reqToken: body?.reqToken };
      }
    }
    return {};
  }
  const onFootageFile = async (files: FileList | null) => {
    const img = footageTarget.current;
    if (!files?.length || !img) return;
    const file = files[0]!;
    if (footageInputRef.current) footageInputRef.current.value = "";
    setRowErr(null);
    setFootageBusy((prev) => new Set(prev).add(img.id));
    try {
      const res = await uploadFootage(img, file);
      if (res.error) setRowErr(`Shot ${img.idx + 1}: ${res.error}`);
      else if (res.reqToken) {
        // hand off to the existing clip poller — same queued → done lifecycle
        setClipState((s) => ({ ...s, [img.id]: { status: "queued", idx: img.idx, reqToken: res.reqToken! } }));
      }
    } catch (e) {
      setRowErr(`Shot ${img.idx + 1}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setFootageBusy((prev) => {
        const n = new Set(prev);
        n.delete(img.id);
        return n;
      });
    }
  };
  // Inline "✨ Motion": write a motion prompt from this frame + its image prompt
  // (the current text, if any, steers it). Reveals an editable box that Animate
  // then uses. Same agent as the dialog's Suggest button.
  const rowSuggestMotion = (img: VisualItem) => {
    const key = `${img.id}:motion`;
    if (isRowBusy(key)) return;
    setRowErr(null);
    setBusyKey(key, true);
    suggestMotionPromptAction(productionId, img.id, motionOf(img)?.trim() || undefined)
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
          const res = await clipStatusAction(productionId, c.idx, c.reqToken);
          if (cancelled) return;
          if (res.status === "done") {
            setClipState((s) => (s[id] ? { ...s, [id]: { ...s[id]!, status: "done" } } : s));
            router.refresh();
          } else if (res.status === "failed" || res.status === "stalled") {
            setClipState((s) =>
              s[id] ? { ...s, [id]: { ...s[id]!, status: res.status as "failed" | "stalled", error: res.error } } : s,
            );
            if (res.status === "stalled") router.refresh(); // surfaces the Re-queue banner
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
  // same for the motion prompt — an edit that is never blurred is still safe,
  // because ✨ Motion persists what it writes server-side
  const saveMotionEdit = (img: VisualItem) => {
    const edited = motionByRow[img.id];
    if (edited === undefined || edited.trim() === (img.motionPrompt ?? "").trim()) return;
    void saveShotMotionPromptAction(productionId, img.id, edited);
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
    // seed from what is stored, not "" — reopening a shot used to throw away a
    // motion prompt the operator had already generated (2026-08-26)
    setMotionPrompt(it.motionPrompt ?? "");
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

  // Drop this shot's animated clip and render the still instead (2026-07-20
  // operator). Keeps the image; the render falls back to the still with no clip.
  const useStill = () => {
    if (!openItem) return;
    setBusy("usestill");
    setError(null);
    startTransition(async () => {
      const res = await removeShotClipAction(productionId, openItem.id);
      setBusy(null);
      if (res.error) {
        setError(res.error);
        return;
      }
      setClipRemoved(true);
      setSwapCount((n) => n + 1); // render is now stale → "Retry from render"
      setOpenItem(null);
      router.refresh();
    });
  };

  // Move this image (and its clip) to another shot, no regeneration — fixes a
  // shot that drifted out of sync with the narration (2026-07-20 operator).
  const moveTo = (targetIdx: number) => {
    if (!openItem || targetIdx === openItem.idx) return;
    setBusy("move");
    setError(null);
    startTransition(async () => {
      const res = await reassignShotImageAction(productionId, openItem.id, targetIdx);
      setBusy(null);
      if (res.error) {
        setError(res.error);
        return;
      }
      setSwapCount((n) => n + 1); // the render is now stale → "Retry from render"
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
      const res = await queueShotOpAction(
        productionId,
        "image",
        {
          assetId: openItem.id,
          mode: mode === "real" ? "real" : regenEngine === "nano-banana" ? "hero" : "standard",
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
      const res = await queueShotOpAction(productionId, "prompt", { assetId: openItem.id });
      setPromptBusy(false);
      if (res.error) {
        setError(res.error);
        return;
      }
      setPromptQueuedNote(true);
      router.refresh();
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
  // #122: shots holding a mock placeholder SVG instead of a real generation
  const placeholders = items.filter((i) => i.placeholder);
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
      {/* #122: a placeholder is not a quality problem, it is a missing image —
          state it above every other advisory on this tab. */}
      {placeholders.length > 0 && (
        <div className="callout crit" style={{ margin: "0 0 10px" }}>
          <span>
            <strong>{placeholders.length}</strong> shot{placeholders.length === 1 ? "" : "s"} (
            {placeholders.map((p) => `#${p.idx + 1}`).join(", ")}) hold a{" "}
            <strong>placeholder</strong>, not a real image — no engine served them (an empty prompt,
            or every configured engine failed). Regenerate each one before approving the visuals
            gate; approving ships the grey card in the finished video.
          </span>
        </div>
      )}
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
            disabled={filling || fillJobActive}
            onClick={() => {
              setFillMsg(null);
              startFill(async () => {
                const res = await queueShotOpAction(productionId, "fill-prompts");
                if (res.error) setFillMsg(res.error);
                else setFillMsg("Queued on the server — prompts appear here as they land. Safe to leave this page.");
                router.refresh();
              });
            }}
          >
            {filling || fillJobActive ? (
              <>
                <Spinner /> Writing prompts…
              </>
            ) : (
              `Fill ${thinCount} thin prompt${thinCount === 1 ? "" : "s"}`
            )}
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
            they run one at a time and the vendor takes a few minutes each. Queued on the server, so it is safe to
            leave this page; this updates itself as each one lands.
          </span>
        </div>
      )}
      {stalledClips.length > 0 && (
        <div className="callout warn" style={{ margin: "0 0 10px", flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ flex: "1 1 260px" }}>
            <strong>{stalledClips.length}</strong> animate{stalledClips.length === 1 ? "" : "s"} stopped before
            producing a clip — the worker run was dropped (most often a redeploy), so nothing is coming for{" "}
            {stalledClips.length === 1 ? "it" : "them"}. Re-queue to run {stalledClips.length === 1 ? "it" : "them"}{" "}
            again — that re-bills one clip generation{stalledClips.length === 1 ? "" : " each"} and leaves the existing
            images and clips untouched.
          </span>
          <button type="button" className="btn ghost" disabled={requeuing} onClick={requeueStalled} style={{ flex: "none" }}>
            {requeuing ? (
              <>
                <Spinner /> Re-queuing…
              </>
            ) : (
              `Re-queue ${stalledClips.length} animate${stalledClips.length === 1 ? "" : "s"}`
            )}
          </button>
        </div>
      )}
      {promptJobsActive > 0 && (
        <div className="callout" style={{ margin: "0 0 10px" }}>
          <span>
            <Spinner /> <strong>{promptJobsActive}</strong> prompt rewrite{promptJobsActive === 1 ? "" : "s"} queued
            on the server — running in order; each row updates as its new prompt lands. Safe to leave this page.
          </span>
        </div>
      )}
      {fillJobActive && (
        <div className="callout" style={{ margin: "0 0 10px" }}>
          <span>
            <Spinner /> Thin prompts are being filled on the server — they appear here as they land.
          </span>
        </div>
      )}
      {rowErr && (
        <div className="callout warn" style={{ margin: "0 0 10px" }}>
          <span>Regenerate failed — {rowErr}</span>
        </div>
      )}
      {/* #112: shared picker for the per-row Footage buttons */}
      <input
        ref={footageInputRef}
        type="file"
        accept="video/mp4,video/quicktime,video/webm,video/x-m4v,.mp4,.mov,.webm,.m4v"
        hidden
        onChange={(e) => void onFootageFile(e.target.files)}
      />
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
          const medium = img.operatorClip ? "Footage" : img.clipKey ? "Clip" : img.source ? "Real" : "AI";
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
                {(img.hero || img.character || img.shotScale || img.dupGroup) && (
                  <div className="top">
                    {img.dupGroup && (
                      <span
                        className="chip warn"
                        title={`Duplicate ${img.dupGroup}: this shot repeats another (same narration line or same image file). Find the matching "Duplicate ${img.dupGroup}" shot and move/swap or cut one so each shot is unique.`}
                      >
                        Duplicate {img.dupGroup}
                      </span>
                    )}
                    {img.hero && <span className="chip">hero</span>}
                    {img.shotScale && <span className="chip">{img.shotScale}</span>}
                    {img.character && <span className="chip acc">{img.character}</span>}
                  </div>
                )}
                <p>{img.narration ?? <span className="muted">(no narration recorded for this shot)</span>}</p>
                {/* archival shots keep their subject/source line ABOVE the
                    prompt box — the box is no longer hidden on them (2026-08-26
                    operator: "I keep generating prompts for images … real ones I
                    want to replace, they say they queue but don't persist").
                    The per-row Prompt button was always enabled on an archival
                    shot and the worker DID persist what it wrote — there was
                    simply nowhere on the row for it to appear, so a rewrite the
                    operator paid for read as lost work every time. Showing the
                    box makes that prompt visible and editable, and Image
                    regenerates the shot from it — which is how an archival photo
                    gets replaced with a generated one. */}
                {img.source && look && <div className="look">{look}</div>}
                <textarea
                  className="sb-prompt-edit"
                  value={promptOf(img)}
                  rows={1}
                  placeholder={
                    img.source
                      ? "No generation prompt yet — “Prompt” writes one; “Image” then replaces this archival photo with it."
                      : "Generation prompt — click to expand & edit; Image regenerates with it."
                  }
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
                  <img src={`/api/media/${imgOverride[img.id] ?? img.storageKey}?v=${img.storageVer}`} alt={`Shot ${img.idx + 1} visual`} />
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
                  {/* #122: not an image at all — a mock placeholder card. Loudest
                      badge in the row; it ships as a grey frame if approved. */}
                  {img.placeholder && (
                    <span
                      className="chip crit"
                      title="PLACEHOLDER — no image engine served this shot (an empty prompt, or every configured engine failed). Regenerate it before approving the visuals gate; approving ships this grey card in the video."
                    >
                      Placeholder
                    </span>
                  )}
                </div>
              </div>
              <div className="sb-actions">
                <div className="sb-act-line">
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={isRowBusy(`${img.id}:prompt`)}
                    onClick={() => rowPrompt(img)}
                    title={
                      img.source
                        ? "Write a generation prompt for this shot from the director instructions — it lands in the box on the left, and “Image” then replaces this archival photo with a generated one"
                        : "Regenerate this shot's prompt from the director instructions"
                    }
                  >
                    {rowBusy.has(`${img.id}:prompt`) ? (
                      <>
                        <Spinner /> Prompt…
                      </>
                    ) : jobBusy.has(`${img.id}:prompt`) ? (
                      <>
                        <Spinner /> In queue…
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
                    disabled={isRowBusy(`${img.id}:image`)}
                    onClick={() =>
                      imgQueued.includes(img.id) && !isRowBusy(`${img.id}:image`)
                        ? cancelImageRegen(img)
                        : rowRegen(img)
                    }
                    title="Regenerate the image on the selected model, using the prompt above. Stack as many as you like — they queue and run in order; click a queued one to cancel it."
                  >
                    {isRowBusy(`${img.id}:image`) ? (
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
                        disabled={isRowBusy(`${img.id}:animate`) || clipState[img.id]?.status === "queued"}
                        onClick={() => rowAnimate(img)}
                        title="Animate this shot on the selected video model (generates in the background)"
                      >
                        {isRowBusy(`${img.id}:animate`) ? (
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
                        disabled={isRowBusy(`${img.id}:motion`)}
                        onClick={() => rowSuggestMotion(img)}
                        title="Write a motion prompt from this frame; Animate then uses it. Edit the box that appears to steer it."
                      >
                        {isRowBusy(`${img.id}:motion`) ? (
                          <>
                            <Spinner /> Motion…
                          </>
                        ) : (
                          "✨ Motion"
                        )}
                      </button>
                      <button
                        type="button"
                        className="btn ghost"
                        disabled={footageBusy.has(img.id)}
                        onClick={() => rowFootage(img)}
                        title="Attach YOUR OWN recorded footage to this shot (mp4/mov/webm, up to 150MB — uploads in parts). The worker trims it to the shot window; the render plays it instead of the still."
                      >
                        {footageBusy.has(img.id) ? (
                          <>
                            <Spinner /> Uploading…
                          </>
                        ) : img.operatorClip ? (
                          "Replace footage"
                        ) : (
                          "Footage"
                        )}
                      </button>
                    </div>
                    {motionOf(img) !== undefined && (
                      <textarea
                        className="sb-prompt-edit"
                        rows={2}
                        value={motionOf(img) ?? ""}
                        placeholder="Motion prompt — what moves + camera. Animate uses this."
                        aria-label={`Motion prompt for shot ${img.idx + 1}`}
                        onChange={(e) => setMotionByRow((m) => ({ ...m, [img.id]: e.target.value }))}
                        onBlur={() => saveMotionEdit(img)}
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
                        {clipState[img.id]!.status === "stalled" && (
                          <span style={{ color: "var(--danger, #dc2626)" }}>
                            ✗ Animate stopped before making a clip — {clipState[img.id]!.error} Use “Re-queue” above,
                            or click Animate again.
                          </span>
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
                src={`/api/media/${preview.clipKey}?v=${preview.clipVer ?? ""}`}
                controls
                autoPlay
                playsInline
                style={{ maxWidth: "100%", maxHeight: "80vh", borderRadius: 8, background: "#000" }}
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/media/${preview.storageKey}?v=${preview.storageVer}`}
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
              src={`/api/media/${openItem.storageKey}?v=${openItem.storageVer}`}
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

            {/* Move this image to another shot — reuse it as-is (no regeneration).
                Fixes an image that drifted out of sync with the narration; swaps
                with whatever image is already in the chosen shot. */}
            <div>
              <label className="field-label" htmlFor="move-shot" style={{ marginBottom: 4 }}>
                Move this image to another shot{" "}
                <span className="muted" style={{ fontWeight: 500 }}>
                  — reuse it as-is, no regeneration (swaps with the image already there)
                </span>
              </label>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <select
                  id="move-shot"
                  value={openItem.idx}
                  disabled={pending}
                  onChange={(e) => moveTo(Number(e.target.value))}
                  style={{ height: 34 }}
                >
                  {items.map((it) => (
                    <option key={it.idx} value={it.idx}>
                      Shot {it.idx + 1}
                      {it.idx === openItem.idx ? " (current)" : ""}
                    </option>
                  ))}
                </select>
                {busy === "move" && (
                  <span className="muted" style={{ fontSize: 12 }}>
                    Moving…
                  </span>
                )}
              </div>
            </div>

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
              {promptQueuedNote && (
                <p className="muted" style={{ margin: "4px 0 0", fontSize: 12.5 }}>
                  Rewrite queued on the server — the new prompt lands in the row (and here on reopen). Safe to close this dialog or leave the page.
                </p>
              )}
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
                  src={`/api/media/${openItem.clipKey}?v=${openItem.clipVer ?? ""}`}
                  muted
                  controls
                  preload="metadata"
                  style={{ width: "100%", maxHeight: 200, borderRadius: 8, border: "1px solid var(--border)", marginBottom: 8 }}
                />
              )}
              {openItem.clipKey && (
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={pending}
                  onClick={useStill}
                  title="Delete this shot's animated clip so the render uses the static image instead. The image is kept."
                  style={{ marginBottom: 8 }}
                >
                  {busy === "usestill" ? "Removing clip…" : "Use the still instead — remove clip"}
                </button>
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
                    onBlur={() => {
                      if (!openItem) return;
                      if (motionPrompt.trim() === (openItem.motionPrompt ?? "").trim()) return;
                      void saveShotMotionPromptAction(productionId, openItem.id, motionPrompt);
                    }}
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
