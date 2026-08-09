import type { MusicCandidate, MusicLibraryProvider, ObjectStore } from "../types";

/**
 * Openverse CC-audio backend for the per-channel music bed (free, keyless).
 *
 * Openverse indexes ~openly-licensed audio (Jamendo, Wikimedia, ccMixter, …)
 * behind one API. We search it for a mood/query, hand the operator direct audio
 * URLs to preview, and — on "use" — download the chosen track into our own
 * store so the render never hotlinks. We keep only permissive licences
 * (CC0/PD/CC-BY/CC-BY-SA) so a monetized video stays clear; -NC/-ND are
 * dropped. Anonymous access is rate-limited; OPENVERSE_CLIENT_ID/SECRET lift
 * the cap ~100x (a Bearer token is fetched lazily and cached). Search failures
 * degrade to []; import failures return { ok: false, reason } naming the host
 * and cause (#110 — a generic failure hid a systemic CDN block behind a
 * per-asset-looking "try another").
 */
const OPENVERSE_AUDIO = "https://api.openverse.org/v1/audio/";
// Permissive licences only (monetized + edited): CC0, public-domain mark, and
// CC-BY / CC-BY-SA. Excludes -NC and -ND.
const LICENCES = "cc0,pdm,by,by-sa";
const DOWNLOAD_CAP_BYTES = 60 * 1024 * 1024; // a bed track is minutes, not an album

// Openverse hands back direct file URLs on many hosts (cdn.freesound.org,
// Jamendo, Wikimedia, …). Some of those CDNs refuse fetches that don't look
// like a browser — undici's default is `user-agent: node`, which is exactly
// the kind of UA cdn.freesound.org 403s (#110: every import failed while
// search worked). So the media download itself goes out browser-shaped, with
// a Referer for freesound hosts, which gate previews on it.
const DOWNLOAD_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  accept: "audio/*,*/*;q=0.8",
};

export function downloadHeaders(audioUrl: string): Record<string, string> {
  const headers = { ...DOWNLOAD_HEADERS };
  const host = hostOf(audioUrl);
  if (host === "freesound.org" || host.endsWith(".freesound.org")) {
    headers.referer = "https://freesound.org/";
  }
  return headers;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Name the actual fetch failure — timeout vs refused vs DNS — with the host. */
export function describeFetchFailure(host: string, err: unknown, timeoutSec: number): string {
  const e = err as { name?: string; message?: string; cause?: { message?: string; code?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") {
    return `timed out after ${timeoutSec}s fetching ${host}`;
  }
  const detail = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(err);
  return `network error fetching ${host} (${detail})`;
}

function licenceLabel(license?: string, version?: string | null): string {
  const l = (license ?? "").toLowerCase();
  if (l === "cc0") return "CC0";
  if (l === "pdm") return "Public domain";
  return `CC ${l.toUpperCase()}${version ? ` ${version}` : ""}`.trim();
}

// ── Openverse OAuth (optional; anonymous works without it) ──────────────────
let token: { value: string; expiresAt: number } | null = null;

function configured(): boolean {
  return Boolean(process.env.OPENVERSE_CLIENT_ID && process.env.OPENVERSE_CLIENT_SECRET);
}

async function authHeader(now: number): Promise<Record<string, string>> {
  if (!configured()) return {};
  if (token && now < token.expiresAt) return { authorization: `Bearer ${token.value}` };
  try {
    const res = await fetch("https://api.openverse.org/v1/auth_tokens/token/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.OPENVERSE_CLIENT_ID!,
        client_secret: process.env.OPENVERSE_CLIENT_SECRET!,
        grant_type: "client_credentials",
      }),
    });
    if (!res.ok) return {};
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) return {};
    token = { value: json.access_token, expiresAt: now + Math.max(60, (json.expires_in ?? 43200) - 300) * 1000 };
    return { authorization: `Bearer ${token.value}` };
  } catch {
    return {};
  }
}

