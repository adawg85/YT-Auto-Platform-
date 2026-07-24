import { Readable, Transform } from "node:stream";
import type { CostSink } from "@ytauto/core";
import type { ObjectStore, PublishProvider, YouTubeAuthResolver } from "../types";

/**
 * Re-encode any stored image into a thumbnail YouTube's `thumbnails.set` will
 * accept (2026-07-19 operator: a live video shipped a plain frame — the push
 * 400'd with `invalidImage`). Generated hero thumbnails are frequently large
 * PNGs (>2 MB) or off-spec sizes, both of which YouTube rejects. Normalize to a
 * ≤1280×720 JPEG under the 2 MB cap, dropping quality until it fits.
 *
 * sharp is a native module — imported dynamically so it stays OUT of the Next
 * static bundle (its optional libvips sub-deps break webpack), loaded lazily at
 * push time on the server only.
 */
const YT_THUMB_MAX_BYTES = 1_950_000; // safety margin under YouTube's hard 2 MB
async function toYouTubeThumbnail(raw: Buffer): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const base = sharp(raw, { failOn: "none" })
    .rotate() // bake in EXIF orientation before we drop the metadata
    .resize({ width: 1280, height: 720, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#000000" }); // JPEG has no alpha — composite on black
  for (const quality of [88, 80, 72, 62, 50, 40]) {
    const out = await base.clone().jpeg({ quality }).toBuffer();
    if (out.byteLength <= YT_THUMB_MAX_BYTES) return out;
  }
  return base.clone().jpeg({ quality: 35 }).toBuffer();
}

/** "PT1H2M3S" → seconds; null for absent/unparseable (i.e. no processed media). */
function parseIsoDuration(iso: string | undefined): number | null {
  if (!iso) return null;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

type VideoDetails = {
  privacyStatus?: string;
  publishAt?: string;
  /** snippet.publishedAt — the real go-live time (see PublishProvider type) */
  publishedAt?: string;
  uploadStatus?: string;
  processingStatus?: string;
  durationSec: number | null;
} | null;

/** videos.list read of status + media presence (contentDetails.duration). */
async function fetchVideoDetails(accessToken: string, videoId: string): Promise<VideoDetails> {
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=snippet,status,contentDetails,processingDetails&id=${encodeURIComponent(videoId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) throw new Error(`YouTube videos.list failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as {
    items?: {
      snippet?: { publishedAt?: string };
      status?: { privacyStatus?: string; publishAt?: string; uploadStatus?: string };
      contentDetails?: { duration?: string };
      processingDetails?: { processingStatus?: string };
    }[];
  };
  const item = json.items?.[0];
  if (!item) return null;
  return {
    privacyStatus: item.status?.privacyStatus,
    publishAt: item.status?.publishAt,
    publishedAt: item.snippet?.publishedAt,
    uploadStatus: item.status?.uploadStatus,
    processingStatus: item.processingDetails?.processingStatus,
    durationSec: parseIsoDuration(item.contentDetails?.duration),
  };
}

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
      // Stream from the store — a long-form final.mp4 is hundreds of MB, and
      // the old getBuffer path held ~3 copies in heap (2026-07-12 shell-video
      // incident: a broken upload produced a YouTube record with no media).
      const { stream, contentLength } = await store.getStream(req.videoStorageKey);
      if (!contentLength || contentLength <= 0) {
        throw new Error(
          `Refusing to upload ${req.videoStorageKey}: store reports no content length (empty or unreadable object)`,
        );
      }

      const metadata = {
        snippet: {
          title: req.title.slice(0, 100),
          description: req.description.slice(0, 4900),
          tags: req.tags.slice(0, 30),
          categoryId: "27", // Education; per-channel config later
        },
        status: {
          privacyStatus: req.privacy,
          // YouTube-native scheduling (#20): publishAt requires privacyStatus
          // "private"; YouTube flips the video public at this time itself.
          ...(req.publishAt ? { publishAt: req.publishAt } : {}),
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
            "x-upload-content-length": String(contentLength),
          },
          body: JSON.stringify(metadata),
        },
      );
      if (!init.ok) throw new Error(`YouTube upload init failed (${init.status}): ${await init.text()}`);
      const uploadUrl = init.headers.get("location");
      if (!uploadUrl) throw new Error("YouTube upload init returned no session location");

      // 2) upload bytes (single shot; resume-on-interrupt can come later).
      // Count what actually leaves the store so a silently-truncated stream
      // can never be mistaken for a completed upload.
      let sentBytes = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          sentBytes += chunk.length;
          cb(null, chunk);
        },
      });
      const up = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "content-type": "video/mp4", "content-length": String(contentLength) },
        body: Readable.toWeb(stream.pipe(counter)) as unknown as BodyInit,
        // half-duplex is required by undici for stream request bodies
        duplex: "half",
      } as RequestInit);
      if (!up.ok) throw new Error(`YouTube upload failed (${up.status}): ${await up.text()}`);
      if (sentBytes !== contentLength) {
        throw new Error(
          `YouTube upload stream truncated: sent ${sentBytes} of ${contentLength} bytes for ${req.videoStorageKey}`,
        );
      }
      const json = (await up.json()) as { id: string };

      // 3) shell guard: YouTube must acknowledge the bytes. A record whose
      // uploadStatus is failed/rejected (or that vanished) will never process
      // — fail HERE, loudly, instead of scheduling a video that can't go live.
      const details = await fetchVideoDetails(accessToken, json.id);
      if (!details) {
        throw new Error(`YouTube upload returned id ${json.id} but videos.list cannot see it`);
      }
      if (details.uploadStatus === "failed" || details.uploadStatus === "rejected") {
        throw new Error(
          `YouTube reports uploadStatus=${details.uploadStatus} for ${json.id} immediately after upload`,
        );
      }

      await costSink.record({
        category: "publish",
        provider: "youtube",
        units: { quotaUnits: 1600, bytes: contentLength },
        costUsd: 0,
        channelId: req.channelId,
        productionId: req.productionId,
        meta: {
          privacy: req.privacy,
          aiDisclosure: req.selfDeclaredAiContent,
          videoId: json.id,
          ...(req.publishAt ? { publishAt: req.publishAt } : {}),
        },
      });
      return { providerVideoId: json.id, url: `https://www.youtube.com/watch?v=${json.id}` };
    },

    async findRecentUpload({ channelId, title, withinMinutes }) {
      // Duplicate-upload guard: check the channel's own uploads playlist for a
      // video with this EXACT title published within the window. Two cheap
      // reads (channels.list + playlistItems.list ≈ 2 quota units) versus a
      // duplicate 1,600-unit upload. Fails open (null) — a read error must
      // never block publishing, only forfeit the adoption shortcut.
      try {
        const accessToken = await getAccessToken(await authFor(channelId));
        const headers = { Authorization: `Bearer ${accessToken}` };
        const chRes = await fetch(
          "https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true",
          { headers },
        );
        if (!chRes.ok) return null;
        const chJson = (await chRes.json()) as {
          items?: { contentDetails?: { relatedPlaylists?: { uploads?: string } } }[];
        };
        const uploadsPlaylist = chJson.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
        if (!uploadsPlaylist) return null;
        const plRes = await fetch(
          `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=25&playlistId=${encodeURIComponent(uploadsPlaylist)}`,
          { headers },
        );
        if (!plRes.ok) return null;
        const plJson = (await plRes.json()) as {
          items?: {
            snippet?: {
              title?: string;
              publishedAt?: string;
              resourceId?: { videoId?: string };
            };
          }[];
        };
        const cutoff = Date.now() - withinMinutes * 60_000;
        for (const item of plJson.items ?? []) {
          const s = item.snippet;
          if (!s?.resourceId?.videoId || s.title !== title) continue;
          if (!s.publishedAt || new Date(s.publishedAt).getTime() < cutoff) continue;
          // Shell guard: an aborted resumable session leaves a record with
          // this exact title but no media ("Processing will begin shortly"
          // forever). Adopting one turns a failed upload into a scheduled
          // release that silently never happens — only adopt processed media.
          const details = await fetchVideoDetails(accessToken, s.resourceId.videoId);
          if (details?.durationSec == null) continue;
          return s.resourceId.videoId;
        }
        return null;
      } catch {
        return null;
      }
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

    async schedule({ channelId, providerVideoId, publishAt }) {
      // Reschedule a natively-scheduled video: one videos.update moving
      // status.publishAt (privacyStatus must stay "private" alongside it).
      // publishAt null = CANCEL: videos.update replaces every mutable property
      // of the parts in the request body, so a status object WITHOUT publishAt
      // clears the pending schedule and the video stays plain private.
      const accessToken = await getAccessToken(await authFor(channelId));
      const res = await fetch("https://www.googleapis.com/youtube/v3/videos?part=status", {
        method: "PUT",
        headers: { Authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          id: providerVideoId,
          status: {
            privacyStatus: "private",
            ...(publishAt ? { publishAt } : {}),
            selfDeclaredMadeForKids: false,
          },
        }),
      });
      if (!res.ok) throw new Error(`YouTube reschedule failed (${res.status}): ${await res.text()}`);
      await costSink.record({
        category: "publish",
        provider: "youtube",
        units: { quotaUnits: 50 },
        costUsd: 0,
        channelId,
        meta: {
          action: publishAt ? "reschedule" : "unschedule",
          videoId: providerVideoId,
          ...(publishAt ? { publishAt } : {}),
        },
      });
    },

    async deleteVideo({ channelId, providerVideoId }) {
      const accessToken = await getAccessToken(await authFor(channelId));
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?id=${encodeURIComponent(providerVideoId)}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } },
      );
      // 404 = already gone (a prior delete, or deleted in Studio): treat as
      // success so the supersede cleanup is idempotent and never wedges.
      if (!res.ok && res.status !== 404) {
        throw new Error(`YouTube delete failed (${res.status}): ${await res.text()}`);
      }
      await costSink.record({
        category: "publish",
        provider: "youtube",
        units: { quotaUnits: 50 },
        costUsd: 0,
        channelId,
        meta: { action: "delete", videoId: providerVideoId },
      });
    },

    async videoStatus({ channelId, providerVideoId }) {
      // Reconciliation read (1 quota unit — deliberately not written to
      // cost_records: the finalize cron polls every 10 min and the noise would
      // drown the ledger for a negligible share of the 10k/day budget).
      try {
        const accessToken = await getAccessToken(await authFor(channelId));
        const details = await fetchVideoDetails(accessToken, providerVideoId);
        if (!details) return { state: "missing" as const };
        return {
          state: "found" as const,
          privacyStatus: (details.privacyStatus ?? "private") as "private" | "public" | "unlisted",
          publishAt: details.publishAt ?? null,
          publishedAt: details.publishedAt ?? null,
          durationSec: details.durationSec,
          uploadStatus: details.uploadStatus ?? null,
          processingStatus: details.processingStatus ?? null,
        };
      } catch {
        return { state: "unknown" as const };
      }
    },

    async setThumbnail({ channelId, productionId, providerVideoId, imageStorageKey }) {
      const accessToken = await getAccessToken(await authFor(channelId));
      const raw = await store.getBuffer(imageStorageKey);
      // Always normalize to a YouTube-safe JPEG — the stored key may be an
      // oversized/off-spec PNG that 400s as `invalidImage` when sent as-is.
      const image = await toYouTubeThumbnail(raw);
      const res = await fetch(
        `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(providerVideoId)}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "content-type": "image/jpeg" },
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

    async setChannelBanner({ channelId, imageStorageKey }) {
      const accessToken = await getAccessToken(await authFor(channelId));
      const image = await store.getBuffer(imageStorageKey);
      const mime = imageStorageKey.endsWith(".png") ? "image/png" : "image/jpeg";
      // 1) media-upload the banner — YouTube stores it and hands back a URL
      const up = await fetch(
        "https://www.googleapis.com/upload/youtube/v3/channelBanners/insert",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "content-type": mime },
          body: new Uint8Array(image),
        },
      );
      if (!up.ok) throw new Error(`YouTube banner upload failed (${up.status}): ${await up.text()}`);
      const { url: bannerUrl } = (await up.json()) as { url?: string };
      if (!bannerUrl) throw new Error("YouTube banner upload returned no URL");
      // 2) resolve the authorized channel's id and apply the banner
      const who = await fetch("https://www.googleapis.com/youtube/v3/channels?part=id&mine=true", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!who.ok) throw new Error(`YouTube channel lookup failed (${who.status}): ${await who.text()}`);
      const ytChannelId = ((await who.json()) as { items?: { id: string }[] }).items?.[0]?.id;
      if (!ytChannelId) throw new Error("No YouTube channel on this account");
      const apply = await fetch("https://www.googleapis.com/youtube/v3/channels?part=brandingSettings", {
        method: "PUT",
        headers: { Authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          id: ytChannelId,
          brandingSettings: { image: { bannerExternalUrl: bannerUrl } },
        }),
      });
      if (!apply.ok) throw new Error(`YouTube banner apply failed (${apply.status}): ${await apply.text()}`);
      await costSink.record({
        category: "publish",
        provider: "youtube",
        units: { quotaUnits: 100 },
        costUsd: 0,
        channelId,
        meta: { action: "set_channel_banner", imageStorageKey },
      });
      return { bannerUrl };
    },
  };
}
