import { NextResponse } from "next/server";
import { getMergedEnv } from "@/lib/context";

export const runtime = "nodejs"; // reads the encrypted /account keys
export const dynamic = "force-dynamic";

/**
 * Stock-library key diagnostics (remediation follow-up): for each configured
 * stock source, run one live search and report whether it authenticates and
 * returns results. Operator-only (behind the cockpit basic auth). Open
 * /api/diag/stock in the browser after saving keys on /account. Never returns
 * the key itself — only ok/fail + a sample asset URL.
 */
type Probe = { configured: boolean; ok?: boolean; status?: number; results?: number; sample?: string | null; error?: string };

const Q = "aviation";
// Pixabay's video endpoint is routinely slow to first-byte; give every probe a
// generous window so a slow-but-healthy source doesn't read as a false FAIL.
const TIMEOUT = 20000;

async function run(fn: () => Promise<Probe>): Promise<Probe> {
  try {
    return await fn();
  } catch (e) {
    return { configured: true, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function GET() {
  const env = await getMergedEnv();
  const out: Record<string, Probe> = {};

  // ── Pexels (photos + video) ──
  const pexels = env.PEXELS_API_KEY;
  out.pexels_photos = pexels
    ? await run(async () => {
        const res = await fetch(`https://api.pexels.com/v1/search?query=${Q}&per_page=1`, {
          headers: { authorization: pexels },
          signal: AbortSignal.timeout(TIMEOUT),
        });
        if (!res.ok) return { configured: true, ok: false, status: res.status, error: (await res.text()).slice(0, 200) };
        const j = (await res.json()) as { photos?: { src?: { medium?: string } }[] };
        return { configured: true, ok: (j.photos?.length ?? 0) > 0, status: 200, results: j.photos?.length ?? 0, sample: j.photos?.[0]?.src?.medium ?? null };
      })
    : { configured: false };
  out.pexels_video = pexels
    ? await run(async () => {
        const res = await fetch(`https://api.pexels.com/videos/search?query=${Q}&per_page=1`, {
          headers: { authorization: pexels },
          signal: AbortSignal.timeout(TIMEOUT),
        });
        if (!res.ok) return { configured: true, ok: false, status: res.status, error: (await res.text()).slice(0, 200) };
        const j = (await res.json()) as { videos?: { url?: string }[] };
        return { configured: true, ok: (j.videos?.length ?? 0) > 0, status: 200, results: j.videos?.length ?? 0, sample: j.videos?.[0]?.url ?? null };
      })
    : { configured: false };

  // ── Pixabay (photos + video) — per_page min is 3 ──
  const pixabay = env.PIXABAY_API_KEY;
  out.pixabay_photos = pixabay
    ? await run(async () => {
        const res = await fetch(`https://pixabay.com/api/?key=${encodeURIComponent(pixabay)}&q=${Q}&image_type=photo&per_page=3`, {
          signal: AbortSignal.timeout(TIMEOUT),
        });
        if (!res.ok) return { configured: true, ok: false, status: res.status, error: (await res.text()).slice(0, 200) };
        const j = (await res.json()) as { hits?: { pageURL?: string }[] };
        return { configured: true, ok: (j.hits?.length ?? 0) > 0, status: 200, results: j.hits?.length ?? 0, sample: j.hits?.[0]?.pageURL ?? null };
      })
    : { configured: false };
  out.pixabay_video = pixabay
    ? await run(async () => {
        const res = await fetch(`https://pixabay.com/api/videos/?key=${encodeURIComponent(pixabay)}&q=${Q}&per_page=3`, {
          signal: AbortSignal.timeout(TIMEOUT),
        });
        if (!res.ok) return { configured: true, ok: false, status: res.status, error: (await res.text()).slice(0, 200) };
        const j = (await res.json()) as { hits?: { pageURL?: string }[] };
        return { configured: true, ok: (j.hits?.length ?? 0) > 0, status: 200, results: j.hits?.length ?? 0, sample: j.hits?.[0]?.pageURL ?? null };
      })
    : { configured: false };

  // ── Unsplash (photos) — Client-ID auth ──
  const unsplash = env.UNSPLASH_ACCESS_KEY;
  out.unsplash_photos = unsplash
    ? await run(async () => {
        const res = await fetch(`https://api.unsplash.com/search/photos?query=${Q}&per_page=1`, {
          headers: { authorization: `Client-ID ${unsplash}`, "accept-version": "v1" },
          signal: AbortSignal.timeout(TIMEOUT),
        });
        if (!res.ok) return { configured: true, ok: false, status: res.status, error: (await res.text()).slice(0, 200) };
        const j = (await res.json()) as { results?: { links?: { html?: string } }[] };
        return { configured: true, ok: (j.results?.length ?? 0) > 0, status: 200, results: j.results?.length ?? 0, sample: j.results?.[0]?.links?.html ?? null };
      })
    : { configured: false };

  // ── Coverr (video) — Bearer auth ──
  const coverr = env.COVERR_API_KEY;
  out.coverr_video = coverr
    ? await run(async () => {
        const res = await fetch(`https://api.coverr.co/videos?query=${Q}&page_size=1&urls=true`, {
          headers: { authorization: `Bearer ${coverr}` },
          signal: AbortSignal.timeout(TIMEOUT),
        });
        if (!res.ok) return { configured: true, ok: false, status: res.status, error: (await res.text()).slice(0, 200) };
        const j = (await res.json()) as { hits?: { id?: string }[] };
        return { configured: true, ok: (j.hits?.length ?? 0) > 0, status: 200, results: j.hits?.length ?? 0, sample: j.hits?.[0]?.id ? `https://coverr.co/videos/${j.hits[0].id}` : null };
      })
    : { configured: false };

  const summary = Object.fromEntries(
    Object.entries(out).map(([k, v]) => [k, v.configured ? (v.ok ? "OK" : `FAIL${v.status ? ` (${v.status})` : ""}`) : "not configured"]),
  );

  return NextResponse.json({ summary, detail: out }, { headers: { "cache-control": "no-store" } });
}
