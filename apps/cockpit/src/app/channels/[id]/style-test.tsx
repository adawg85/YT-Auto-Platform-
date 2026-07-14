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
  characterName: string | null;
  styleVersion: number;
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
}: {
  channelId: string;
  styleId: string | null;
  styleVersion: number | null;
  characters: { id: string; name: string }[];
  scenes: TestSceneRow[];
}) {
  const router = useRouter();
  const [scene, setScene] = useState("");
  const [characterId, setCharacterId] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // per-scene refine dialog
  const [refineId, setRefineId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const generate = () =>
    startTransition(async () => {
      if (!styleId) return;
      setError(null);
      const res = await generateStyleTestSceneAction(channelId, {
        styleId,
        scene,
        characterId: characterId || null,
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
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
        <h3>Test the style</h3>
        {styleVersion != null && <span className="chip">testing v{styleVersion}</span>}
      </div>
      <div className="panel-body">
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          Render a throwaway scene with the newest distilled style before you activate it — cast a
          character to see exactly how its reference sheet behaves as an input. Refine any scene
          with comments (the current image is the edit reference), then add keepers to the example
          pool so the next distill learns from them.
        </p>
        {!styleId ? (
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            Distill a style first — test scenes render against your newest version.
          </p>
        ) : (
          <>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
              <input
                value={scene}
                onChange={(e) => setScene(e.target.value)}
                placeholder='Scene to test — e.g. "explaining magnetism at a cluttered chalkboard"'
                style={{ flex: 1, minWidth: 260, height: 36 }}
                disabled={pending}
              />
              <select
                value={characterId}
                onChange={(e) => setCharacterId(e.target.value)}
                style={{ height: 36 }}
                disabled={pending}
                aria-label="Cast a character"
              >
                <option value="">No character</option>
                {characters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button type="button" className="btn sm" style={{ height: 36 }} disabled={pending || !scene.trim()} onClick={generate}>
                <IconSparkle /> {pending && !refineId && !busyId ? "Rendering…" : "Generate test scene"}
              </button>
            </div>
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
                      {s.characterName ? ` · with ${s.characterName}` : ""}
                      {` · v${s.styleVersion}`}
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
