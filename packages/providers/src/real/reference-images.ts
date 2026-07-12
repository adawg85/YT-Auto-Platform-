import type { ObjectStore, ReferenceImageProvider } from "../types";

/**
 * Wikimedia-backed subject-accurate imagery (BACKLOG #7/#16). For a named entity
 * it tries the Wikipedia article's lead image, then falls back to a Commons
 * file search — picking the first candidate under a SAFE licence (PD/CC0/plain
 * CC-BY; never -SA/-NC/-ND). The chosen image is downloaded (a scaled thumbnail,
 * not the full-res original) into our own ObjectStore; source + licence +
 * attribution come back for crediting. Any failure → null so the pipeline falls
 * back to generated imagery.
 *
 * Wikimedia REQUIRES a descriptive User-Agent with contact info (else 403).
 */
const DEFAULT_UA =
  "YTAutoPlatform/1.0 (https://commongroundsocial.com.au; ops@commongroundsocial.com.au)";
const THUMB_WIDTH = 1600;
const SEARCH_LIMIT = 12;

// Usable licences: public-domain, CC0, CC-BY, and (2026-07-12, operator
// decision) CC-BY-SA — share-alike unlocked a large share of Commons
// aviation photography; every licensed image is credited with its licence
// name + source in the video description (the publish preflight builds the
// credits from asset meta). Still rejected: -NC (we monetize) and -ND.
const ACCEPTABLE_LICENCE = /public domain|^pd(-|\b)|\bcc0\b|\bcc[- ]?by\b/i;
const RESTRICTED_LICENCE = /by[-\s]?(nc|nd)/i;

/** True for PD/CC0/CC-BY/CC-BY-SA; false for -NC/-ND and unknown licences. */
export function isReusableLicence(license: string): boolean {
  return ACCEPTABLE_LICENCE.test(license) && !RESTRICTED_LICENCE.test(license);
}

export type WikimediaCandidate = {
  /** scaled thumbnail if available, else the full file */
  downloadUrl: string;
  /** the Commons/Wikipedia page to credit as the source */
  pageUrl: string;
  license: string;
  attribution: string;
  mime: string;
  width: number;
};

/**
 * Pick the first usable candidate: a safe licence, a real raster photo
 * (jpeg/png — skips SVG diagrams, logos, icons), and a sensible size.
 * Candidates are assumed to be in relevance order.
 */
export function pickReusableImage(cands: WikimediaCandidate[]): WikimediaCandidate | null {
  return pickReusableImages(cands, 1)[0] ?? null;
}

/** All usable candidates (same rules), up to `limit`, in relevance order. */
export function pickReusableImages(cands: WikimediaCandidate[], limit: number): WikimediaCandidate[] {
  const out: WikimediaCandidate[] = [];
  const seen = new Set<string>();
  for (const c of cands) {
    if (out.length >= limit) break;
    if (!isReusableLicence(c.license) || !/^image\/(jpe?g|png)$/i.test(c.mime) || c.width < 500) continue;
    if (seen.has(c.downloadUrl)) continue; // lead image often reappears in search
    seen.add(c.downloadUrl);
    out.push(c);
  }
  return out;
}

type ImageInfo = {
  url?: string;
  descriptionurl?: string;
  thumburl?: string;
  mime?: string;
  width?: number;
  extmetadata?: Record<string, { value?: string }>;
};

