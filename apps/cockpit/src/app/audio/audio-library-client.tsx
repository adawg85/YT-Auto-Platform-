"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconUpload, IconX } from "@/components/icons";
import { deleteAudioAssetAction, patchAudioAssetAction } from "./actions";

/** #110 audio library — upload + per-asset licence editing (client half). */

export function AudioUpload() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    for (const file of Array.from(files)) {
      const fd = new FormData();
      fd.append("audio", file);
      const res = await fetch("/api/audio-asset", { method: "POST", body: fd });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(`${file.name}: ${body?.error ?? `upload failed (${res.status})`}`);
        break;
      }
    }
    setBusy(false);
    router.refresh();
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <input
        ref={inputRef}
        type="file"
        accept="audio/mpeg,audio/wav,audio/ogg,audio/mp4,audio/webm,.mp3,.wav,.ogg,.m4a,.webm"
        multiple
        hidden
        onChange={(e) => void onFiles(e.target.files)}
      />
      <button type="button" className="btn" onClick={() => inputRef.current?.click()} disabled={busy}>
        <IconUpload /> {busy ? "Uploading…" : "Upload tracks"}
      </button>
      <span style={{ fontSize: 12.5, opacity: 0.6 }}>mp3 / wav / m4a / ogg / webm, up to 60MB each — then fill in the licence below</span>
      {error ? <span className="chip warn">{error}</span> : null}
    </div>
  );
}

export type AssetRowData = {
  id: string;
  storageKey: string;
  title: string;
  creator: string | null;
  creatorUrl: string | null;
  sourceUrl: string | null;
  licence: string | null;
  licenceUrl: string | null;
  modified: boolean;
  commercialUse: boolean | null;
  durationSec: number | null;
  mood: string | null;
  notes: string | null;
  attributionLine: string | null;
};

export function AssetRow({ asset }: { asset: AssetRowData }) {
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function save(form: FormData) {
    startTransition(async () => {
      const res = await patchAudioAssetAction(asset.id, {
        title: String(form.get("title") ?? ""),
        creator: String(form.get("creator") ?? ""),
        creatorUrl: String(form.get("creatorUrl") ?? ""),
        sourceUrl: String(form.get("sourceUrl") ?? ""),
        licence: String(form.get("licence") ?? ""),
        mood: String(form.get("mood") ?? ""),
        notes: String(form.get("notes") ?? ""),
        modified: form.get("modified") === "on",
      });
      if (res.error) setError(res.error);
      else {
        setError(null);
        setEditing(false);
        router.refresh();
      }
    });
  }

  const gate =
    asset.commercialUse === true ? (
      <span className="chip ok">monetisation-safe</span>
    ) : asset.commercialUse === false ? (
      <span className="chip warn">blocked — licence forbids commercial use</span>
    ) : (
      <span className="chip warn">licence needed before use</span>
    );

  return (
    <div className="panel" style={{ padding: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600 }}>{asset.title}</span>
        {asset.creator ? <span style={{ opacity: 0.7 }}>by {asset.creator}</span> : null}
        {asset.licence ? <span className="chip">{asset.licence}</span> : null}
        {gate}
        {asset.durationSec ? <span className="chip">{Math.round(asset.durationSec)}s</span> : null}
        {asset.mood ? <span className="chip">{asset.mood}</span> : null}
        <span style={{ flex: 1 }} />
        <button type="button" className="btn ghost sm" onClick={() => setEditing((v) => !v)}>
          {editing ? "Close" : "Edit licence"}
        </button>
        <button
          type="button"
          className="btn ghost sm"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              await deleteAudioAssetAction(asset.id);
              router.refresh();
            })
          }
        >
          <IconX />
        </button>
      </div>
      <audio src={`/api/media/${asset.storageKey}`} controls preload="none" style={{ width: "100%", marginTop: 8, height: 32 }} />
      {asset.attributionLine ? (
        <div style={{ fontSize: 12.5, opacity: 0.7, marginTop: 6 }}>Credit: {asset.attributionLine}</div>
      ) : null}
      {editing ? (
        <form action={save} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8, marginTop: 10 }}>
          <label className="field">
            <span>Title</span>
            <input name="title" defaultValue={asset.title} required />
          </label>
          <label className="field">
            <span>Creator</span>
            <input name="creator" defaultValue={asset.creator ?? ""} placeholder="artist name" />
          </label>
          <label className="field">
            <span>Creator URL</span>
            <input name="creatorUrl" defaultValue={asset.creatorUrl ?? ""} placeholder="artist profile (for the credit)" />
          </label>
          <label className="field">
            <span>Source page URL</span>
            <input name="sourceUrl" defaultValue={asset.sourceUrl ?? ""} placeholder="where the track came from" />
          </label>
          <label className="field">
            <span>Licence</span>
            <input name="licence" defaultValue={asset.licence ?? ""} placeholder="CC0 · CC BY 4.0 · CC BY-SA 3.0 · proprietary" />
          </label>
          <label className="field">
            <span>Mood</span>
            <input name="mood" defaultValue={asset.mood ?? ""} placeholder="dark ambient" />
          </label>
          <label className="field" style={{ gridColumn: "1 / -1" }}>
            <span>Notes</span>
            <input name="notes" defaultValue={asset.notes ?? ""} placeholder="anything odd about the grant" />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            <input type="checkbox" name="modified" defaultChecked={asset.modified} /> we modified it (trim/loop/levels)
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button type="submit" className="btn sm" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </button>
            {error ? <span className="chip warn">{error}</span> : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}