type OpenverseAudio = {
  id?: string;
  title?: string;
  url?: string;
  foreign_landing_url?: string;
  creator?: string | null;
  license?: string | null;
  license_version?: string | null;
  duration?: number | null; // milliseconds
  filetype?: string | null;
};

export function createOpenverseMusicProvider(store: ObjectStore): MusicLibraryProvider {
  return {
    name: "openverse-audio",

    async search(query, opts) {
      const limit = Math.max(1, Math.min(20, opts?.limit ?? 12));
      try {
        const res = await fetch(
          `${OPENVERSE_AUDIO}?q=${encodeURIComponent(query)}&license=${LICENCES}&page_size=${limit}`,
          {
            headers: { accept: "application/json", ...(await authHeader(Date.now())) },
            signal: AbortSignal.timeout(12000),
          },
        );
        if (!res.ok) return [];
        const json = (await res.json()) as { results?: OpenverseAudio[] };
        const out: MusicCandidate[] = [];
        for (const r of json.results ?? []) {
          if (!r.id || !r.url) continue;
          out.push({
            id: r.id,
            title: r.title?.trim() || "Untitled track",
            audioUrl: r.url,
            pageUrl: r.foreign_landing_url ?? r.url,
            creator: r.creator?.trim() || "Unknown",
            license: licenceLabel(r.license ?? undefined, r.license_version),
            durationSec: r.duration != null ? Math.round(r.duration / 1000) : undefined,
          });
        }
        return out;
      } catch {
        return [];
      }
    },

    async importTrack({ audioUrl, storageKeyBase }) {
      const host = hostOf(audioUrl);
      let res: Response;
      try {
        res = await fetch(audioUrl, {
          headers: downloadHeaders(audioUrl),
          redirect: "follow",
          signal: AbortSignal.timeout(30000),
        });
      } catch (err) {
        return { ok: false, reason: describeFetchFailure(host, err, 30) };
      }
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status} from ${host}` };
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > DOWNLOAD_CAP_BYTES) {
        return {
          ok: false,
          reason: `file is ${Math.round(declared / 1024 / 1024)}MB, over the ${DOWNLOAD_CAP_BYTES / 1024 / 1024}MB cap (${host})`,
        };
      }
      const ct = res.headers.get("content-type") ?? "";
      const mimeType = ct.startsWith("audio/") ? ct : "audio/mpeg";
      const ext = mimeType.includes("wav") ? "wav" : mimeType.includes("ogg") ? "ogg" : "mp3";
      let buf: Buffer;
      try {
        buf = Buffer.from(await res.arrayBuffer());
      } catch (err) {
        return { ok: false, reason: describeFetchFailure(host, err, 30) };
      }
      if (buf.length < 1024) {
        return { ok: false, reason: `${host} returned ${buf.length} bytes — not an audio file` };
      }
      if (buf.length > DOWNLOAD_CAP_BYTES) {
        return {
          ok: false,
          reason: `file is ${Math.round(buf.length / 1024 / 1024)}MB, over the ${DOWNLOAD_CAP_BYTES / 1024 / 1024}MB cap (${host})`,
        };
      }
      const storageKey = `${storageKeyBase}.${ext}`;
      try {
        await store.put(storageKey, buf, mimeType);
      } catch (err) {
        // NOT a download problem — don't let a storage outage masquerade as one
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: `downloaded fine but storing failed (${msg})` };
      }
      return { ok: true, storageKey, mimeType };
    },

    async probeDownload(audioUrl) {
      const host = hostOf(audioUrl);
      try {
        const res = await fetch(audioUrl, {
          headers: { ...downloadHeaders(audioUrl), range: "bytes=0-1023" },
          redirect: "follow",
          signal: AbortSignal.timeout(8000),
        });
        await res.body?.cancel().catch(() => {});
        if (!res.ok) return { ok: false, detail: `HTTP ${res.status} from ${host}` };
        return { ok: true, detail: `HTTP ${res.status} from ${host}` };
      } catch (err) {
        return { ok: false, detail: describeFetchFailure(host, err, 8) };
      }
    },
  };
}
