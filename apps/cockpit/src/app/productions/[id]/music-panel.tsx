"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addOpenverseTrackToBedAction,
  addProductionTrackToBedAction,
  deleteMusicCandidateAction,
  generateMusicCandidateAction,
  removeBedTrackAction,
  searchOpenverseMusicAction,
  selectMusicAction,
  useBedTrackForProductionAction,
  useLibraryTrackAction,
  useOpenverseTrackForProductionAction,
} from "../../actions";

/** Reuses the global .spinner. */
const Spinner = () => (
  <span className="spinner" aria-hidden="true" style={{ display: "inline-block", verticalAlign: "-2px" }} />
);

export type MusicTrack = {
  id: string;
  storageKey: string;
  name: string | null;
  mood: string | null;
  engine: string | null;
  durationSec: number | null;
  selected: boolean;
};

/** A track from the cross-video library (any production, deduped by audio). */
export type LibraryTrack = {
  storageKey: string;
  name: string | null;
  mood: string | null;
  durationSec: number | null;
  engine: string | null;
};

/** A track in this channel's reusable music bed. */
export type BedTrack = {
  id: string;
  storageKey: string;
  name: string | null;
  mood: string | null;
  source: string | null;
  license: string | null;
  durationSec: number | null;
  lastUsedAt: string | null;
};

/** One Openverse search result (structural match to the server action's type). */
type OvTrack = {
  id: string;
  title: string;
  audioUrl: string;
  pageUrl: string;
  creator: string;
  license: string;
  durationSec?: number;
};

/** A few starter moods (kept in sync with core MUSIC_MOOD_PRESETS). */
const MOOD_PRESETS = [
  "warm cinematic documentary",
  "tense, driving, suspenseful",
  "upbeat, bright, curious",
  "calm, ambient, reflective",
  "epic, orchestral, dramatic",
];

const dur = (s: number | null | undefined) => (s != null ? ` (${Math.round(s)}s)` : "");

/**
 * Background-music picker. A channel keeps a reusable BED of ~6-8 tracks the
 * pipeline alternates through (least-recently-used) so a channel sounds
 * consistent without repeating the same bed every video. Free tracks come from
 * Openverse (CC audio). By default you work from the channel bed; "search all
 * channels" widens the reuse dropdown, and the Openverse search pulls a new
 * track when the bed doesn't have what this video needs.
 */
