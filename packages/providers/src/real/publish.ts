import type { CostSink } from "@ytauto/core";
import type { ObjectStore, PublishProvider } from "../types";

export type YouTubeOAuthConfig = {
  clientId: string;
  clientSecret: string;
  /** v1: one refresh token via env; Phase 3 moves to per-channel token storage */
  refreshToken: string;
};

async function getAccessToken(cfg: YouTubeOAuthConfig): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`YouTube OAuth refresh failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

/**
 * YouTube Data API v3 resumable upload, always private in the vertical slice.
 * Sets the synthetic-media disclosure flag (compliance §8.3). Quota units are
 * tracked in cost_records (an upload costs ~1,600 of the 10,000/day default).
 */
export function createYouTubePublishProvider(
  cfg: YouTubeOAuthConfig,
  store: ObjectStore,
  costSink: CostSink,
): PublishProvider {
  return {
    name: "youtube",
    async upload(req) {
      const accessToken = await getAccessToken(cfg);
      const video = await store.getBuffer(req.videoStorageKey);

      const metadata = {
        snippet: {
          title: req.title.slice(0, 100),
          description: req.description.slice(0, 4900),
          tags: req.tags.slice(0, 30),
          categoryId: "27", // Education; per-channel config later
        },
        status: {
          privacyStatus: req.privacy,
          selfDeclaredMadeForKids: req.madeForKids,
          containsSyntheticMedia: req.selfDeclaredAiContent,
        },
      };

      // 1) initiate resumable session
      const init = await fetch(
        "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            "x-upload-content-type": "video/mp4",
            "x-upload-content-length": String(video.length),
          },
          body: JSON.stringify(metadata),
        },
      );
      if (!init.ok) throw new Error(`YouTube upload init failed (${init.status}): ${await init.text()}`);
      const uploadUrl = init.headers.get("location");
      if (!uploadUrl) throw new Error("YouTube upload init returned no session location");

      // 2) upload bytes (single shot; resume-on-interrupt can come with Phase 3)
      const up = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "content-type": "video/mp4", "content-length": String(video.length) },
        body: new Uint8Array(video),
      });
      if (!up.ok) throw new Error(`YouTube upload failed (${up.status}): ${await up.text()}`);
      const json = (await up.json()) as { id: string };

      await costSink.record({
        category: "publish",
        provider: "youtube",
        units: { quotaUnits: 1600, bytes: video.length },
        costUsd: 0,
        channelId: req.channelId,
        productionId: req.productionId,
        meta: { privacy: req.privacy, aiDisclosure: req.selfDeclaredAiContent, videoId: json.id },
      });
      return { providerVideoId: json.id, url: `https://www.youtube.com/watch?v=${json.id}` };
    },
  };
}
