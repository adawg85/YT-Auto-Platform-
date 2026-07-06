import type { SourceConnector, SourceItem } from "../types";

const UA = "ytauto-editorial/1.0";

/**
 * robots.txt-aware check: fetch the origin's robots.txt and refuse paths a
 * `User-agent: *` group disallows. Deliberately conservative and simple —
 * we only fetch individual article pages, not crawl.
 */
async function allowedByRobots(url: URL): Promise<boolean> {
  let body: string;
  try {
    const res = await fetch(`${url.origin}/robots.txt`, { headers: { "user-agent": UA } });
    if (!res.ok) return true; // no robots.txt → allowed
    body = await res.text();
  } catch {
    return true;
  }
  let appliesToUs = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [key, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    switch (key!.trim().toLowerCase()) {
      case "user-agent":
        appliesToUs = value === "*";
        break;
      case "disallow":
        if (appliesToUs && value && url.pathname.startsWith(value)) return false;
        break;
    }
  }
  return true;
}

function extractText(html: string): { title: string; content: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return { title, content: body };
}

/**
 * Single-page web fetch + naive text extraction. ToS/robots-aware and
 * error-tracked per BACKLOG #5 (throws → the engine records it on the source
 * row). Not a crawler: one URL in, one SourceItem out.
 */
export function createWebSourceConnector(): SourceConnector {
  return {
    kind: "web",
    async fetchItems(config): Promise<SourceItem[]> {
      const raw = typeof config.url === "string" ? config.url : "";
      if (!raw) throw new Error("web connector: config.url is required");
      const url = new URL(raw);
      if (!(await allowedByRobots(url))) {
        throw new Error(`web connector: robots.txt disallows ${url.pathname} on ${url.origin}`);
      }
      const res = await fetch(url, { headers: { "user-agent": UA } });
      if (!res.ok) throw new Error(`web fetch ${res.status}: ${raw}`);
      const { title, content } = extractText(await res.text());
      if (!content) throw new Error(`web connector: no extractable text at ${raw}`);
      return [
        {
          externalId: raw,
          url: raw,
          title: title || url.hostname + url.pathname,
          // cap pathological pages; the memory chunker re-slices anyway
          content: content.slice(0, 60_000),
        },
      ];
    },
  };
}
