import type { CostSink } from "@ytauto/core";
import type { ObjectStore, PublishProvider, YouTubeAuthResolver } from "../types";

async function getAccessToken(auth: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
      refresh_token: auth.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`YouTube OAuth refresh failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

/**
 * YouTube Data API v3 resumable upload, always private at upload time.
 * Sets the synthetic-media disclosure flag (compliance §8.3). Quota units
 * are tracked in cost_records (upload ~1,600; release ~50 of 10,000/day).
 * OAuth is resolved per channel via the encrypted secrets table.
 */
export function createYouTubePublishProvider(
  resolveAuth: YouTubeAuthResolver,
  store: ObjectStore,
  costSink: CostSink,
): PublishProvider {
  async function authFor(channelId: string) {
    const auth = await resolveAuth(channelId);
    if (!auth) {
      throw new Error(
        `Channel ${channelId} has no YouTube credentials — connect it on the channel page (or set YOUTUBE_REFRESH_TOKEN)`,
      );
    }
    return auth;
  }

  return {
    name: "youtube",
    async upload(req) {
      const accessToken = await getAccessToken(await authFor(req.channelId));
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

      // 2) upload bytes (single shot; resume-on-interrupt can come later)
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

    async release({ channelId, providerVideoId }) {
      const accessToken = await getAccessToken(await authFor(channelId));
      const res = await fetch("https://www.googleapis.com/youtube/v3/videos?part=status", {
        method: "PUT",
        headers: { Authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          id: providerVideoId,
          status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
        }),
      });
      if (!res.ok) throw new Error(`YouTube release failed (${res.status}): ${await res.text()}`);
      await costSink.record({
        category: "publish",
        provider: "youtube",
        units: { quotaUnits: 50 },
        costUsd: 0,
        channelId,
        meta: { action: "release", videoId: providerVideoId },
      });
    },

    async setThumbnail({ channelId, productionId, providerVideoId, imageStorageKey }) {
      const accessToken = await getAccessToken(await authFor(channelId));
      const image = await store.getBuffer(imageStorageKey);
      const mime = imageStorageKey.endsWith(".png") ? "image/png" : "image/jpeg";
      const res = await fetch(
        `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(providerVideoId)}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "content-type": mime },
          body: new Uint8Array(image),
        },
      );
      if (!res.ok) throw new Error(`YouTube thumbnail set failed (${res.status}): ${await res.text()}`);
      await costSink.record({
        category: "publish",
        provider: "youtube",
        units: { quotaUnits: 50 },
        costUsd: 0,
        channelId,
        productionId,
        meta: { action: "set_thumbnail", videoId: providerVideoId, imageStorageKey },
      });
    },
  };
}
