"use client";

import { useState } from "react";
import type { VoiceOption } from "@ytauto/providers";
import type { ProductionProfile } from "@ytauto/db";
import { AXIS_OPTIONS } from "@/lib/axis-options";
import { useRefreshHold } from "@/lib/refresh-guard";
import { VoicePicker } from "../voice-picker";

/**
 * Production Profile dashboard (BACKLOG #18) — the per-channel control plane.
 * A tile-picker per axis (visual style · motion · rhythm · captions · music ·
 * persona voice+delivery) with a live 9:16/16:9 preview that reacts to the
 * selection, plus free-text art-direction/notes. Submits to
 * updateProductionProfileAction. Options tagged "soon" are scaffold — the
 * choice is stored and the pipeline honours each axis as that feature ships.
 */

type Fmt = { value: string; label: string; hint: string; tag: "live" | "soon" };
type AxisKey = "visualMode" | "motion" | "rhythm" | "captions" | "music" | "delivery";

const AXIS_KEYS: AxisKey[] = ["visualMode", "motion", "rhythm", "captions", "music", "delivery"];
/** which options are scaffold-only — everything else in the shared vocabulary is live */
const SOON: Partial<Record<AxisKey, string[]>> = {
  visualMode: ["simple"],
  music: ["subtle", "standard"],
};
// labels + hints come from the SHARED vocabulary (lib/axis-options) so this
// tab and the per-video profile gate can never drift apart (2026-07-14)
const OPTS = Object.fromEntries(
  AXIS_KEYS.map((k) => [
    k,
    (AXIS_OPTIONS[k] ?? []).map((o) => ({
      ...o,
      tag: SOON[k]?.includes(o.value) ? "soon" : "live",
    })),
  ]),
) as Record<AxisKey, Fmt[]>;
const LABEL = (key: AxisKey, v: string) => OPTS[key].find((o) => o.value === v)?.label ?? v;
const TAG = (key: AxisKey, v: string) => OPTS[key].find((o) => o.value === v)?.tag;

const S = (p: React.SVGProps<SVGSVGElement> = {}) => ({
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  ...p,
});

/** Ranked engine guidance surfaced as an in-panel info popup (2026-07-16) so the
 * operator remembers which model fits which situation, per channel. Ordered
 * best→worst by quality; cost + when-to-use per row. */
type GuideRow = { rank: number; name: string; cost: string; use: string; needs?: string };
const IMAGE_GUIDE: GuideRow[] = [
  { rank: 1, name: "Nano Banana (Gemini)", cost: "$0.134/img", use: "Best identity, realism, text & real-world accuracy — hero shots, thumbnails, character faces. Priciest, so not for everything." },
  { rank: 2, name: "Seedream (ByteDance)", cost: "$0.03/img", use: "Near-Nano photoreal & composition, great on-model with a reference image. Bulk shots you want prettier than Qwen.", needs: "ARK_API_KEY" },
  { rank: 3, name: "Qwen-Image (Alibaba)", cost: "$0.025/img", use: "Cheapest, strong text, solid quality. High-volume filler where cost wins — the safe default." },
];
const VIDEO_GUIDE: GuideRow[] = [
  { rank: 1, name: "Kling (Kuaishou)", cost: "~$0.075/s", use: "Premium cinematic quality (up to 4K), best camera work & prompt adherence. Showcase / hero videos where quality justifies the cost.", needs: "KLING keys" },
  { rank: 2, name: "Seedance (ByteDance)", cost: "~$0.06/s", use: "Best keyframe identity/style preservation — character clips where the subject must stay on-model.", needs: "ARK_API_KEY" },
  { rank: 3, name: "Hailuo (Minimax)", cost: "~$0.045/s", use: "Smoothest natural motion & camera moves — a polished general-purpose animator.", needs: "MINIMAX_API_KEY" },
  { rank: 4, name: "Wan (Alibaba)", cost: "~$0.05/s", use: "Cheapest, reliable keyframe i2v. Bulk/filler motion — the default (no extra key)." },
];

