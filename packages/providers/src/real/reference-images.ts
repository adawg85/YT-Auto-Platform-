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

// Safe licences only: public-domain, CC0, plain CC-BY (attribution).
const ACCEPTABLE_LICENCE = /public domain|^pd(-|\b)|\bcc0\b|\bcc[- ]?by\b/i;
// Reject share-alike / non-commercial / no-derivatives.
const RESTRICTED_LICENCE = /by[-\s](sa|nc|nd)/i;

/** True for PD/CC0/plain-CC-BY; false for -SA/-NC/-ND and unknown licences. */
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
  return (
    cands.find(
      (c) => isReusableLicence(c.license) && /^image\/(jpe?g|png)$/i.test(c.mime) && c.width >= 500,
    ) ?? null
  );
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

        // 3) download the (scaled) bytes into our store — never hotlink.
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
      } catch {
        return null;
      }
    },
  };
}
