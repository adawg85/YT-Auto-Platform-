/**
 * #110: pure licence logic for the platform audio library. Everything that
 * decides whether a track can sit under a monetised video, and what credit it
 * requires, lives here — unit-tested, so the compliance behaviour can't drift
 * from what the tools enforce. The same licence posture as the rest of the
 * platform (music-openverse LICENCES, reference-images isReusableLicence):
 * CC0 / public domain / CC BY / CC BY-SA are monetisation-safe; -NC and -ND
 * are not (a monetised YouTube channel is commercial use).
 */

export type AudioLicenceTraits = {
  /** false when the label couldn't be recognised at all */
  known: boolean;
  /** can this sit under a monetised video? (the gating field) */
  commercialUse: boolean;
  /** does using it require a credit? (CC BY / BY-SA yes; CC0/PD no) */
  attributionRequired: boolean;
  shareAlike: boolean;
};

/**
 * Normalise the many ways a licence arrives ("cc-by", "CC BY 4.0", a deed URL,
 * "Attribution-ShareAlike 3.0") into the platform's label convention:
 * "CC0" / "Public domain" / "CC BY 4.0" / "CC BY-NC-SA 3.0" / "Proprietary".
 * Returns null when nothing recognisable was supplied — an honest null beats a
 * guessed licence.
 */
export function normaliseAudioLicence(input: string | null | undefined, version?: string | null): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  const s = raw.toLowerCase();
  const ver =
    version?.trim() ||
    s.match(/\b([1-4]\.\d)\b/)?.[1] ||
    // deed URLs carry the version as a path segment: /licenses/by-sa/4.0/
    s.match(/\/([1-4]\.\d)\//)?.[1] ||
    "";
  if (/\bcc0\b|publicdomain\/zero|creative\s*commons\s*zero/.test(s)) return "CC0";
  if (/public\s*domain|\bpdm\b|publicdomain\/mark/.test(s)) return "Public domain";
  if (/propriet|all\s*rights|purchased|paid\s*licen/.test(s)) return "Proprietary";
  // CC family — accept "cc by-nc-sa", "by-nc", "attribution-noncommercial", deed URLs
  let mods = "";
  const byMatch = s.match(/\b(?:cc[-\s]?)?by((?:[-\s](?:nc|nd|sa))*)\b/);
  if (byMatch) {
    mods = byMatch[1] ?? "";
  } else if (/attribution/.test(s)) {
    mods =
      (/(non[-\s]?commercial|noncommercial)/.test(s) ? "-nc" : "") +
      (/no[-\s]?deriv/.test(s) ? "-nd" : "") +
      (/share[-\s]?alike/.test(s) ? "-sa" : "");
  } else {
    return null;
  }
  const parts = ["BY", ...mods.split(/[-\s]/).filter((m) => ["nc", "nd", "sa"].includes(m)).map((m) => m.toUpperCase())];
  // canonical CC ordering: BY, NC, ND/SA
  const ordered = ["BY", "NC", "ND", "SA"].filter((p) => parts.includes(p));
  return `CC ${ordered.join("-")}${ver ? ` ${ver}` : ""}`;
}

/** What the (normalised or raw) licence label permits and requires. */
export function audioLicenceTraits(licence: string | null | undefined): AudioLicenceTraits {
  const label = normaliseAudioLicence(licence) ?? "";
  if (!label) return { known: false, commercialUse: false, attributionRequired: false, shareAlike: false };
  if (label === "CC0" || label === "Public domain") {
    return { known: true, commercialUse: true, attributionRequired: false, shareAlike: false };
  }
  if (label === "Proprietary") {
    // a paid/owned grant — commercial use depends on the actual contract, so it
    // is NOT assumed; the operator sets commercialUse explicitly
    return { known: true, commercialUse: false, attributionRequired: false, shareAlike: false };
  }
  const nc = label.includes("-NC");
  const nd = label.includes("-ND");
  const sa = label.includes("-SA");
  return { known: true, commercialUse: !nc && !nd, attributionRequired: true, shareAlike: sa };
}

