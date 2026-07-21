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
 * the cap ~100x (a Bearer token is fetched lazily and cached). Every failure
 * degrades to [] / null so music never blocks a render.
 */
const OPENVERSE_AUDIO = "https://api.openverse.org/v1/audio/";
// Permissive licences only (monetized + edited): CC0, public-domain mark, and
// CC-BY / CC-BY-SA. Excludes -NC and -ND.
const LICENCES = "cc0,pdm,by,by-sa";
const DOWNLOAD_CAP_BYTES = 60 * 1024 * 1024; // a bed track is minutes, not an album

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
      try {
        const res = await fetch(audioUrl, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) return null;
        if (Number(res.headers.get("content-length") ?? 0) > DOWNLOAD_CAP_BYTES) return null;
        const ct = res.headers.get("content-type") ?? "";
        const mimeType = ct.startsWith("audio/") ? ct : "audio/mpeg";
        const ext = mimeType.includes("wav") ? "wav" : mimeType.includes("ogg") ? "ogg" : "mp3";
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 1024) return null;
        const storageKey = `${storageKeyBase}.${ext}`;
        await store.put(storageKey, buf, mimeType);
        return { storageKey, mimeType };
      } catch {
        return null;
      }
    },
  };
}
