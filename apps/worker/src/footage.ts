import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import ffmpegPath from "ffmpeg-static";
import type { ObjectStore } from "@ytauto/providers";

const run = promisify(execFile);

/** ffmpeg-static's postinstall download can fail behind a proxy — fall back
 * to a system ffmpeg on PATH so the clip path degrades instead of dying. */
const FFMPEG_BIN =
  ffmpegPath && existsSync(ffmpegPath as unknown as string) ? (ffmpegPath as unknown as string) : "ffmpeg";

/**
 * Real archival FOOTAGE for hero shots (BACKLOG #26). Archives return whole
 * films (a 30-min documentary), so we search a licence-safe pool, download
 * the smallest derivative once, ffmpeg-trim a beat-length silent segment
 * (scaled/cropped to the render aspect), and store THAT small clip in R2 —
 * the beat renders it via Remotion <OffthreadVideo>. Server-side trim keeps
 * renders (and the frequent re-renders the visuals gate causes) fast and
 * cheap; the clip reuses like any image asset.
 *
 * Sources (keyless): NASA video library + Internet Archive. IA is searched
 * BOTH within known public-domain gov/newsreel collections AND broadened to
 * any movie with a PD/CC licence (operator choice 2026-07-12) — the vision
 * fit-gate in the pipeline rejects an off-subject clip, same as stills.
 */

const UA = process.env.WIKIMEDIA_USER_AGENT?.trim() || "YTAutoPlatform/1.0 (ops@commongroundsocial.com.au)";
// segment offset into the film — skip title cards / leader
const INTRO_SKIP_SEC = 12;
const DOWNLOAD_CAP_BYTES = 400 * 1024 * 1024; // don't pull a multi-GB original
const SAFE_IA_COLLECTIONS = ["FedFlix", "usgovfilms", "prelinger", "nasa", "newsandpublicaffairs"];
// PD / permissive CC licence URLs we accept when broadening beyond the safe
// collections; -NC/-ND are excluded (we monetize / edit).
const OK_LICENCE = /creativecommons\.org\/(publicdomain\/(zero|mark)|licenses\/by(-sa)?\/)/i;

export type FootageClip = {
  storageKey: string;
  mimeType: string;
  sourceUrl: string;
  license: string;
  attribution: string;
};

/**
 * Shared ffmpeg trim/normalize (2026-07-14, extracted for Pexels + AI clips):
 * cut a `clipSec`-long SILENT segment from `src`, scaled/cropped to the
 * aspect, h264 yuv420p faststart — the exact contract Remotion
 * <OffthreadVideo> beats expect. Returns null when the trim produced nothing
 * usable (source shorter than the offset, corrupt file, …).
 */