/** The deed URL for a normalised CC label, when derivable. */
export function audioLicenceDeedUrl(licence: string | null | undefined): string | null {
  const label = normaliseAudioLicence(licence);
  if (!label) return null;
  if (label === "CC0") return "https://creativecommons.org/publicdomain/zero/1.0/";
  if (label === "Public domain") return "https://creativecommons.org/publicdomain/mark/1.0/";
  if (label === "Proprietary") return null;
  const m = label.match(/^CC ([A-Z-]+)(?: ([1-4]\.\d))?$/);
  if (!m) return null;
  return `https://creativecommons.org/licenses/${m[1]!.toLowerCase()}/${m[2] ?? "4.0"}/`;
}

export type AudioAssetAttributionInput = {
  title: string;
  creator?: string | null;
  creatorUrl?: string | null;
  sourceUrl?: string | null;
  licence?: string | null;
  licenceUrl?: string | null;
  modified?: boolean;
};

/**
 * The ready-made T.A.S.L. credit line: `"Title" by Creator (creatorUrl),
 * licensed under CC BY 4.0 (deedUrl). Modified.` Returns null when the licence
 * carries no attribution obligation (CC0/PD/proprietary) — callers can still
 * credit voluntarily, but nothing REQUIRES it.
 */
export function audioAttributionLine(asset: AudioAssetAttributionInput): string | null {
  const traits = audioLicenceTraits(asset.licence);
  if (!traits.attributionRequired) return null;
  const label = normaliseAudioLicence(asset.licence)!;
  const who = asset.creator?.trim()
    ? `${asset.creator.trim()}${asset.creatorUrl?.trim() ? ` (${asset.creatorUrl.trim()})` : ""}`
    : "Unknown";
  const deed = asset.licenceUrl?.trim() || audioLicenceDeedUrl(asset.licence);
  const src = asset.sourceUrl?.trim() ? `, via ${asset.sourceUrl.trim()}` : "";
  return `"${asset.title.trim()}" by ${who}${src}, licensed under ${label}${deed ? ` (${deed})` : ""}.${asset.modified ? " Modified." : ""}`;
}

/**
 * Parse licence facts out of a licence/source PAGE's HTML — title, creator and
 * a Creative Commons deed link. PURE (the fetch lives in the caller) and
 * deliberately conservative: a field it can't find comes back null, never
 * guessed — a wrong licence record is worse than an empty one.
 */
export function parseLicencePageHtml(html: string): {
  title: string | null;
  creator: string | null;
  licence: string | null;
  licenceVersion: string | null;
  licenceUrl: string | null;
} {
  const pick = (re: RegExp): string | null => {
    const m = html.match(re);
    return m?.[1]?.trim() || null;
  };
  const decode = (s: string | null): string | null =>
    s
      ?.replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;|&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim() || null;
  const ogTitle = pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
    ?? pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  const docTitle = pick(/<title[^>]*>([^<]+)<\/title>/i);
  let title = decode(ogTitle ?? docTitle);
  let creator: string | null = decode(
    pick(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i) ??
      pick(/<meta[^>]+property=["']music:musician["'][^>]+content=["']([^"']+)["']/i),
  );
  // freesound/FMA-style "Track name by artist" og:titles
  const byMatch = title?.match(/^(.+?)\s+by\s+([^|–-]+?)\s*$/i);
  if (byMatch && !creator) {
    title = byMatch[1]!.trim();
    creator = byMatch[2]!.trim();
  }
  // a CC deed link anywhere on the page is the strongest licence signal
  const deed = pick(
    /(https?:\/\/creativecommons\.org\/(?:licenses\/[a-z-]+\/[1-4]\.\d|publicdomain\/(?:zero|mark)\/1\.0)\/?)/i,
  );
  const licence = deed ? normaliseAudioLicence(deed) : null;
  const licenceVersion = deed?.match(/\/([1-4]\.\d)\//)?.[1] ?? null;
  return { title, creator, licence, licenceVersion, licenceUrl: deed ?? null };
}
