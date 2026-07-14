"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { generateChannelLogoAction, setChannelLogoAction } from "../actions";
import { BrandArtDialog } from "./brand-art-dialog";

/**
 * Channel logo control (Settings tab). Shows the current avatar and lets the
 * operator upload their own (→ /api/channel-avatar), generate one with the
 * hero image model, or remove it. Generation opens a dialog (2026-07-14
 * operator ask) showing the exact editable prompt plus a Reference select
 * (characters / style scenes / current logo) for brand consistency.
 */
export function ChannelLogo({
  channelId,
  avatarKey,
  name,
  defaultPrompt,
  references,
}: {
  channelId: string;
  avatarKey: string | null;
  name: string;
  defaultPrompt: string;
  references: { value: string; label: string }[];
}) {
  const router = useRouter();
  const [url, setUrl] = useState<string | null>(avatarKey ? `/api/media/${avatarKey}` : null);
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [genOpen, setGenOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onUpload(file: File) {
    setBusy("upload");
    setErr(null);
    try {
      const fd = new FormData();
      fd.set("channelId", channelId);
      fd.set("image", file);
      const res = await fetch("/api/channel-avatar", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Upload failed");
      setUrl(`${j.url}?t=${Date.now()}`);
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(null);
    }
  }

  async function onRemove() {
    setBusy("remove");
    setErr(null);
    await setChannelLogoAction(channelId, null);
    setUrl(null);
    router.refresh();
    setBusy(null);
  }

  const initial = (name[0] ?? "?").toUpperCase();

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Channel logo</h2>
      <p className="muted" style={{ margin: "-6px 0 14px", fontSize: 12.5 }}>
        Shown across the cockpit (overview cards, channel header). Upload your own, or generate one with the hero image
        model. Set the same image as your YouTube channel avatar by hand (the API can&apos;t).
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <span
          style={{
            width: 72,
            height: 72,
            borderRadius: 16,
            flex: "none",
            overflow: "hidden",
            display: "grid",
            placeItems: "center",
            background: url ? "var(--surface-2)" : "linear-gradient(135deg,var(--accent),var(--accent-2))",
            color: "#fff",
            fontWeight: 700,
            fontSize: 26,
            border: "1px solid var(--border)",
          }}
        >
          {url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt="Channel logo" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            initial
          )}
        </span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn ghost sm" disabled={busy != null} onClick={() => fileRef.current?.click()}>
            {busy === "upload" ? "Uploading…" : "Upload"}
          </button>
          <button type="button" className="btn ghost sm" disabled={busy != null} onClick={() => setGenOpen(true)}>
            Generate with AI
          </button>
          {url ? (
            <button type="button" className="btn ghost sm danger" disabled={busy != null} onClick={onRemove}>
              {busy === "remove" ? "Removing…" : "Remove"}
            </button>
          ) : null}
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onUpload(f);
              e.target.value = "";
            }}
          />
        </div>
      </div>
      {err ? (
        <p className="chip crit" style={{ marginTop: 12 }}>
          <span className="d" />
          {err}
        </p>
      ) : null}
      <BrandArtDialog
        open={genOpen}
        onClose={() => setGenOpen(false)}
        title="Generate channel logo"
        currentUrl={url}
        defaultPrompt={defaultPrompt}
        references={references}
        generate={(opts) => generateChannelLogoAction(channelId, opts)}
        onDone={(u) => {
          setUrl(`${u}?t=${Date.now()}`);
          router.refresh();
        }}
      />
    </div>
  );
}