function toCandidate(info: ImageInfo | undefined): WikimediaCandidate | null {
  if (!info) return null;
  const em = info.extmetadata ?? {};
  const license = (em.LicenseShortName?.value ?? em.License?.value ?? "").trim();
  const attribution = (em.Artist?.value ?? em.Credit?.value ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const downloadUrl = info.thumburl ?? info.url;
  if (!downloadUrl) return null;
  return {
    downloadUrl,
    pageUrl: info.descriptionurl ?? downloadUrl,
    license,
    attribution,
    mime: info.mime ?? "image/jpeg",
    width: info.width ?? 0,
  };
}

const IIPROPS = "iiprop=extmetadata|url|mime|size";

async function fetchJson(url: string, ua: string): Promise<any | null> {
  const res = await fetch(url, { headers: { "user-agent": ua, accept: "application/json" } });
  if (!res.ok) return null;
  return res.json();
}

/** The named Commons file's info (licence + scaled thumb + mime + size). */
async function commonsFileInfo(fileName: string, ua: string): Promise<WikimediaCandidate | null> {
  const url =
    "https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&" +
    `${IIPROPS}&iiurlwidth=${THUMB_WIDTH}&titles=` +
    encodeURIComponent(`File:${fileName}`);
  const json = await fetchJson(url, ua);
  const pages = json?.query?.pages ?? {};
  const page = Object.values(pages)[0] as { imageinfo?: ImageInfo[] } | undefined;
  return toCandidate(page?.imageinfo?.[0]);
}

/** Commons file search for the entity, in relevance order. */
async function commonsSearch(entity: string, ua: string): Promise<WikimediaCandidate[]> {
  const url =
    "https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search" +
    `&gsrsearch=${encodeURIComponent(entity)}&gsrnamespace=6&gsrlimit=${SEARCH_LIMIT}` +
    `&prop=imageinfo&${IIPROPS}&iiurlwidth=${THUMB_WIDTH}`;
  const json = await fetchJson(url, ua);
  const pages = json?.query?.pages ?? {};
  return (Object.values(pages) as Array<{ index?: number; imageinfo?: ImageInfo[] }>)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((p) => toCandidate(p.imageinfo?.[0]))
    .filter((c): c is WikimediaCandidate => c !== null);
}

/** The Wikipedia article lead-image filename for the entity, if any. */
async function wikipediaLeadFile(entity: string, ua: string): Promise<string | null> {
  const json = await fetchJson(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(entity)}`,
    ua,
  );
  const imgUrl: string | undefined = json?.originalimage?.source ?? json?.thumbnail?.source;
  if (!imgUrl) return null;
  return decodeURIComponent(imgUrl.split("/").pop() ?? "").replace(/^\d+px-/, "") || null;
}

export function createWikimediaReferenceProvider(store: ObjectStore): ReferenceImageProvider {
  const ua = process.env.WIKIMEDIA_USER_AGENT?.trim() || DEFAULT_UA;

  /** Download the chosen candidate's (scaled) bytes into our store — never hotlink. */
  async function storeCandidate(chosen: WikimediaCandidate, productionId: string, idx: number) {
    const imgRes = await fetch(chosen.downloadUrl, { headers: { "user-agent": ua } });
    if (!imgRes.ok) return null;
    const mimeType = imgRes.headers.get("content-type") ?? chosen.mime;
    const ext = mimeType.includes("png") ? "png" : "jpg";
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const storageKey = `productions/${productionId}/ref-${idx}.${ext}`;
    await store.put(storageKey, buf, mimeType);
    return {
      storageKey,
      mimeType,
      sourceUrl: chosen.pageUrl,
      license: chosen.license,
      attribution: chosen.attribution,
    };
  }

  return {
    name: "wikimedia",
    async findEntityImage({ entity, productionId, idx }) {
      try {
        // 1) prefer the Wikipedia article's lead image (highest relevance) if
        //    it's safely licensed; else 2) search Commons for a safe candidate.
        let chosen: WikimediaCandidate | null = null;
        const leadFile = await wikipediaLeadFile(entity, ua);
        if (leadFile) {
          const lead = await commonsFileInfo(leadFile, ua);
          if (lead) chosen = pickReusableImage([lead]);
        }
        if (!chosen) chosen = pickReusableImage(await commonsSearch(entity, ua));
        if (!chosen) return null;
        return await storeCandidate(chosen, productionId, idx);
      } catch {
        return null;
      }
    },
    // Topic-keyword fallback (BACKLOG #24): a plain Commons relevance search
    // over the shot's own words — no Wikipedia article lookup (there is no
    // canonical entity), same licence rules and storage path as the entity
    // path. Any failure → null so the pipeline falls back to generation.
    async findTopicImage({ keywords, productionId, idx }) {
      try {
        const chosen = pickReusableImage(await commonsSearch(keywords, ua));
        if (!chosen) return null;
        return await storeCandidate(chosen, productionId, idx);
      } catch {
        return null;
      }
    },
    // Archival-strength dial (2026-07-12): up to `limit` distinct candidates,
    // each stored under its own key (ref-{idx}-c{n}) so the caller can
    // vision-score them one by one. With a shot `hint`, a context-specific
    // "<entity> <hint>" search ranks FIRST (after the lead) so different
    // shots of the same subject pull different photos — the duplicate-reals
    // fix; the plain entity search backfills.
    async findEntityImages({ entity, productionId, idx, limit, hint }) {
      try {
        const pool: WikimediaCandidate[] = [];
        const leadFile = await wikipediaLeadFile(entity, ua);
        if (leadFile) {
          const lead = await commonsFileInfo(leadFile, ua);
          if (lead) pool.push(lead);
        }
        const cleanHint = hint?.replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60);
        if (cleanHint) pool.push(...(await commonsSearch(`${entity} ${cleanHint}`, ua)));
        pool.push(...(await commonsSearch(entity, ua)));
        const chosen = pickReusableImages(pool, limit);
        const out = [];
        for (let n = 0; n < chosen.length; n++) {
          const stored = await storeCandidate(chosen[n]!, productionId, idx * 100 + n);
          if (stored) out.push(stored);
        }
        return out;
      } catch {
        return [];
      }
    },
    async findTopicImages({ keywords, productionId, idx, limit }) {
      try {
        const chosen = pickReusableImages(await commonsSearch(keywords, ua), limit);
        const out = [];
        for (let n = 0; n < chosen.length; n++) {
          const stored = await storeCandidate(chosen[n]!, productionId, idx * 100 + n);
          if (stored) out.push(stored);
        }
        return out;
      } catch {
        return [];
      }
    },
  };
}