function EngineGuide({ title, rows }: { title: string; rows: GuideRow[] }) {
  return (
    <details className="pp-note" style={{ marginTop: 8 }}>
      <summary>
        <svg {...S()}>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4M12 8h.01" />
        </svg>
        {title}
      </summary>
      <div className="nb" style={{ display: "grid", gap: 10 }}>
        {rows.map((r) => (
          <div key={r.name} style={{ fontSize: 12.5, lineHeight: 1.4 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <strong>
                {r.rank}. {r.name}
              </strong>
              <span className="chip" style={{ fontSize: 11 }}>{r.cost}</span>
              {r.needs && (
                <span className="muted" style={{ fontSize: 11 }}>needs {r.needs}</span>
              )}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>{r.use}</div>
          </div>
        ))}
        <div className="muted" style={{ fontSize: 11.5, fontStyle: "italic" }}>
          Best → worst by quality. Hero images + thumbnails always use Nano Banana regardless of the
          bulk engine picked above.
        </div>
      </div>
    </details>
  );
}

/** small preview art inside a tile / the big frame */
function Art({ mode }: { mode: string }) {
  const inner: Record<string, React.ReactNode> = {
    simple: (
      <svg {...S({ strokeWidth: 1.6 })}>
        <circle cx="12" cy="7" r="3" />
        <path d="M12 10v7M8 21l4-4 4 4M7 13h10" />
      </svg>
    ),
    real_footage: (
      <svg {...S({ strokeWidth: 1.8 })}>
        <path d="M3 17l5-6 4 4 3-3 6 5" />
        <circle cx="8" cy="8" r="1.6" />
      </svg>
    ),
    ai_images: (
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2l1.8 4.6L18.5 8l-4.7 1.4L12 14l-1.8-4.6L5.5 8l4.7-1.4z" />
        <circle cx="18" cy="17" r="1.4" />
        <circle cx="6" cy="16" r="1" />
      </svg>
    ),
    ai_video: (
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M8 5v14l11-7z" />
      </svg>
    ),
    mixed: (
      <svg {...S({ strokeWidth: 1.8 })}>
        <path d="M4 16l4-5 3 3M13 8l3-2 4 6" />
      </svg>
    ),
  };
  const cls = ["simple", "real_footage", "ai_images", "ai_video", "mixed"].includes(mode) ? mode : "mixed";
  return <div className={`pp-art ${cls}`}>{inner[cls]}</div>;
}

/** the art shown on a tile for a given axis+value */
function TileArt({ axis, v }: { axis: AxisKey; v: string }) {
  if (axis === "visualMode") return <Art mode={v} />;
  if (axis === "motion")
    return v === "static" ? (
      <div className="pp-art simple">
        <svg {...S({ strokeWidth: 1.8 })}>
          <rect x="4" y="4" width="16" height="16" rx="2" />
        </svg>
      </div>
    ) : (
      <div className="pp-art ai_video">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5v14l11-7z" />
        </svg>
      </div>
    );
  if (axis === "captions")
    return (
      <div className={`pp-art ${v === "on" ? "ai_images" : "simple"}`}>
        <svg {...S()}>
          <rect x="3" y="6" width="18" height="12" rx="2" />
          {v === "on" && <path d="M7 12h3M13 12h4" />}
        </svg>
      </div>
    );
  if (axis === "music")
    return (
      <div className={`pp-art ${v === "off" ? "simple" : "ai_video"}`}>
        <svg {...S({ strokeWidth: 1.8 })}>
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
          {v === "off" && <path d="M4 20L20 4" />}
        </svg>
      </div>
    );
  if (axis === "delivery")
    return (
      <div className="pp-art real_footage">
        <svg {...S({ strokeWidth: 1.8 })}>
          <path d="M4 12h2l2 5 4-14 2 9h6" />
        </svg>
      </div>
    );
  // rhythm: tick marks
  const n = v === "sentence" ? 5 : v === "section" ? 2 : 4;
  return (
    <div className="pp-art simple">
      <svg viewBox="0 0 24 24" fill="currentColor">
        {Array.from({ length: n }).map((_, i) => (
          <rect key={i} x={3 + i * 4} y="6" width="2" height="12" rx="1" />
        ))}
      </svg>
    </div>
  );
}

function TileRow({
  axis,
  value,
  onPick,
}: {
  axis: AxisKey;
  value: string;
  onPick: (v: string) => void;
}) {
  return (
    <div className="pp-tiles">
      {OPTS[axis].map((o) => (
        <button
          key={o.value}
          type="button"
          className={`pp-tile${value === o.value ? " on" : ""}`}
          aria-pressed={value === o.value}
          title={o.hint}
          onClick={() => onPick(o.value)}
        >
          <div className="pp-ck">
            <svg {...S({ strokeWidth: 3 })}>
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </div>
          <div className="pp-prev">
            <TileArt axis={axis} v={o.value} />
          </div>
          <div className="tl">{o.label}</div>
          <div className="tg">
            <span className={`pp-tag ${o.tag}`}>{o.tag}</span>
          </div>
        </button>
      ))}
    </div>
  );
}

export function ProductionProfilePanel({
  profile: init,
  contentFormat,
  voices,
  currentVoiceId,
  action,
}: {
  /** already resolved on the server (defaults merged) so this stays client-safe */
  profile: ProductionProfile;
  contentFormat: string;
  voices: VoiceOption[];
  currentVoiceId: string | null;
  action: (formData: FormData) => void | Promise<void>;
}) {
  const [visualMode, setVisualMode] = useState(init.visualMode);
  const [motion, setMotion] = useState(init.motion);
  const [rhythm, setRhythm] = useState(init.rhythm);
  const [imageDensity, setImageDensity] = useState(init.imageDensity ?? "standard");
  const [visualDirector, setVisualDirector] = useState(init.visualDirector ? "on" : "off");
  const [captions, setCaptions] = useState(init.captions ? "on" : "off");
  const [music, setMusic] = useState(init.music);
  const [delivery, setDelivery] = useState(init.delivery);
  const [archival, setArchival] = useState(init.archivalStrength ?? "balanced");
  // fal retired 2026-07-14: legacy stored "fal"/"mixed" display as the qwen default
  const normImg = (v: string | undefined, d: string) =>
    v === "nano-banana" || v === "seedream" || v === "qwen" ? v : d;
  // per-role image engines (2026-07-16): bulk/filler + hero + character + thumbnail
  const [imageEngine, setImageEngine] = useState(normImg(init.imageEngine, "qwen"));
  const [heroImageEngine, setHeroImageEngine] = useState(normImg(init.heroImageEngine, "nano-banana"));
  const [characterImageEngine, setCharacterImageEngine] = useState(normImg(init.characterImageEngine, "nano-banana"));
  const [thumbnailImageEngine, setThumbnailImageEngine] = useState(normImg(init.thumbnailImageEngine, "nano-banana"));
  const [videoEngine, setVideoEngine] = useState(init.videoEngine ?? "wan");
  // "" = same as filler; else a specific engine for character clips
  const [characterVideoEngine, setCharacterVideoEngine] = useState(init.characterVideoEngine ?? "");
  const [heroVideoEngine, setHeroVideoEngine] = useState(init.heroVideoEngine ?? "");
  // "" = use the VIDEO_MAX_AI_CLIPS default; else a per-video cap
  const [maxAiClips, setMaxAiClips] = useState(
    init.maxAiClips != null ? String(init.maxAiClips) : "",
  );

  // Live-refresh (SSE / 20s backstop) remounts this panel and re-seeds every
  // useState from server props — which would silently revert an in-progress
  // edit before the operator clicks Save. Hold refresh while the form is dirty
  // or focused (focus covers the uncontrolled art-direction / notes textareas).
  const [focused, setFocused] = useState(false);
  const dirty =
    visualMode !== init.visualMode ||
    motion !== init.motion ||
    rhythm !== init.rhythm ||
    imageDensity !== (init.imageDensity ?? "standard") ||
    visualDirector !== (init.visualDirector ? "on" : "off") ||
    captions !== (init.captions ? "on" : "off") ||
    music !== init.music ||
    delivery !== init.delivery ||
    archival !== (init.archivalStrength ?? "balanced") ||
    imageEngine !== normImg(init.imageEngine, "qwen") ||
    heroImageEngine !== normImg(init.heroImageEngine, "nano-banana") ||
    characterImageEngine !== normImg(init.characterImageEngine, "nano-banana") ||
    thumbnailImageEngine !== normImg(init.thumbnailImageEngine, "nano-banana") ||
    videoEngine !== (init.videoEngine ?? "wan") ||
    characterVideoEngine !== (init.characterVideoEngine ?? "") ||
    heroVideoEngine !== (init.heroVideoEngine ?? "") ||
    maxAiClips !== (init.maxAiClips != null ? String(init.maxAiClips) : "");
  useRefreshHold(dirty || focused);

  const isLong = contentFormat === "long";
  const st = { visualMode, motion, rhythm, captions, music, delivery } as Record<AxisKey, string>;
  const voiceName = voices.find((v) => v.id === (currentVoiceId ?? ""))?.name ?? currentVoiceId ?? "default";

  // rough est. — illustrative, mirrors the pipeline's relative tool costs
  let cost = 0.2; // voice baseline
  // bulk-image bump scales with the engine (~30 shots: Qwen .025 / nano .039)
  const bulkImages = imageEngine === "nano-banana" ? 1.2 : imageEngine === "seedream" ? 1.2 : 0.75;
  if (visualMode === "ai_images") cost += bulkImages;
  else if (visualMode === "ai_video") cost += 0.9;
  else if (visualMode === "mixed") cost += bulkImages * 0.6;
  // AI beat clips: up to the clip budget (full) / ~3 hero (key beats) × ~5s × rate
  const clipPerSec = videoEngine === "minimax" ? 0.045 : videoEngine === "seedance" ? 0.06 : 0.05;
  const clipBudget = maxAiClips && Number.isFinite(Number(maxAiClips)) ? Number(maxAiClips) : 12;
  if (motion === "ai_video") cost += clipBudget * 5 * clipPerSec;
  else if (motion === "partial") cost += Math.min(3, clipBudget) * 5 * clipPerSec;
  if (music !== "off") cost += 0.04;
  const render = motion === "ai_video" ? "slow render" : motion === "partial" ? "medium render" : "fast render";

  const recipe: [string, AxisKey][] = [
    ["Visual style", "visualMode"],
    ["Motion", "motion"],
    ["Rhythm", "rhythm"],
    ["Captions", "captions"],
    ["Music", "music"],
    ["Delivery", "delivery"],
  ];

  return (
    <form
      action={action}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      {/* hidden inputs carry the live selection to the server action */}
      <input type="hidden" name="visualMode" value={visualMode} />
      <input type="hidden" name="motion" value={motion} />
      <input type="hidden" name="rhythm" value={rhythm} />
      <input type="hidden" name="imageDensity" value={imageDensity} />
      <input type="hidden" name="visualDirector" value={visualDirector} />
      <input type="hidden" name="captions" value={captions} />
      <input type="hidden" name="music" value={music} />
      <input type="hidden" name="delivery" value={delivery} />
      <input type="hidden" name="archivalStrength" value={archival} />
      <input type="hidden" name="imageEngine" value={imageEngine} />
      <input type="hidden" name="heroImageEngine" value={heroImageEngine} />
      <input type="hidden" name="characterImageEngine" value={characterImageEngine} />
      <input type="hidden" name="thumbnailImageEngine" value={thumbnailImageEngine} />
      <input type="hidden" name="videoEngine" value={videoEngine} />
      <input type="hidden" name="characterVideoEngine" value={characterVideoEngine} />
      <input type="hidden" name="heroVideoEngine" value={heroVideoEngine} />
      <input type="hidden" name="maxAiClips" value={maxAiClips} />

      <div className="pp-board">
        <div className="pp-controls">
          {/* VISUALS */}
          <div className="pp-group">
            <div className="pp-group-h">
              <svg {...S()}>
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="9" cy="9" r="2" />
                <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
              </svg>
              Visuals
            </div>

            <div className="pp-axis">
              <div className="pp-axis-lab">Visual style</div>
              <div className="pp-axis-help">
                Where each shot comes from. Real footage pulls licensed photos (Wikimedia); AI images/video are
                generated per beat.
              </div>
              <TileRow axis="visualMode" value={visualMode} onPick={(v) => setVisualMode(v as typeof visualMode)} />

              <div className="pp-axis-lab" style={{ marginTop: 14 }}>Real imagery push</div>
              <div className="pp-axis-help">
                How hard each shot hunts the archives (Wikimedia) before falling back to AI
                generation — more candidates tried per shot and a more forgiving match bar as you
                push right. Turn it up for historical topics with rich public-domain coverage;
                each extra candidate costs one cheap vision check.
              </div>
              {(() => {
                const aiOnly = visualMode === "ai_images" || visualMode === "ai_video";
                const opts = (AXIS_OPTIONS.archivalStrength ?? []).map((o) => ({
                  v: o.value as typeof archival,
                  l: o.label,
                  hint: o.hint,
                }));
                return (
                  <>
                    <div className="seg" style={aiOnly ? { opacity: 0.45, pointerEvents: "none" } : undefined}>
                      {opts.map((o) => (
                        <button
                          type="button"
                          key={o.v}
                          className={archival === o.v ? "on" : ""}
                          title={o.hint}
                          onClick={() => setArchival(o.v)}
                        >
                          {o.l}
                        </button>
                      ))}
                    </div>
                    {aiOnly && (
                      <div className="pp-axis-help" style={{ marginTop: 6 }}>
                        AI visual styles never source real imagery — pick Mixed or Real footage to
                        use this dial.
                      </div>
                    )}
                  </>
                );
              })()}

              <div className="pp-axis-lab" style={{ marginTop: 14 }}>Image engines by shot type</div>
              <div className="pp-axis-help">
                Every engine runs vendor-direct (no middleman). Route each KIND of shot to its own
                model — e.g. cheap Qwen for bulk filler, Nano Banana for character & hero, Seedream
                where you want nicer photoreal. Defaults keep hero/character/thumbnails on Nano.
              </div>
              {(() => {
                const ENGINE_OPTS = [
                  { v: "qwen", l: "Qwen ($0.025)" },
                  { v: "seedream", l: "Seedream ($0.03)" },
                  { v: "nano-banana", l: "Nano Banana ($0.134)" },
                ];
                const roles: { label: string; hint: string; value: string; set: (v: string) => void }[] = [
                  { label: "Bulk / filler", hint: "Most shots — establishing, diagrams, non-hero", value: imageEngine, set: setImageEngine },
                  { label: "Hero shots", hint: "Pivotal beats the writer flags", value: heroImageEngine, set: setHeroImageEngine },
                  { label: "Character shots", hint: "Shots with your recurring character (Nano holds identity best)", value: characterImageEngine, set: setCharacterImageEngine },
                  { label: "Thumbnails", hint: "The click-through frame", value: thumbnailImageEngine, set: setThumbnailImageEngine },
                ];
                return (
                  <div style={{ display: "grid", gap: 8, marginTop: 4 }}>
                    {roles.map((r) => (
                      <label
                        key={r.label}
                        style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 10, alignItems: "center" }}
                      >
                        <span style={{ minWidth: 0 }}>
                          <span style={{ fontSize: 13, fontWeight: 600 }}>{r.label}</span>
                          <span className="muted" style={{ display: "block", fontSize: 11.5 }}>{r.hint}</span>
                        </span>
                        <select
                          value={r.value}
                          onChange={(e) => r.set(e.target.value)}
                          style={{ height: 30, fontSize: 12.5, minWidth: 150 }}
                        >
                          {ENGINE_OPTS.map((o) => (
                            <option key={o.v} value={o.v}>{o.l}</option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                );
              })()}
              <EngineGuide title="Which image engine should I use?" rows={IMAGE_GUIDE} />

              <details className="pp-note" open={!!init.artDirection}>
                <summary>
                  <svg {...S()}>
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  Art direction for the image model (optional)
                </summary>
                <div className="nb">
                  <textarea
                    name="artDirection"
                    defaultValue={init.artDirection ?? ""}
                    maxLength={800}
                    placeholder='Tell the AI what kind of media you want, in your words. e.g. "Prefer real archival WWII photography and cockpit interiors; black-and-white where possible; avoid modern CGI jets and cartoon styles."'
                  />
                  <div className="nh">
                    Free text. Steers image generation + reference-photo selection for this channel; leave blank
                    to use the default look.
                  </div>
                </div>
              </details>
            </div>

            <div className="pp-axis">
              <div className="pp-axis-lab">Motion</div>
              <div className="pp-axis-help">
                Whether the frame moves. &ldquo;Key beats&rdquo; animates only the important moments — keeps cost
                and render time sane.
              </div>
              <TileRow axis="motion" value={motion} onPick={(v) => setMotion(v as typeof motion)} />
            </div>

            <div className="pp-axis">
              <div className="pp-axis-lab">Video engine</div>
              <div className="pp-axis-help">
                Which model animates the clips when Motion isn&apos;t Static. Key beats moves only
                hero shots (real-footage channels source archival/Pexels clips first, AI fills the
                gaps); Full AI video animates every eligible shot from its beat image — the cost
                lever is capped per video.
              </div>
              {(() => {
                const off = motion === "static";
                const opts: { v: string; l: string; hint: string }[] = [
                  { v: "wan", l: "Wan (Alibaba)", hint: "DashScope direct — cheapest, uses your DashScope API key" },
                  { v: "minimax", l: "Hailuo (Minimax)", hint: "Minimax direct — needs a Minimax API key on /account" },
                  { v: "seedance", l: "Seedance", hint: "ByteDance, direct via BytePlus ModelArk — best keyframe identity; great for character clips (needs ARK_API_KEY)" },
                  { v: "kling", l: "Kling", hint: "Kuaishou, direct — premium cinematic 4K; priciest (needs KLING_ACCESS_KEY + KLING_SECRET_KEY)" },
                ];
                return (
                  <>
                    <div className="seg" style={off ? { opacity: 0.45, pointerEvents: "none" } : undefined}>
                      {opts.map((o) => (
                        <button
                          type="button"
                          key={o.v}
                          className={videoEngine === o.v ? "on" : ""}
                          title={o.hint}
                          onClick={() => setVideoEngine(o.v as typeof videoEngine)}
                        >
                          {o.l}
                        </button>
                      ))}
                    </div>
                    {off && (
                      <div className="pp-axis-help" style={{ marginTop: 6 }}>
                        Static motion never generates video — pick Key beats or Full AI video to
                        use this engine.
                      </div>
                    )}
                  </>
                );
              })()}
              {motion !== "static" && (
                <div style={{ display: "flex", gap: 16, marginTop: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                    <span className="pp-axis-lab" style={{ fontSize: 12 }}>Character clips</span>
                    <select
                      value={characterVideoEngine}
                      onChange={(e) => setCharacterVideoEngine(e.target.value)}
                      style={{ height: 30, fontSize: 12 }}
                      title="Shots that cast your character can animate on a higher-identity engine (fed the character's keyframe still); filler clips stay on the engine above."
                    >
                      <option value="">Same as filler engine</option>
                      <option value="seedance">Seedance (best identity)</option>
                      <option value="kling">Kling (cinematic)</option>
                      <option value="wan">Wan</option>
                      <option value="minimax">Hailuo</option>
                    </select>
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                    <span className="pp-axis-lab" style={{ fontSize: 12 }}>Hero clips</span>
                    <select
                      value={heroVideoEngine}
                      onChange={(e) => setHeroVideoEngine(e.target.value)}
                      style={{ height: 30, fontSize: 12 }}
                      title="Clips on the video's pivotal (hero) beats can animate on a premium engine. Character clips still win over hero when a shot is both."
                    >
                      <option value="">Same as filler engine</option>
                      <option value="kling">Kling (cinematic)</option>
                      <option value="seedance">Seedance (best identity)</option>
                      <option value="wan">Wan</option>
                      <option value="minimax">Hailuo</option>
                    </select>
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                    <span className="pp-axis-lab" style={{ fontSize: 12 }}>Max clips / video</span>
                    <input
                      type="number"
                      min={0}
                      max={20}
                      value={maxAiClips}
                      onChange={(e) => setMaxAiClips(e.target.value)}
                      placeholder="12 (default)"
                      style={{ height: 30, width: 120, fontSize: 12 }}
                      title="Cap the number of AI beat clips per video — the main video cost knob. Blank uses the default (12)."
                    />
                  </label>
                </div>
              )}
              <div className="pp-axis-help" style={{ marginTop: 6 }}>
                Each clip costs ~10–20× a still, so the cap is the biggest video-cost lever. Route
                character clips to Seedance for identity and hero beats to Kling for cinematic polish,
                while filler stays on cheap Wan. Character wins over hero when a shot is both.
              </div>
              <EngineGuide title="Which video engine should I use?" rows={VIDEO_GUIDE} />
            </div>

            <div className="pp-axis">
              <div className="pp-axis-lab">Rhythm</div>
              <div className="pp-axis-help">
                How often the visual cuts, driven by the voiceover&apos;s word timings — so images change on the
                spoken rhythm instead of sitting still.
              </div>
              <TileRow axis="rhythm" value={rhythm} onPick={(v) => setRhythm(v as typeof rhythm)} />
            </div>

            <div className="pp-axis">
              <div className="pp-axis-lab">Image density</div>
              <div className="pp-axis-help">
                Fine-tunes how many images per video ON TOP of Rhythm. Relaxed holds each image
                longer (fewer to generate, cheaper); Busy cuts more often. Standard is unchanged.
              </div>
              {(() => {
                const opts: { v: string; l: string; hint: string }[] = [
                  { v: "relaxed", l: "Relaxed", hint: "Fewer, longer-held images — lowest cost, calmer pacing" },
                  { v: "standard", l: "Standard", hint: "The default cadence" },
                  { v: "busy", l: "Busy", hint: "More frequent cuts — more images, higher cost" },
                ];
                return (
                  <div className="seg">
                    {opts.map((o) => (
                      <button
                        type="button"
                        key={o.v}
                        className={imageDensity === o.v ? "on" : ""}
                        title={o.hint}
                        onClick={() => setImageDensity(o.v as typeof imageDensity)}
                      >
                        {o.l}
                      </button>
                    ))}
                  </div>
                );
              })()}
            </div>

            <div className="pp-axis">
              <div className="pp-axis-lab">Visual director <span className="chip" style={{ fontSize: 10 }}>beta</span></div>
              <div className="pp-axis-help">
                A director agent reads the whole script and storyboards it — cutting shots on meaning
                (not sentence boundaries), arcing the visuals, and choosing each shot&apos;s medium
                (still / clip / real footage) within what this channel allows. When off, shots are cut
                mechanically by Rhythm. A bad director pass safely falls back to the mechanical cut.
              </div>
              <div className="seg">
                {[
                  { v: "off", l: "Off — rhythm cut" },
                  { v: "on", l: "On — director" },
                ].map((o) => (
                  <button
                    type="button"
                    key={o.v}
                    className={visualDirector === o.v ? "on" : ""}
                    onClick={() => setVisualDirector(o.v)}
                  >
                    {o.l}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* CAPTIONS */}
          <div className="pp-group">
            <div className="pp-group-h">
              <svg {...S()}>
                <rect x="2" y="5" width="20" height="14" rx="2" />
                <path d="M7 15h4M15 15h2M7 11h2M13 11h4" />
              </svg>
              Captions
            </div>
            <div className="pp-axis">
              <div className="pp-axis-lab">Burned-in captions</div>
              <div className="pp-axis-help">
                Word-by-word karaoke captions from the word timings we already have. Default on for all formats.
              </div>
              <TileRow axis="captions" value={captions} onPick={setCaptions} />
            </div>
          </div>

          {/* AUDIO */}
          <div className="pp-group">
            <div className="pp-group-h">
              <svg {...S()}>
                <path d="M9 18V5l12-2v13" />
                <circle cx="6" cy="18" r="3" />
                <circle cx="18" cy="16" r="3" />
              </svg>
              Audio
            </div>
            <div className="pp-axis">
              <div className="pp-axis-lab">Background music</div>
              <div className="pp-axis-help">
                Optional music bed ducked under the voiceover. Sets the energy without fighting the narration.
              </div>
              <TileRow axis="music" value={music} onPick={(v) => setMusic(v as typeof music)} />
            </div>
          </div>

          {/* PERSONA */}
          <div className="pp-group">
            <div className="pp-group-h">
              <svg {...S()}>
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />
              </svg>
              Persona
            </div>
            <div className="pp-axis">
              <div className="pp-voicebox">
                {voices.length > 0 ? (
                  <VoicePicker voices={voices} current={currentVoiceId} />
                ) : (
                  <label>
                    Voice <span className="muted">— id from your connected voice provider</span>
                    <input name="voiceId" defaultValue={currentVoiceId ?? ""} placeholder="voice id" />
                  </label>
                )}
              </div>
            </div>
            <div className="pp-axis">
              <div className="pp-axis-lab">Delivery</div>
              <div className="pp-axis-help">
                How the voice performs — pacing and expression on top of the chosen voice.
              </div>
              <TileRow axis="delivery" value={delivery} onPick={(v) => setDelivery(v as typeof delivery)} />
            </div>
          </div>

          <details className="pp-note" open={!!init.notes} style={{ marginBottom: 16 }}>
            <summary>
              <svg {...S()}>
                <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
              General notes to the pipeline (optional)
            </summary>
            <div className="nb">
              <textarea
                name="notes"
                defaultValue={init.notes ?? ""}
                maxLength={800}
                placeholder='Anything else the writer/producer should know for this channel. e.g. "Keep hooks question-led; end every video on an open loop; never use dramatic stock-music stingers."'
              />
              <div className="nh">
                Applies across the whole profile — injected as standing guidance alongside the toggles above.
              </div>
            </div>
          </details>

          <div className="callout">
            Options tagged <span className="pp-tag live">live</span> run today;{" "}
            <span className="pp-tag soon">soon</span> are scaffold — your choice is stored and the pipeline honours
            it as soon as that tool ships. <b>Live now:</b> visual style, rhythm (more image cuts),
            burned-in captions, and voice + delivery. <b>Soon:</b> AI-video motion and background music.
          </div>
        </div>

        {/* PREVIEW */}
        <div className="pp-preview">
          <div className="pv">
            <div className="pv-h">
              <span>Preview</span>
              <span className="chip">{isLong ? "16:9 · Long-form" : "9:16 · Shorts"}</span>
            </div>
            <div className="pv-body">
              <div className={`pp-frame${isLong ? " landscape" : ""}`}>
                <div className="stage">
                  <Art mode={visualMode} />
                </div>
                {motion !== "static" && (
                  <div className="pp-badge-motion">
                    <svg {...S({ strokeWidth: 2.4 })}>
                      <path d="m5 3 14 9-14 9V3z" />
                    </svg>
                    {motion === "partial" ? "Key-beat motion" : "AI video"}
                  </div>
                )}
                {captions === "on" && (
                  <div className="pp-cap">
                    the <b>Spitfire</b> flew
                  </div>
                )}
                <div className="pp-voice-tag">
                  🎙 {voiceName}
                  {delivery !== "measured" ? ` · ${LABEL("delivery", delivery)}` : ""}
                </div>
                {music !== "off" && (
                  <div className="pp-eq">
                    {[0, 0.1, 0.2, 0.15, 0.05, 0.25].map((d, i) => (
                      <i key={i} style={{ animationDelay: `${d}s` }} />
                    ))}
                  </div>
                )}
              </div>

              <div className="pp-recipe">
                {recipe.map(([label, key]) => (
                  <div className="rr" key={key}>
                    <span className="rk">{label}</span>
                    <span className="rv">
                      {LABEL(key, st[key])}
                      {TAG(key, st[key]) === "soon" && <span className="pp-tag soon" style={{ marginLeft: 6 }}>soon</span>}
                    </span>
                  </div>
                ))}
                <div className="rr">
                  <span className="rk">Voice</span>
                  <span className="rv">{voiceName}</span>
                </div>
              </div>
              <div className="pp-est">
                <span>Rough est. / episode</span>
                <span>
                  <b>${cost.toFixed(2)}</b> · {render}
                </span>
              </div>
            </div>
          </div>
          <button type="submit" className="btn block" style={{ marginTop: 12 }}>
            <svg {...S()}>
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
              <path d="M17 21v-8H7v8M7 3v5h8" />
            </svg>
            Save profile
          </button>
        </div>
      </div>
    </form>
  );
}
