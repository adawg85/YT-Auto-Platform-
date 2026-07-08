import type { ObjectStore, ReferenceImageProvider } from "../types";

/**
 * Wikimedia-backed subject-accurate imagery (BACKLOG #7/#16). Resolves a named
 * entity to a real photo via the Wikipedia REST summary, then reads the file's
 * licence from Commons and only uses PD / Creative-Commons images, downloading
 * the bytes into our own ObjectStore (never hotlinking). Any failure → null so
 * the pipeline falls back to generated imagery.
 *
 * Wikimedia REQUIRES a descriptive User-Agent with contact info (else 403).
 */
const DEFAULT_UA =
  "YTAutoPlatform/1.0 (https://commongroundsocial.com.au; ops@commongroundsocial.com.au)";

// Accept public-domain and CC-BY / CC-BY-SA / CC0; reject anything else.
const ACCEPTABLE_LICENCE = /public domain|^pd(-|\b)|\bcc0\b|\bcc[- ]?by\b/i;

type CommonsLicence = { license: string; attribution: string } | null;

async function fetchCommonsLicence(fileName: string, ua: string): Promise<CommonsLicence> {
  const url =
    "https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo" +
    "&iiprop=extmetadata&titles=" +
    encodeURIComponent(`File:${fileName}`);
  const res = await fetch(url, { headers: { "user-agent": ua, accept: "application/json" } });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    query?: { pages?: Record<string, { imageinfo?: Array<{ extmetadata?: Record<string, { value?: string }> }> }> };
  };
  const pages = json.query?.pages ?? {};
  const page = Object.values(pages)[0];
  const em = page?.imageinfo?.[0]?.extmetadata;
  if (!em) return null;
  const license = (em.LicenseShortName?.value ?? em.License?.value ?? "").trim();
  const attribution = (em.Artist?.value ?? em.Credit?.value ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return { license, attribution };
}

export function createWikimediaReferenceProvider(store: ObjectStore): ReferenceImageProvider {
  const ua = process.env.WIKIMEDIA_USER_AGENT?.trim() || DEFAULT_UA;
  return {
    name: "wikimedia",
    async findEntityImage({ entity, productionId, idx }) {
      try {
        // 1) Wikipedia REST summary → the article's lead image of the subject.
        const sumRes = await fetch(
          `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(entity)}`,
          { headers: { "user-agent": ua, accept: "application/json" } },
        );
        if (!sumRes.ok) return null;
        const sum = (await sumRes.json()) as {
          originalimage?: { source?: string };
          thumbnail?: { source?: string };
          content_urls?: { desktop?: { page?: string } };
        };
        const imgUrl = sum.originalimage?.source ?? sum.thumbnail?.source;
        if (!imgUrl) return null;

        // 2) licence from Commons (filename = last path segment, minus any
        //    "NNNpx-" thumbnail prefix).
        const fileName = decodeURIComponent(imgUrl.split("/").pop() ?? "").replace(/^\d+px-/, "");
        if (!fileName) return null;
        const lic = await fetchCommonsLicence(fileName, ua);
        if (!lic || !ACCEPTABLE_LICENCE.test(lic.license)) return null;

        // 3) download bytes into our store (never hotlink).
        const imgRes = await fetch(imgUrl, { headers: { "user-agent": ua } });
        if (!imgRes.ok) return null;
        const mimeType = imgRes.headers.get("content-type") ?? "image/jpeg";
        const ext = mimeType.includes("png") ? "png" : mimeType.includes("svg") ? "svg" : "jpg";
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const storageKey = `productions/${productionId}/ref-${idx}.${ext}`;
        await store.put(storageKey, buf, mimeType);

        return {
          storageKey,
          mimeType,
          sourceUrl: sum.content_urls?.desktop?.page ?? imgUrl,
          license: lic.license,
          attribution: lic.attribution,
        };
      } catch {
        return null;
      }
    },
  };
}
