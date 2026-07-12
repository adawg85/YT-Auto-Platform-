/** Verify the keyless YouTube research backend returns REAL data (BACKLOG #30). */
import { createYouTubeResearchProvider } from "@ytauto/providers";

const niche = process.argv[2] ?? "aviation history";
const r = createYouTubeResearchProvider();

const trending = await r.trendingVideos(niche);
const breakout = await r.breakoutChannels(niche);
const keywords = await r.keywords(niche);

console.log(`\n=== TRENDING (${trending.length}) — niche: "${niche}" ===`);
for (const v of trending.slice(0, 6)) {
  console.log(`• ${String(v.title).slice(0, 62)}`);
  console.log(`  ${v.views.toLocaleString()} views · ${Math.round(v.viewsPerHour)}/h · ${v.channelName} · ${v.format} · id=${v.externalId}`);
}
console.log(`\n=== BREAKOUT CHANNELS (${breakout.length}) ===`);
for (const c of breakout.slice(0, 5)) {
  console.log(`• ${c.channelName} — ${c.subscribers.toLocaleString()} subs · top: "${String(c.topVideo.title).slice(0, 44)}" (${c.topVideo.views.toLocaleString()} views)`);
}
console.log(`\n=== KEYWORDS (${keywords.length}) ===`);
console.log(keywords.slice(0, 12).map((k) => k.keyword).join(" · "));
process.exit(0);
