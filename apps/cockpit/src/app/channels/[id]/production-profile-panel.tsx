"use client";

import { useState } from "react";
import type { VoiceOption } from "@ytauto/providers";
import type { ProductionProfile } from "@ytauto/db";
import { VoicePicker } from "../voice-picker";

/**
 * Production Profile dashboard (BACKLOG #18) — the per-channel control plane.
 * A tile-picker per axis (visual style · motion · rhythm · captions · music ·
 * persona voice+delivery) with a live 9:16/16:9 preview that reacts to the
 * selection, plus free-text art-direction/notes. Submits to
 * updateProductionProfileAction. Options tagged "soon" are scaffold — the
 * choice is stored and the pipeline honours each axis as that feature ships.
 */

type Fmt = { value: string; label: string; tag: "live" | "soon" };
type AxisKey = "visualMode" | "motion" | "rhythm" | "captions" | "music" | "delivery";

const OPTS: Record<AxisKey, Fmt[]> = {
  visualMode: [
    { value: "simple", label: "Simple", tag: "soon" },
    { value: "real_footage", label: "Real footage", tag: "live" },
    { value: "ai_images", label: "AI images", tag: "live" },
    { value: "ai_video", label: "AI video", tag: "live" },
    { value: "mixed", label: "Mixed", tag: "live" },
  ],
  motion: [
    { value: "static", label: "Static", tag: "live" },
    { value: "partial", label: "Key beats", tag: "live" },
    { value: "ai_video", label: "Full AI video", tag: "live" },
  ],
  rhythm: [
    { value: "sentence", label: "Per sentence", tag: "live" },
    { value: "section", label: "Per section", tag: "live" },
    { value: "pause", label: "On pauses", tag: "live" },
  ],
  captions: [
    { value: "on", label: "On", tag: "live" },
    { value: "off", label: "Off", tag: "live" },
  ],
  music: [
    { value: "off", label: "Off", tag: "live" },
    { value: "subtle", label: "Subtle", tag: "soon" },
    { value: "standard", label: "Standard", tag: "soon" },
  ],
  delivery: [
    { value: "measured", label: "Measured", tag: "live" },
    { value: "warm", label: "Warm", tag: "live" },
    { value: "energetic", label: "Energetic", tag: "live" },
    { value: "dramatic", label: "Dramatic", tag: "live" },
  ],
};
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
  const [captions, setCaptions] = useState(init.captions ? "on" : "off");
  const [music, setMusic] = useState(init.music);
  const [delivery, setDelivery] = useState(init.delivery);
  const [archival, setArchival] = useState(init.archivalStrength ?? "balanced");
  const [imageEngine, setImageEngine] = useState(init.imageEngine ?? "fal");
  const [videoEngine, setVideoEngine] = useState(init.videoEngine ?? "wan");

  const isLong = contentFormat === "long";
  const st = { visualMode, motion, rhythm, captions, music, delivery } as Record<AxisKey, string>;
  const voiceName = voices.find((v) => v.id === (currentVoiceId ?? ""))?.name ?? currentVoiceId ?? "default";

  // rough est. — illustrative, mirrors the pipeline's relative tool costs
  let cost = 0.2; // voice baseline
  // bulk-image bump scales with the engine (~30 shots: Flux .007 / Qwen .025 / nano .039)
  const bulkImages = imageEngine === "qwen" ? 0.75 : imageEngine === "nano-banana" ? 1.2 : 0.2;
  if (visualMode === "ai_images") cost += bulkImages;
  else if (visualMode === "ai_video") cost += 0.9;
  else if (visualMode === "mixed") cost += bulkImages * 0.6;
  // AI beat clips: ~12 (full) / ~3 (key beats) clips × ~5s × per-second rate
  const clipPerSec = videoEngine === "minimax" ? 0.045 : 0.05;
  if (motion === "ai_video") cost += 12 * 5 * clipPerSec;
  else if (motion === "partial") cost += 3 * 5 * clipPerSec;
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
    <form action={action}>
      {/* hidden inputs carry the live selection to the server action */}
      <input type="hidden" name="visualMode" value={visualMode} />
      <input type="hidden" name="motion" value={motion} />
      <input type="hidden" name="rhythm" value={rhythm} />
      <input type="hidden" name="captions" value={captions} />
      <input type="hidden" name="music" value={music} />
      <input type="hidden" name="delivery" value={delivery} />
      <input type="hidden" name="archivalStrength" value={archival} />
      <input type="hidden" name="imageEngine" value={imageEngine} />
      <input type="hidden" name="videoEngine" value={videoEngine} />

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
                const opts: { v: typeof archival; l: string; hint: string }[] = [
                  { v: "off", l: "Off", hint: "Never source — every shot is generated" },
                  { v: "light", l: "Light", hint: "Named subjects only, strict match bar" },
                  { v: "balanced", l: "Balanced", hint: "Named subjects + topic search, one candidate each" },
                  { v: "strong", l: "Strong", hint: "3 candidates per shot, forgiving bar, topic retry" },
                  { v: "max", l: "Max", hint: "5 candidates per shot, most forgiving bar" },
                ];
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

              <div className="pp-axis-lab" style={{ marginTop: 14 }}>Image engine</div>
              <div className="pp-axis-help">
                Which model generates this channel&apos;s AI shots. fal.ai Flux is fast and cheap;
                Nano Banana (Google) knows real-world subjects and people far better; Combination
                renders bulk shots on Flux and sends hero shots + thumbnails to Nano Banana.
                Nano Banana runs Google-direct with a Gemini API key, else through fal.ai.
              </div>
              {(() => {
                const opts: { v: string; l: string; hint: string }[] = [
                  { v: "fal", l: "fal.ai Flux", hint: "Everything on fal.ai — Flux shots, nano-banana-pro hero (today's default)" },
                  { v: "mixed", l: "Combination", hint: "Flux for bulk shots; hero shots + thumbnails on Google-direct Nano Banana" },
                  { v: "qwen", l: "Qwen-Image", hint: "fal-free: bulk shots on DashScope-direct Qwen-Image, hero stays Nano Banana — uses your DashScope key" },
                  { v: "nano-banana", l: "All Nano Banana", hint: "Every generated image on Google's Nano Banana" },
                ];
                return (
                  <div className="seg">
                    {opts.map((o) => (
                      <button
                        type="button"
                        key={o.v}
                        className={imageEngine === o.v ? "on" : ""}
                        title={o.hint}
                        onClick={() => setImageEngine(o.v as typeof imageEngine)}
                      >
                        {o.l}
                      </button>
                    ))}
                  </div>
                );
              })()}

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
                  { v: "wan", l: "Wan (Alibaba)", hint: "DashScope direct — uses your DashScope API key" },
                  { v: "minimax", l: "Hailuo (Minimax)", hint: "Minimax direct — needs a Minimax API key on /account" },
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
            </div>

            <div className="pp-axis">
              <div className="pp-axis-lab">Rhythm</div>
              <div className="pp-axis-help">
                How often the visual cuts, driven by the voiceover&apos;s word timings — so images change on the
                spoken rhythm instead of sitting still.
              </div>
              <TileRow axis="rhythm" value={rhythm} onPick={(v) => setRhythm(v as typeof rhythm)} />
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
