"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { generateChannelBannerAssetAction, setChannelBannerAction } from "../actions";

/**
 * Channel banner control (Settings tab, 2026-07-14 operator ask): generate
 * 16:9 banner art with the hero image model after the fact — previously only
 * the creation wizard could. YouTube's API can't set banners, so the flow is
 * generate → download → upload by hand at 2560×1440.
 */
export function ChannelBanner({
  channelId,
  bannerKey,
}: {
  channelId: string;
  bannerKey: string | null;
}) {
  const router = useRouter();
  const [url, setUrl] = useState<string | null>(bannerKey ? `/api/media/${bannerKey}` : null);
  const [busy, setBusy] = useState<"generate" | "remove" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function onGenerate() {
    setBusy("generate");
    setErr(null);
    const res = await generateChannelBannerAssetAction(channelId);
    if ("error" in res) setErr(res.error);
    else {
      setUrl(`${res.url}?t=${Date.now()}`);
      router.refresh();
    }
    setBusy(null);
  }

  async function onRemove() {
    setBusy("remove");
    setErr(null);
    await setChannelBannerAction(channelId, null);
    setUrl(null);
    router.refresh();
    setBusy(null);
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Channel banner</h2>
      <p className="muted" style={{ margin: "-6px 0 14px", fontSize: 12.5 }}>
        Wide channel art generated from the name, niche and DNA image style. Download it and upload
        on YouTube at 2560×1440 — keep the key art inside the 1546×423 safe-area (the API can&apos;t
        set banners).
      </p>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt="Channel banner"
          style={{
            width: "100%",
            maxWidth: 560,
            aspectRatio: "16 / 9",
            objectFit: "cover",
            borderRadius: 10,
            display: "block",
            border: "1px solid var(--border)",
            marginBottom: 12,
          }}
        />
      ) : null}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="btn ghost sm" disabled={busy != null} onClick={onGenerate}>
          {busy === "generate" ? "Generating…" : url ? "Regenerate with AI" : "Generate with AI"}
        </button>
        {url ? (
          <>
            <a className="btn ghost sm" href={url} download="channel-banner">
              Download
            </a>
            <button type="button" className="btn ghost sm danger" disabled={busy != null} onClick={onRemove}>
              {busy === "remove" ? "Removing…" : "Remove"}
            </button>
          </>
        ) : null}
      </div>
      {err ? (
        <p className="chip crit" style={{ marginTop: 12 }}>
          <span className="d" />
          {err}
        </p>
      ) : null}
    </div>
  );
}
