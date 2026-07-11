import { asc, eq } from "drizzle-orm";
import { getDb, channelDna, channels, claims, episodes, series } from "@ytauto/db";
import { channelWarmupState, projectTentativeSlots } from "@ytauto/core";

const db = getDb();
const [s] = await db.select().from(series).limit(1);
const [channel] = await db.select().from(channels).where(eq(channels.id, s!.channelId));
const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, s!.channelId));
const format = channel!.contentFormat === "long" ? ("long" as const) : ("shorts" as const);
const now = new Date();
const state = await channelWarmupState(db, s!.channelId, now, format);
const eps = await db
  .select({ id: episodes.id, title: episodes.title, status: episodes.status })
  .from(episodes)
  .where(eq(episodes.seriesId, s!.id))
  .orderBy(asc(episodes.position));
const target = eps.filter((e) => !["cut", "published"].includes(e.status));
const slots = projectTentativeSlots({
  format,
  launchedAt: state?.launchedAt ?? channel!.createdAt ?? now,
  now,
  count: target.length,
  releasedThisWeek: state?.releasedThisWeek ?? 0,
  cadencePerWeek: dna?.cadencePerWeek,
});
for (let i = 0; i < target.length; i++) {
  await db.update(episodes).set({ tentativeFor: slots[i] ?? null }).where(eq(episodes.id, target[i]!.id));
  console.log(`${target[i]!.title.slice(0, 45)} -> ${slots[i]?.toISOString()}`);
}
// unstick Gloster Meteor: clear partial claims, reset to planned
const METEOR = "01KX88EXF4HM4ANBXK5C6D8WXH";
await db.delete(claims).where(eq(claims.episodeId, METEOR));
await db.update(episodes).set({ status: "planned" }).where(eq(episodes.id, METEOR));
console.log("gloster meteor reset to planned (claims cleared)");