export async function normalizeClipBuffer(
  src: Buffer,
  opts: { aspect: "9:16" | "16:9" | "1:1"; clipSec: number; introSkipSec?: number },
): Promise<Buffer | null> {
  const [w, h] =
    opts.aspect === "9:16" ? [1080, 1920] : opts.aspect === "16:9" ? [1920, 1080] : [1080, 1080];
  const dir = await mkdtemp(join(tmpdir(), "ytauto-clip-"));
  try {
    const inPath = join(dir, "src.mp4");
    const outPath = join(dir, "clip.mp4");
    await writeFile(inPath, src);
    const filter = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;
    await run(
      FFMPEG_BIN,
      [
        "-y",
        "-ss", String(opts.introSkipSec ?? 0),
        "-t", String(opts.clipSec),
        "-i", inPath,
        "-an", // silent — the voiceover is the only audio
        "-vf", filter,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        outPath,
      ],
      { maxBuffer: 1024 * 1024 * 64 },
    );
    const clip = await readFile(outPath);
    return clip.length < 10_000 ? null : clip;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Downscale an image for vision-LLM input (2026-07-14, distill 502 fix):
 * style extraction doesn't need 2K pixels — max-edge 1024 JPEG cuts a
 * promoted test scene from ~4-6 MB to ~150 KB. Returns the ORIGINAL bytes
 * when ffmpeg can't handle the input (weird format) — callers keep working.
 */
export async function downscaleImage(
  src: Buffer,
  opts: { maxEdge?: number } = {},
): Promise<{ bytes: Buffer; mimeType: string }> {
  const maxEdge = opts.maxEdge ?? 1024;
  const dir = await mkdtemp(join(tmpdir(), "ytauto-img-"));
  try {
    const inPath = join(dir, "src.img");
    const outPath = join(dir, "out.jpg");
    await writeFile(inPath, src);
    await run(
      FFMPEG_BIN,
      [
        "-y",
        "-i", inPath,
        // shrink only — never upscale small refs
        "-vf", `scale='min(${maxEdge},iw)':'min(${maxEdge},ih)':force_original_aspect_ratio=decrease`,
        "-frames:v", "1",
        "-q:v", "4", // ~jpeg q80
        outPath,
      ],
      { maxBuffer: 1024 * 1024 * 64 },
    );
    const out = await readFile(outPath);
    if (out.length < 1_000) return { bytes: src, mimeType: "" };
    return { bytes: out, mimeType: "image/jpeg" };
  } catch {
    return { bytes: src, mimeType: "" };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Pexels stock b-roll (2026-07-14, BACKLOG #26-v2 — the free ultra-low-cost
 * real-footage source). Keyword search with orientation matched to the render
 * aspect, pick the smallest rendition long enough for the beat, trim from 0
 * (stock clips have no leader to skip). Pexels License: free commercial use,
 * attribution optional — we credit anyway via the existing builder.
 */
export async function sourcePexelsClip(
  store: ObjectStore,
  input: {
    query: string;
    aspect: "9:16" | "16:9" | "1:1";
    durationSec: number;
    productionId: string;
    idx: number;
    apiKey: string;
  },
): Promise<FootageClip | null> {
  const orientation = input.aspect === "9:16" ? "portrait" : "landscape";
  const clipSec = Math.max(3, Math.min(15, input.durationSec + 0.4));
  const search = await (async () => {
    try {
      const res = await fetch(
        `https://api.pexels.com/videos/search?query=${encodeURIComponent(input.query)}&orientation=${orientation}&size=medium&per_page=5`,
        { headers: { Authorization: input.apiKey } },
      );
      if (!res.ok) return null;
      return (await res.json()) as {
        videos?: {
          url: string;
          duration: number;
          user?: { name?: string };
          video_files?: { link: string; width?: number; height?: number; file_type?: string }[];
        }[];
      };
    } catch {
      return null;
    }
  })();
  const videos = (search?.videos ?? []).filter((v) => v.duration >= Math.min(clipSec, 4));
  for (const video of videos.slice(0, 3)) {
    // smallest mp4 rendition that still covers the render height — stock
    // originals can be 4K; we downscale anyway
    const target = input.aspect === "9:16" ? 1920 : 1080;
    const files = (video.video_files ?? [])
      .filter((f) => (f.file_type ?? "video/mp4").includes("mp4") && f.link)
      .sort((a, b) => (a.height ?? 0) - (b.height ?? 0));
    const pick = files.find((f) => (f.height ?? 0) >= Math.min(720, target)) ?? files[files.length - 1];
    if (!pick) continue;
    try {
      const res = await fetch(pick.link);
      if (!res.ok) continue;
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > DOWNLOAD_CAP_BYTES) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const clip = await normalizeClipBuffer(buf, { aspect: input.aspect, clipSec, introSkipSec: 0 });
      if (!clip) continue;
      const storageKey = `productions/${input.productionId}/clip-${input.idx}.mp4`;
      await store.put(storageKey, clip, "video/mp4");
      return {
        storageKey,
        mimeType: "video/mp4",
        sourceUrl: video.url,
        license: "Pexels License",
        attribution: video.user?.name ?? "Pexels",
      };
    } catch {
      // this candidate failed — try the next
    }
  }
  return null;
}

type StockClipInput = {
  query: string;
  aspect: "9:16" | "16:9" | "1:1";
  durationSec: number;
  productionId: string;
  idx: number;
  apiKey: string;
};

/** Download → trim/scale → store a candidate clip; null on any failure. */
async function storeClip(
  store: ObjectStore,
  url: string,
  input: StockClipInput,
  clipSec: number,
  meta: { sourceUrl: string; license: string; attribution: string },
): Promise<FootageClip | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    if (Number(res.headers.get("content-length") ?? 0) > DOWNLOAD_CAP_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const clip = await normalizeClipBuffer(buf, { aspect: input.aspect, clipSec, introSkipSec: 0 });
    if (!clip) return null;
    const storageKey = `productions/${input.productionId}/clip-${input.idx}.mp4`;
    await store.put(storageKey, clip, "video/mp4");
    return { storageKey, mimeType: "video/mp4", ...meta };
  } catch {
    return null;
  }
}

/**
 * Pixabay stock video (BACKLOG #7/#36). Free commercial, no attribution
 * required — credited anyway. Same shape/flow as sourcePexelsClip.
 */
export async function sourcePixabayClip(store: ObjectStore, input: StockClipInput): Promise<FootageClip | null> {
  const clipSec = Math.max(3, Math.min(15, input.durationSec + 0.4));
  let hits: { pageURL?: string; duration?: number; user?: string; videos?: Record<string, { url?: string; height?: number }> }[] = [];
  try {
    const res = await fetch(
      `https://pixabay.com/api/videos/?key=${encodeURIComponent(input.apiKey)}&q=${encodeURIComponent(input.query)}&per_page=5`,
      { signal: AbortSignal.timeout(10000) },
    );
    if (!res.ok) return null;
    hits = ((await res.json()) as { hits?: typeof hits }).hits ?? [];
  } catch {
    return null;
  }
  const target = input.aspect === "9:16" ? 1920 : 1080;
  for (const hit of hits.filter((h) => (h.duration ?? 0) >= Math.min(clipSec, 4)).slice(0, 3)) {
    const renditions = Object.values(hit.videos ?? {})
      .filter((v) => v.url)
      .sort((a, b) => (a.height ?? 0) - (b.height ?? 0));
    const pick = renditions.find((v) => (v.height ?? 0) >= Math.min(720, target)) ?? renditions[renditions.length - 1];
    if (!pick?.url) continue;
    const clip = await storeClip(store, pick.url, input, clipSec, {
      sourceUrl: hit.pageURL ?? "https://pixabay.com",
      license: "Pixabay License",
      attribution: hit.user ?? "Pixabay",
    });
    if (clip) return clip;
  }
  return null;
}

/**
 * Coverr stock video (BACKLOG #7/#36). Free commercial. The API shape varies;
 * this is defensive and returns null on anything unexpected.
 */
export async function sourceCoverrClip(store: ObjectStore, input: StockClipInput): Promise<FootageClip | null> {
  const clipSec = Math.max(3, Math.min(15, input.durationSec + 0.4));
  let hits: { id?: string; urls?: { mp4?: string; mp4_download?: string } }[] = [];
  try {
    const res = await fetch(
      `https://api.coverr.co/videos?query=${encodeURIComponent(input.query)}&page_size=5&urls=true`,
      { headers: { Authorization: `Bearer ${input.apiKey}` }, signal: AbortSignal.timeout(10000) },
    );
    if (!res.ok) return null;
    hits = ((await res.json()) as { hits?: typeof hits }).hits ?? [];
  } catch {
    return null;
  }
  for (const hit of hits.slice(0, 3)) {
    const url = hit.urls?.mp4_download ?? hit.urls?.mp4;
    if (!url) continue;
    const clip = await storeClip(store, url, input, clipSec, {
      sourceUrl: hit.id ? `https://coverr.co/videos/${hit.id}` : "https://coverr.co",
      license: "Coverr License",
      attribution: "Coverr",
    });
    if (clip) return clip;
  }
  return null;
}

type Candidate = { downloadUrl: string; pageUrl: string; license: string; attribution: string };

async function fetchJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** NASA video: search → asset manifest → smallest usable mp4 rendition. */
async function nasaVideoCandidates(query: string): Promise<Candidate[]> {
  const search = await fetchJson(
    `https://images-api.nasa.gov/search?q=${encodeURIComponent(query)}&media_type=video&page_size=8`,
  );
  const items: any[] = search?.collection?.items ?? [];
  const out: Candidate[] = [];
  for (const it of items.slice(0, 4)) {
    const data = it?.data?.[0];
    if (!data?.nasa_id) continue;
    const manifest = await fetchJson(
      `https://images-api.nasa.gov/asset/${encodeURIComponent(data.nasa_id)}`,
    );
    const hrefs: string[] = (manifest?.collection?.items ?? []).map((m: any) => m.href).filter(Boolean);
    // prefer a mid-size rendition: ~medium, else ~mobile, else any mp4
    const mp4 = hrefs.filter((h) => h.endsWith(".mp4"));
    const pick =
      mp4.find((h) => h.includes("~medium")) ??
      mp4.find((h) => h.includes("~mobile")) ??
      mp4.find((h) => h.includes("~large")) ??
      mp4[0];
    if (!pick) continue;
    out.push({
      downloadUrl: pick.replace(/^http:/, "https:"),
      pageUrl: `https://images.nasa.gov/details/${encodeURIComponent(data.nasa_id)}`,
      license: "Public domain (NASA)",
      attribution: data.center || data.photographer || "NASA",
    });
  }
  return out;
}

/** Internet Archive: safe collections first, then licence-filtered broaden. */
async function iaCandidates(query: string): Promise<Candidate[]> {
  const collClause = `(${SAFE_IA_COLLECTIONS.map((c) => `collection:${c}`).join(" OR ")})`;
  const fl = "&fl[]=identifier&fl[]=title&fl[]=licenseurl";
  const mk = (q: string) =>
    `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}${fl}&rows=8&output=json`;
  const safe = await fetchJson(mk(`${query} AND mediatype:movies AND ${collClause}`));
  const broad = await fetchJson(mk(`${query} AND mediatype:movies AND licenseurl:[* TO *]`));
  const docs = [...(safe?.response?.docs ?? []), ...(broad?.response?.docs ?? [])];
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const d of docs) {
    const id = d?.identifier;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const lic: string = d?.licenseurl ?? "";
    // safe-collection items are PD by provenance; broadened items must match
    const fromSafe = safe?.response?.docs?.some((s: any) => s.identifier === id);
    if (!fromSafe && !OK_LICENCE.test(lic)) continue;
    const meta = await fetchJson(`https://archive.org/metadata/${encodeURIComponent(id)}`);
    const files: any[] = meta?.files ?? [];
    // prefer a compact derivative (512kb/h.264 mp4), not the multi-GB original
    const mp4 = files
      .filter((f) => typeof f.name === "string" && f.name.endsWith(".mp4"))
      .sort((a, b) => Number(a.size ?? 0) - Number(b.size ?? 0));
    const chosen = mp4[0];
    if (!chosen) continue;
    out.push({
      downloadUrl: `https://archive.org/download/${encodeURIComponent(id)}/${encodeURIComponent(chosen.name)}`,
      pageUrl: `https://archive.org/details/${encodeURIComponent(id)}`,
      license: OK_LICENCE.test(lic)
        ? lic.includes("publicdomain")
          ? "Public domain"
          : `CC ${/by-sa/i.test(lic) ? "BY-SA" : "BY"} (via Internet Archive)`
        : "Public domain (US government)",
      attribution: (meta?.metadata?.creator as string) || "Internet Archive",
    });
  }
  return out;
}

/**
 * Source ONE hero clip for the shot: search both archives, download the
 * first candidate's derivative, trim a `durationSec`-long silent segment
 * scaled to the aspect, store to R2. Returns null on any miss (the pipeline
 * falls back to a still). The vision fit-gate validates the result upstream.
 */
export async function sourceHeroClip(
  store: ObjectStore,
  input: {
    entity: string;
    hint?: string;
    aspect: "9:16" | "16:9" | "1:1";
    durationSec: number;
    productionId: string;
    idx: number;
  },
): Promise<FootageClip | null> {
  const query = input.hint ? `${input.entity} ${input.hint}`.slice(0, 100) : input.entity;
  const candidates = [...(await nasaVideoCandidates(query)), ...(await iaCandidates(input.entity))];
  if (candidates.length === 0) return null;

  const clipSec = Math.max(3, Math.min(15, input.durationSec + 0.4));
  for (const cand of candidates.slice(0, 3)) {
    try {
      const res = await fetch(cand.downloadUrl, { headers: { "user-agent": UA } });
      if (!res.ok || !res.body) continue;
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > DOWNLOAD_CAP_BYTES) continue; // skip enormous originals
      const buf = Buffer.from(await res.arrayBuffer());
      const clip = await normalizeClipBuffer(buf, {
        aspect: input.aspect,
        clipSec,
        introSkipSec: INTRO_SKIP_SEC, // archives open on title cards / leader
      });
      if (!clip) continue;
      const storageKey = `productions/${input.productionId}/clip-${input.idx}.mp4`;
      await store.put(storageKey, clip, "video/mp4");
      return {
        storageKey,
        mimeType: "video/mp4",
        sourceUrl: cand.pageUrl,
        license: cand.license,
        attribution: cand.attribution,
      };
    } catch {
      // this candidate failed (download/ffmpeg) — try the next
    }
  }
  return null;
}