export function MusicPanel({
  productionId,
  channelId,
  musicLevel,
  defaultMood,
  tracks,
  library = [],
  bed = [],
  bedTarget = 8,
}: {
  productionId: string;
  channelId: string;
  musicLevel: "off" | "subtle" | "standard";
  defaultMood: string | null;
  tracks: MusicTrack[];
  /** cross-video library — every track generated on any video, deduped */
  library?: LibraryTrack[];
  /** this channel's reusable music bed */
  bed?: BedTrack[];
  bedTarget?: number;
}) {
  const router = useRouter();
  const [mood, setMood] = useState(defaultMood ?? "");
  const [pending, startTransition] = useTransition();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showGlobal, setShowGlobal] = useState(false);
  const [generating, setGenerating] = useState(false);

  // Openverse search state
  const [ovQuery, setOvQuery] = useState("");
  const [ovResults, setOvResults] = useState<OvTrack[] | null>(null);
  const [ovSearching, setOvSearching] = useState(false);

  const trackLabel = (t: { name: string | null; mood: string | null }) =>
    t.name || t.mood || "Untitled track";

  const run = (key: string, fn: () => Promise<{ error?: string }>) => {
    setBusyKey(key);
    setError(null);
    startTransition(async () => {
      const res = await fn();
      setBusyKey(null);
      if (res?.error) setError(res.error);
      else router.refresh();
    });
  };

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

  const searchOpenverse = () => {
    const q = ovQuery.trim() || mood.trim();
    if (!q || ovSearching) return;
    setError(null);
    setOvSearching(true);
    searchOpenverseMusicAction(q)
      .then((res) => {
        if (res.error) setError(res.error);
        setOvResults(res.tracks ?? []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setOvSearching(false));
  };

  const bedFull = bed.length >= bedTarget;

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
          <strong>Style</strong> tab to lay a bed under the narration. You can still build the bed and preview
          options below; the render only uses them once music is on.
        </p>
      ) : (
        <p className="muted" style={{ margin: "0 0 8px", fontSize: 12.5 }}>
          The channel bed below is what the render alternates through — least-recently-used first, so a channel
          cycles its tracks instead of repeating one. Sized to the voiceover; ducked far below the voice.
        </p>
      )}

      {error && (
        <div className="callout warn" style={{ margin: "0 0 8px" }}>
          <span>{error}</span>
        </div>
      )}

      {/* ── Channel bed ─────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginTop: 8 }}>
        <h4 style={{ margin: "0 0 4px", fontSize: 13 }}>Channel music bed</h4>
        <span className={`chip ${bed.length === 0 ? "warn" : bedFull ? "good" : ""}`}>
          {bed.length}/{bedTarget}
        </span>
      </div>
      {bed.length === 0 ? (
        <p className="muted" style={{ fontSize: 12.5, margin: "0 0 8px" }}>
          No tracks yet. Search free CC music below and <strong>Add to bed</strong> until you have {bedTarget} —
          the pipeline will rotate through them across this channel&rsquo;s videos.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
          {bed.map((t) => (
            <div key={t.id} className="panel" style={{ display: "flex", alignItems: "center", gap: 10, padding: 8 }}>
              <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {trackLabel(t)}
                  </span>
                  {t.source && <span className="chip">{t.source === "openverse" ? "Openverse" : t.source === "elevenlabs-music" ? "AI" : t.source}</span>}
                  {t.license && <span className="chip">{t.license}</span>}
                  {t.durationSec != null && <span className="chip">{Math.round(t.durationSec)}s</span>}
                  {t.lastUsedAt == null && <span className="chip good">unused</span>}
                </div>
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <audio src={`/api/media/${t.storageKey}`} controls preload="none" style={{ width: "100%", height: 34 }} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <button
                  type="button"
                  className="btn sm"
                  disabled={pending}
                  onClick={() => run(`usebed-${t.id}`, () => useBedTrackForProductionAction(productionId, t.storageKey))}
                >
                  {busyKey === `usebed-${t.id}` ? <Spinner /> : "Use here"}
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={pending}
                  onClick={() => run(`rmbed-${t.id}`, () => removeBedTrackAction(channelId, t.id))}
                  title="Remove from channel bed"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Find a new free track (Openverse) ───────────────────────── */}
      <h4 style={{ margin: "10px 0 4px", fontSize: 13 }}>Find a new track — free CC music (Openverse)</h4>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
        <input
          value={ovQuery}
          onChange={(e) => setOvQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && searchOpenverse()}
          placeholder="mood or vibe — e.g. calm ambient piano"
          aria-label="Openverse music search"
          style={{ flex: "1 1 220px", minWidth: 180 }}
        />
        <button type="button" className="btn" disabled={ovSearching} onClick={searchOpenverse}>
          {ovSearching ? (
            <>
              <Spinner /> Searching…
            </>
          ) : (
            "Search free music"
          )}
        </button>
      </div>
      {ovResults && ovResults.length === 0 && !ovSearching && (
        <p className="muted" style={{ fontSize: 12.5 }}>No tracks found — try a different vibe.</p>
      )}
      {ovResults && ovResults.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
          {ovResults.map((t) => (
            <div key={t.id} className="panel" style={{ display: "flex", alignItems: "center", gap: 10, padding: 8 }}>
              <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.title}
                  </span>
                  <span className="muted" style={{ fontSize: 11.5 }}>{t.creator}</span>
                  <span className="chip">{t.license}</span>
                  {t.durationSec != null && <span className="chip">{Math.round(t.durationSec)}s</span>}
                </div>
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <audio src={t.audioUrl} controls preload="none" style={{ width: "100%", height: 34 }} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <button
                  type="button"
                  className="btn sm"
                  disabled={pending || bedFull}
                  title={bedFull ? `Bed is full (${bedTarget}) — remove one first` : "Add to the channel bed"}
                  onClick={() => run(`ovbed-${t.id}`, () => addOpenverseTrackToBedAction(channelId, t, mood.trim() || undefined))}
                >
                  {busyKey === `ovbed-${t.id}` ? <Spinner /> : "Add to bed"}
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={pending}
                  title="Use on this video only (doesn't touch the bed)"
                  onClick={() => run(`ovuse-${t.id}`, () => useOpenverseTrackForProductionAction(productionId, t))}
                >
                  {busyKey === `ovuse-${t.id}` ? <Spinner /> : "Use here"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Generate a bespoke bed (paid) ───────────────────────────── */}
      <h4 style={{ margin: "10px 0 4px", fontSize: 13 }}>Or generate a bespoke bed (AI)</h4>
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

      {/* ── This video's tracks ─────────────────────────────────────── */}
      {tracks.length > 0 && (
        <>
          <h4 style={{ margin: "10px 0 4px", fontSize: 13 }}>This video&rsquo;s tracks</h4>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {tracks.map((t) => (
              <div
                key={t.id}
                className="panel"
                style={{ display: "flex", alignItems: "center", gap: 10, padding: 8, borderColor: t.selected ? "var(--accent)" : undefined }}
              >
                <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
                    {t.selected && <span className="chip good">In use</span>}
                    <span style={{ fontSize: 12.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {t.name || t.mood || "auto"}
                    </span>
                    {t.engine && <span className="chip">{t.engine === "elevenlabs-music" ? "AI" : t.engine === "openverse" ? "Openverse" : t.engine === "mock-music" ? "placeholder" : t.engine}</span>}
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
                    onClick={() => run(`sel-${t.id}`, () => selectMusicAction(productionId, t.id))}
                  >
                    {busyKey === `sel-${t.id}` ? <Spinner /> : t.selected ? "In use" : "Use this"}
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={pending || bedFull}
                    title={bedFull ? `Bed is full (${bedTarget})` : "Add this track to the channel bed"}
                    onClick={() => run(`tobed-${t.id}`, () => addProductionTrackToBedAction(channelId, t.storageKey))}
                  >
                    {busyKey === `tobed-${t.id}` ? <Spinner /> : "Add to bed"}
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={pending}
                    onClick={() => run(`del-${t.id}`, () => deleteMusicCandidateAction(productionId, t.id))}
                    title="Delete this option"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── Global escape hatch: reuse across all channels ──────────── */}
      {library.length > 0 && (
        <div style={{ marginTop: 10 }}>
          {!showGlobal ? (
            <button type="button" className="btn ghost sm" onClick={() => setShowGlobal(true)}>
              Search all channels&rsquo; library…
            </button>
          ) : (
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <label className="field-label" htmlFor="music-library" style={{ margin: 0 }}>
                Reuse any saved track
              </label>
              <select
                id="music-library"
                defaultValue=""
                disabled={pending}
                onChange={(e) => {
                  const v = e.target.value;
                  e.currentTarget.value = "";
                  if (v) run(`lib-${v}`, () => useLibraryTrackAction(productionId, v));
                }}
                style={{ flex: "1 1 240px", minWidth: 200 }}
              >
                <option value="" disabled>
                  Pick from every channel&rsquo;s tracks…
                </option>
                {library.map((t) => (
                  <option key={t.storageKey} value={t.storageKey}>
                    {trackLabel(t)}
                    {t.mood && t.name ? ` — ${t.mood}` : ""}
                    {dur(t.durationSec)}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
