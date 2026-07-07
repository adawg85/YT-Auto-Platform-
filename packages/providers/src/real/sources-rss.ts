import { XMLParser } from "fast-xml-parser";
import type { SourceConnector, SourceItem } from "../types";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function text(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "#text" in (v as Record<string, unknown>)) {
    return String((v as Record<string, unknown>)["#text"]);
  }
  return v == null ? "" : String(v);
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** RSS 2.0 + Atom feeds. Throws on fetch/parse failure — the engine tracks it. */
export function createRssSourceConnector(): SourceConnector {
  return {
    kind: "rss",
    async fetchItems(config, opts): Promise<SourceItem[]> {
      const url = typeof config.url === "string" ? config.url : "";
      if (!url) throw new Error("rss connector: config.url is required");
      const res = await fetch(url, { headers: { "user-agent": "ytauto-editorial/1.0" } });
      if (!res.ok) throw new Error(`rss fetch ${res.status}: ${url}`);
      const xml = await res.text();
      const doc = parser.parse(xml) as Record<string, any>;

      const limit = opts?.limit ?? 10;
      const since = opts?.since ? Date.parse(opts.since) : null;
      const items: SourceItem[] = [];

      // RSS 2.0: rss.channel.item[]
      for (const it of asArray<any>(doc.rss?.channel?.item)) {
        const link = text(it.link);
        items.push({
          externalId: text(it.guid) || link,
          url: link,
          title: stripHtml(text(it.title)),
          content: stripHtml(text(it["content:encoded"]) || text(it.description)),
          publishedAt: it.pubDate ? new Date(text(it.pubDate)).toISOString() : undefined,
          author: text(it.author) || undefined,
        });
      }
      // Atom: feed.entry[]
      for (const it of asArray<any>(doc.feed?.entry)) {
        const links = asArray<any>(it.link);
        const href = text(links.find((l: any) => l?.["@_rel"] !== "self")?.["@_href"] ?? links[0]?.["@_href"]);
        items.push({
          externalId: text(it.id) || href,
          url: href,
          title: stripHtml(text(it.title)),
          content: stripHtml(text(it.content) || text(it.summary)),
          publishedAt: it.updated ? new Date(text(it.updated)).toISOString() : undefined,
          author: text(it.author?.name) || undefined,
        });
      }

      return items
        .filter((i) => i.title || i.content)
        .filter((i) => !since || !i.publishedAt || Date.parse(i.publishedAt) >= since)
        .slice(0, limit);
    },
  };
}
