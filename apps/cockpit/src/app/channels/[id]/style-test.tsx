"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@/components/ui/dialog";
import { IconSparkle } from "@/components/icons";
import {
  deleteTestSceneAction,
  generateStyleTestSceneAction,
  promoteTestSceneAction,
  refineStyleTestSceneAction,
} from "../style-actions";

export type TestSceneRow = {
  id: string;
  imageKey: string;
  prompt: string;
  lastComments: string | null;
  /** every character cast into the scene (was: just the first) */
  characterNames: string[];
  /** the distilled version it rendered against, or null (house style / none) */
  styleVersion: number | null;
};

/**
 * "Test the style" playground (2026-07-14 operator ask): render a scene with
 * the newest distilled style — optionally casting a character to preview how
 * its reference sheet behaves as an input — refine with comments until it's
 * right, then promote keepers into the example pool as style inputs.
 */
export function StyleTest({
  channelId,
  styleId,
  styleVersion,
  characters,
  scenes,
  engines,
  defaultEngine,
  houseStyleSet,
}: {
  channelId: string;
  styleId: string | null;
  styleVersion: number | null;
  characters: { id: string; name: string }[];
  scenes: TestSceneRow[];
  /** [value, label] pairs for the model picker */
  engines: [string, string][];
  defaultEngine: string;
  /** the channel has a plain house style to fall back on when nothing is distilled */
  houseStyleSet: boolean;
}) {
  const router = useRouter();
  const [scene, setScene] = useState("");
  const [castIds, setCastIds] = useState<string[]>([]);
  const [engine, setEngine] = useState(defaultEngine);
  const [note2, setNote2] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // per-scene refine dialog
  const [refineId, setRefineId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const generate = () =>
    startTransition(async () => {
      setError(null);
      setNote2(null);
      const res = await generateStyleTestSceneAction(channelId, {
        styleId,
        scene,
        characterIds: castIds,
        imageEngine: engine,
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setNote2(res.note);
      setScene("");
      router.refresh();
    });

  const refine = () =>
    startTransition(async () => {
      if (!refineId) return;
      setError(null);
      const res = await refineStyleTestSceneAction(channelId, refineId, note);
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setRefineId(null);
      setNote("");
      router.refresh();
    });

  const promote = (id: string) =>
    startTransition(async () => {
      setBusyId(id);
      await promoteTestSceneAction(channelId, id);
      setBusyId(null);
      router.refresh();
    });

  const remove = (id: string) =>
    startTransition(async () => {
      setBusyId(id);
      await deleteTestSceneAction(channelId, id);
      setBusyId(null);
      router.refresh();
    });

  const refining = scenes.find((s) => s.id === refineId);

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-head">
        <h3>Test scenes</h3>
        <span className="chip">
          {styleVersion != null ? `style v${styleVersion}` : houseStyleSet ? "house style" : "no style set"}
        </span>
      </div>
      <div className="panel-body">
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          Write a scene and render it — the fastest way to see how the channel&apos;s look and your
          characters actually behave before committing. <strong>Cast any number of characters</strong>{" "}
          into one scene to check they hold their own identity together. Refine any scene with
          comments (its current image is the edit reference), then add keepers to the example pool so
          the next distill learns from them.{" "}
          {styleVersion != null
            ? `Rendering against distilled style v${styleVersion}.`
            : houseStyleSet
              ? "No distilled style yet — rendering against the channel house style above."
              : "No style set yet — this renders with no imposed look; set a house style above or distill one."}
        </p>
        {(
          <>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
              <textarea
                value={scene}
                onChange={(e) => setScene(e.target.value)}
                placeholder={'Scene to test — e.g. "a robed scribe copying by lamplight in a vast stone hall, seen from behind"'}
                rows={2}
                style={{ flex: 1, minWidth: 280, resize: "vertical" }}
                disabled={pending}
              />
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <select
                  value={engine}
                  onChange={(e) => setEngine(e.target.value)}
                  className="mini-select"
                  style={{ height: 32 }}
                  disabled={pending}
                  aria-label="Image model"
                >
                  {engines.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                      {value === defaultEngine ? " — channel default" : ""}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn sm" style={{ height: 32 }} disabled={pending || !scene.trim()} onClick={generate}>
                  <IconSparkle /> {pending && !refineId && !busyId ? "Rendering…" : "Generate scene"}
                </button>
              </div>
            </div>
            {characters.length > 0 && (
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
                <span className="muted" style={{ fontSize: 12.5 }}>Cast:</span>
                {characters.map((c) => {
                  const on = castIds.includes(c.id);
                  return (
                    <label key={c.id} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12.5, cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={pending}
                        onChange={() =>
                          setCastIds((prev) => (on ? prev.filter((id) => id !== c.id) : [...prev, c.id]))
                        }
                      />
                      {c.name}
                    </label>
                  );
                })}
                {castIds.length > 0 && (
                  <button type="button" className="btn ghost sm" style={{ padding: "2px 8px", fontSize: 11 }} disabled={pending} onClick={() => setCastIds([])}>
                    Clear
                  </button>
                )}
                <span className="muted" style={{ fontSize: 11.5 }}>
                  {castIds.length === 0
                    ? "no characters — scene only"
                    : `${castIds.length} cast — each one's reference sheet is fed to the model`}
                </span>
              </div>
            )}
            {note2 && !error && (
              <p className="muted" style={{ fontSize: 12, marginTop: 0, marginBottom: 10 }}>{note2}</p>
            )}
            {error && !refineId && <div className="err" style={{ marginBottom: 10 }}>{error}</div>}
            {scenes.length > 0 && (
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                {scenes.map((s) => (
                  <div key={s.id} style={{ width: 300 }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/media/${s.imageKey}`}
                      alt={`Test scene: ${s.prompt}`}
                      style={{ width: "100%", aspectRatio: "16/9", objectFit: "cover", borderRadius: 8, border: "1px solid var(--border)" }}
                    />
                    <p className="muted" style={{ fontSize: 12, margin: "4px 0 2px" }}>
                      {s.prompt}
                      {s.characterNames.length ? ` · with ${s.characterNames.join(", ")}` : ""}
                      {s.styleVersion != null ? ` · style v${s.styleVersion}` : ""}
                    </p>
                    {s.lastComments && (
                      <p className="muted" style={{ fontSize: 11.5, margin: "0 0 2px", fontStyle: "italic" }}>
                        Last refine: {s.lastComments}
                      </p>
                    )}
                    <div style={{ display: "flex", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
                      <button
                        type="button"
                        className="btn ghost sm"
                        style={{ padding: "2px 8px", fontSize: 11 }}
                        disabled={pending}
                        onClick={() => {
                          setRefineId(s.id);
                          setNote("");
                          setError(null);
                        }}
                      >
                        Refine…
                      </button>
                      <button
                        type="button"
                        className="btn ghost sm"
                        style={{ padding: "2px 8px", fontSize: 11 }}
                        disabled={pending}
                        onClick={() => promote(s.id)}
                      >
                        {busyId === s.id ? "Working…" : "Add to style examples"}
                      </button>
                      <button
                        type="button"
                        className="btn ghost sm danger-ink"
                        style={{ padding: "2px 8px", fontSize: 11 }}
                        disabled={pending}
                        onClick={() => remove(s.id)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <Dialog open={!!refineId} onClose={() => !pending && setRefineId(null)} title="Refine test scene">
        {refining && (
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            &ldquo;{refining.prompt}&rdquo; — your comments apply on top of the current image
            (it&apos;s sent as the edit reference), so tweaks land without losing the scene.
          </p>
        )}
        <label className="field-label" htmlFor="scene-refine-note">
          Changes to make
        </label>
        <textarea
          id="scene-refine-note"
          rows={3}
          placeholder='e.g. "Add floating chalk-dust particles and warmer window light; keep the pose."'
          value={note}
          onChange={(ev) => setNote(ev.target.value)}
          disabled={pending}
        />
        <div className="actions" style={{ marginTop: 12 }}>
          <button type="button" className="btn" disabled={pending || !note.trim()} onClick={refine}>
            <IconSparkle /> Regenerate scene
          </button>
          <button type="button" className="btn ghost" disabled={pending} onClick={() => setRefineId(null)}>
            Cancel
          </button>
          {pending && refineId && (
            <span className="muted" style={{ fontSize: 12.5 }}>
              Reworking the scene…
            </span>
          )}
        </div>
        {error && refineId && <div className="err">{error}</div>}
      </Dialog>
    </div>
  );
}
