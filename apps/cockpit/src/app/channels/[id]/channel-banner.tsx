"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  generateChannelBannerAssetAction,
  pushBannerToYouTubeAction,
  revertBrandArtAction,
  setChannelBannerAction,
} from "../actions";
import { BrandArtDialog } from "./brand-art-dialog";

/**
 * Channel banner control (Settings tab, 2026-07-14 operator ask): generate
 * 16:9 banner art with the hero image model after the fact. Generation opens
 * a dialog showing the exact editable prompt plus a Reference select
 * (characters / style scenes / current banner) so the art can stay
 * consistent with the channel's cast and look. YouTube's API can't set
 * banners, so the flow is generate → download → upload by hand at 2560×1440.
 */
export function ChannelBanner({
  channelId,
  bannerKey,
  name,
  niche,
  imageStyle,
  styleBlock,
  taglineDefault,
  references,
  history,
  connected,
}: {
  channelId: string;
  bannerKey: string | null;
  name: string;
  niche: string;
  imageStyle: string | null;
  styleBlock: string | null;
  taglineDefault: string | null;
  references: { value: string; label: string; description?: string }[];
  history: { key: string; label: string }[];
  /** YouTube connected — enables one-click banner push */
  connected: boolean;
}) {
  const router = useRouter();
  const [url, setUrl] = useState<string | null>(bannerKey ? `/api/media/${bannerKey}` : null);
  const [busy, setBusy] = useState<"remove" | "push" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pushMsg, setPushMsg] = useState<string | null>(null);
  /** which dialog is open — keyed so refine/generate defaults reset cleanly */
  const [genMode, setGenMode] = useState<"generate" | "refine" | null>(null);

  async function onRemove() {
    setBusy("remove");
    setErr(null);
    await setChannelBannerAction(channelId, null);
    setUrl(null);
    router.refresh();
    setBusy(null);
  }

  async function onPush() {
    setBusy("push");
    setErr(null);
    setPushMsg(null);
    const res = await pushBannerToYouTubeAction(channelId);
    if ("error" in res) setErr(res.error);
    else setPushMsg("Banner set on YouTube — it can take a minute to appear on the channel page.");
    setBusy(null);
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Channel banner</h2>
      <p className="muted" style={{ margin: "-6px 0 14px", fontSize: 12.5 }}>
        Wide channel art. Push it straight to YouTube with one click (needs the connection above),
        or download and upload by hand — keep the key art inside the 1546×423 safe-area either way.
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
        <button type="button" className="btn ghost sm" disabled={busy != null} onClick={() => setGenMode("generate")}>
          Generate with AI
        </button>
        {url ? (
          <>
            <button type="button" className="btn ghost sm" disabled={busy != null} onClick={() => setGenMode("refine")}>
              Refine
            </button>
            <button
              type="button"
              className="btn ghost sm"
              disabled={busy != null || !connected}
              title={connected ? undefined : "Connect YouTube above to push the banner directly"}
              onClick={onPush}
            >
              {busy === "push" ? "Pushing…" : "Push to YouTube"}
            </button>
            <a className="btn ghost sm" href={url} download="channel-banner">
              Download
            </a>
            <button type="button" className="btn ghost sm danger" disabled={busy != null} onClick={onRemove}>
              {busy === "remove" ? "Removing…" : "Remove"}
            </button>
          </>
        ) : null}
      </div>
      {pushMsg ? (
        <p className="chip good" style={{ marginTop: 12 }}>
          <span className="d" />
          {pushMsg}
        </p>
      ) : null}
      {err ? (
        <p className="chip crit" style={{ marginTop: 12 }}>
          <span className="d" />
          {err}
        </p>
      ) : null}
      {genMode && (
        <BrandArtDialog
          key={genMode}
          open
          onClose={() => setGenMode(null)}
          title={genMode === "refine" ? "Refine channel banner" : "Generate channel banner"}
          surface="banner"
          mode={genMode}
          channelName={name}
          niche={niche}
          imageStyle={imageStyle}
          styleBlock={styleBlock}
          taglineDefault={taglineDefault}
          currentUrl={url}
          references={references}
          history={history}
          generate={(opts) => generateChannelBannerAssetAction(channelId, { ...opts, mode: genMode })}
          onRevert={(key) => revertBrandArtAction(channelId, "banner", key)}
          onDone={(u) => {
            setUrl(`${u}?t=${Date.now()}`);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
