"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

/** #35.1: file-upload corner of the Style tab (multipart → /api/style-ref). */
export function StyleUpload({ channelId }: { channelId: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files).slice(0, 8)) {
        const fd = new FormData();
        fd.set("channelId", channelId);
        fd.set("image", file);
        const res = await fetch("/api/style-ref", { method: "POST", body: fd });
        if (!res.ok) throw new Error((await res.json()).error ?? `Upload failed (${res.status})`);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        style={{ display: "none" }}
        onChange={(e) => upload(e.target.files)}
      />
      <button type="button" className="btn ghost sm" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? "Uploading…" : "Upload images"}
      </button>
      {error && <span className="badge red">{error}</span>}
    </span>
  );
}
