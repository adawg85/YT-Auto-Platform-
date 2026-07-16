/**
 * Mock image generation: deterministic 1080×1920 SVG placeholder (background
 * hue derived from the prompt hash, prompt text overlaid). No native deps;
 * Remotion renders SVG files fine.
 */
import type { CostSink } from "@ytauto/core";
import type { MediaProvider, ObjectStore } from "../types";
import { IMAGE_PRICE_MOCK } from "../pricing";
import { fnv1a } from "./hash";

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrapText(s: string, width: number): string[] {
  const words = s.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width) {
      if (line) lines.push(line.trim());
      line = w;
    } else {
      line = line + " " + w;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines.slice(0, 14);
}

function buildSvg(prompt: string, w: number, h: number): string {
  const hue = fnv1a(prompt) % 360;
  const hue2 = (hue + 40) % 360;
  const lines = wrapText(prompt, 34);
  const text = lines
    .map(
      (line, i) =>
        `<text x="50%" y="${Math.round(h * 0.35 + i * 54)}" text-anchor="middle" font-family="sans-serif" font-size="40" fill="rgba(255,255,255,0.92)">${escapeXml(line)}</text>`,
    )
    .join("\n  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue}, 62%, 38%)"/>
      <stop offset="100%" stop-color="hsl(${hue2}, 70%, 22%)"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <circle cx="${w / 2}" cy="${Math.round(h * 0.72)}" r="${Math.round(w * 0.22)}" fill="hsl(${hue2}, 80%, 55%)" opacity="0.55"/>
  <text x="50%" y="${Math.round(h * 0.12)}" text-anchor="middle" font-family="sans-serif" font-size="30" fill="rgba(255,255,255,0.5)">mock image</text>
  ${text}
</svg>`;
}

export function createMockMediaProvider(store: ObjectStore, costSink: CostSink): MediaProvider {
  return {
    name: "mock-media",
    async generateImage({ prompt, aspect, channelId, productionId, idx, storageKeyBase }) {
      const [w, h] = aspect === "9:16" ? [1080, 1920] : aspect === "16:9" ? [1920, 1080] : [1080, 1080];
      const svg = buildSvg(prompt, w, h);
      const storageKey = `${storageKeyBase ?? `productions/${productionId}/beat-${idx}`}.svg`;
      await store.put(storageKey, Buffer.from(svg, "utf8"), "image/svg+xml");
      await costSink.record({
        category: "media",
        provider: "mock-media",
        units: { images: 1 },
        costUsd: IMAGE_PRICE_MOCK,
        channelId,
        productionId,
        meta: { prompt: prompt.slice(0, 200), idx },
      });
      return { storageKey, mimeType: "image/svg+xml" };
    },
  };
}
