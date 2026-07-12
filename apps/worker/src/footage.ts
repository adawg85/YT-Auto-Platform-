import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import type { ObjectStore } from "@ytauto/providers";

const run = promisify(execFile);

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

  const [w, h] = input.aspect === "9:16" ? [1080, 1920] : input.aspect === "16:9" ? [1920, 1080] : [1080, 1080];
  const clipSec = Math.max(3, Math.min(15, input.durationSec + 0.4));
  const dir = await mkdtemp(join(tmpdir(), "ytauto-clip-"));
  try {
    for (const cand of candidates.slice(0, 3)) {
      try {
        const res = await fetch(cand.downloadUrl, { headers: { "user-agent": UA } });
        if (!res.ok || !res.body) continue;
        const len = Number(res.headers.get("content-length") ?? 0);
        if (len > DOWNLOAD_CAP_BYTES) continue; // skip enormous originals
        const buf = Buffer.from(await res.arrayBuffer());
        const inPath = join(dir, "src.mp4");
        const outPath = join(dir, "clip.mp4");
        await writeFile(inPath, buf);
        const filter =
          `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;
        await run(
          ffmpegPath as unknown as string,
          [
            "-y",
            "-ss", String(INTRO_SKIP_SEC),
            "-t", String(clipSec),
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
        if (clip.length < 10_000) continue; // trim produced nothing usable
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
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
