"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  deleteMusicCandidateAction,
  generateMusicCandidateAction,
  selectMusicAction,
} from "../../actions";

/** Reuses the global .spinner. */
const Spinner = () => (
  <span className="spinner" aria-hidden="true" style={{ display: "inline-block", verticalAlign: "-2px" }} />
);

export type MusicTrack = {
  id: string;
  storageKey: string;
  mood: string | null;
  engine: string | null;
  durationSec: number | null;
  selected: boolean;
};

/** A few starter moods (kept in sync with core MUSIC_MOOD_PRESETS). */
const MOOD_PRESETS = [
  "warm cinematic documentary",
  "tense, driving, suspenseful",
  "upbeat, bright, curious",
  "calm, ambient, reflective",
  "epic, orchestral, dramatic",
];

/**
 * Background-music picker (2026-07-17 operator: choose music + listen to
 * options). Generate a bed for a mood, play it, keep generating until you like
 * one, then "Use this" marks the track the render lays under the narration.
 */
export function MusicPanel({
  productionId,
  musicLevel,
  defaultMood,
  tracks,
}: {
  productionId: string;
  musicLevel: "off" | "subtle" | "standard";
  defaultMood: string | null;
  tracks: MusicTrack[];
}) {
  const router = useRouter();
  const [mood, setMood] = useState(defaultMood ?? "");
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Generation runs a slow ElevenLabs call — use a manual busy flag (not the
  // transition, which swallows thrown errors) so a failure is always shown.
  const [generating, setGenerating] = useState(false);

  const generate = () => {
    if (generating) return;
    setError(null);
    setGenerating(true);
    generateMusicCandidateAction(productionId, mood.trim() || undefined)
      .then((res) => {
        if (res.error) setError(res.error);
        else router.refresh();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setGenerating(false));
  };
  const select = (id: string) => {
    setBusyId(id);
    setError(null);
    startTransition(async () => {
      const res = await selectMusicAction(productionId, id);
      setBusyId(null);
      if (res.error) setError(res.error);
      else router.refresh();
    });
  };
  const remove = (id: string) => {
    setBusyId(id);
    setError(null);
    startTransition(async () => {
      await deleteMusicCandidateAction(productionId, id);
      setBusyId(null);
      router.refresh();
    });
  };

  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <h3 style={{ margin: "0 0 4px", fontSize: 14 }}>Background music</h3>
        <span className={`chip ${musicLevel === "off" ? "warn" : "good"}`}>
          {musicLevel === "off" ? "Off" : musicLevel === "subtle" ? "Subtle" : "Standard"}
        </span>
      </div>
      {musicLevel === "off" ? (
        <p className="muted" style={{ margin: "0 0 8px", fontSize: 12.5 }}>
          Music is <strong>off</strong> for this channel — set it to Subtle or Standard on the channel&rsquo;s{" "}
          <strong>Style</strong> tab to lay a bed under the narration. You can still generate and preview options
          below; the render only uses them once music is on.
        </p>
      ) : (
        <p className="muted" style={{ margin: "0 0 8px", fontSize: 12.5 }}>
          Generate a few beds, play them, then <strong>Use this</strong> on the one the render should lay under the
          narration. Sized to the voiceover; ducked far below the voice.
        </p>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
        <input
          value={mood}
          onChange={(e) => setMood(e.target.value)}
          placeholder="mood / brief — e.g. tense cinematic"
          aria-label="Music mood"
          style={{ flex: "1 1 220px", minWidth: 180 }}
          list="music-mood-presets"
        />
        <datalist id="music-mood-presets">
          {MOOD_PRESETS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <button type="button" className="btn" disabled={generating} onClick={generate}>
          {generating ? (
            <>
              <Spinner /> Generating… (~10–30s)
            </>
          ) : (
            "Generate option"
          )}
        </button>
      </div>

      {error && (
        <div className="callout warn" style={{ margin: "0 0 8px" }}>
          <span>{error}</span>
        </div>
      )}

      {tracks.length === 0 ? (
        <p className="muted" style={{ fontSize: 12.5 }}>
          No options yet — generate one above. (No music key configured falls back to a deterministic placeholder
          bed, so every option sounds the same until an ElevenLabs Music key is set.)
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {tracks.map((t) => (
            <div
              key={t.id}
              className="panel"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: 8,
                borderColor: t.selected ? "var(--accent)" : undefined,
              }}
            >
              <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  {t.selected && <span className="chip good">In use</span>}
                  <span style={{ fontSize: 12.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.mood || "auto"}
                  </span>
                  {t.engine && <span className="chip">{t.engine === "elevenlabs-music" ? "AI" : "placeholder"}</span>}
                  {t.durationSec != null && <span className="chip">{Math.round(t.durationSec)}s</span>}
                </div>
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <audio src={`/api/media/${t.storageKey}`} controls preload="none" style={{ width: "100%", height: 34 }} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <button
                  type="button"
                  className={`btn sm ${t.selected ? "ghost" : ""}`}
                  disabled={pending || t.selected}
                  onClick={() => select(t.id)}
                >
                  {busyId === t.id && !t.selected ? <Spinner /> : t.selected ? "In use" : "Use this"}
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={pending}
                  onClick={() => remove(t.id)}
                  title="Delete this option"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
