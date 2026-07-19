"use client";

import { useState, useTransition } from "react";
import { setAudioLevelsAction } from "../../actions";
import { IconGauge } from "@/components/icons";

/**
 * Manual audio-mix dials (2026-07-19 operator ask): two sliders to balance the
 * voiceover against the music bed before the render, since voice was always
 * full-scale and music a fixed axis level. Values are linear gain — voice
 * 0–150 % (default 100), music 0–100 % (default = the "music" axis level). The
 * render bakes them in; changing them after a render is flagged stale so a
 * re-render picks them up.
 */
export function AudioLevelsPanel({
  productionId,
  initialVoice,
  initialMusic,
  hasRender,
}: {
  productionId: string;
  initialVoice: number;
  initialMusic: number;
  hasRender: boolean;
}) {
  const [voice, setVoice] = useState(Math.round(initialVoice * 100));
  const [music, setMusic] = useState(Math.round(initialMusic * 100));
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    voice !== Math.round(initialVoice * 100) || music !== Math.round(initialMusic * 100);

  const save = () =>
    startTransition(async () => {
      setError(null);
      setSaved(false);
      const res = await setAudioLevelsAction(productionId, voice / 100, music / 100);
      if (res.error) setError(res.error);
      else setSaved(true);
    });

  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <div className="panel-head">
        <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <IconGauge /> Audio levels
        </h3>
      </div>
      <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
          Balance the two audio tracks before rendering. Voice sits at full by default; the music
          bed plays under it. Drag, then Save — the video renders with these levels.
        </p>

        <Slider
          label="Voiceover"
          value={voice}
          min={0}
          max={150}
          step={5}
          onChange={(v) => {
            setSaved(false);
            setVoice(v);
          }}
          hint={voice === 100 ? "Full (default)" : voice > 100 ? "Boosted — may clip if the take is already loud" : "Quieter than default"}
        />
        <Slider
          label="Music bed"
          value={music}
          min={0}
          max={100}
          step={1}
          onChange={(v) => {
            setSaved(false);
            setMusic(v);
          }}
          hint={music === 0 ? "Muted — no music in the render" : "Under the voice"}
        />

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button type="button" className="btn" disabled={pending || !dirty} onClick={save}>
            {pending ? "Saving…" : "Save levels"}
          </button>
          {saved && !dirty && (
            <span className="muted" style={{ fontSize: 12.5 }}>
              Saved.{" "}
              {hasRender
                ? "Re-render (Retry from render) to hear the new mix."
                : "Applies on the next render."}
            </span>
          )}
          {error && <span className="err">{error}</span>}
        </div>
      </div>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  hint: string;
}) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <span className="field-label" style={{ margin: 0 }}>{label}</span>
        <span className="num" style={{ fontSize: 13, fontVariantNumeric: "tabular-nums" }}>{value}%</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: "100%", accentColor: "var(--accent)" }}
        aria-label={`${label} volume`}
      />
      <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>{hint}</div>
    </div>
  );
}
