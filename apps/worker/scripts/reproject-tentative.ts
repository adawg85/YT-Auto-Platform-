/**
 * Re-project every tentative slot for one channel under the current cadence /
 * release plan (same logic as the cockpit's "Respread tentative slots" button
 * — use that from the UI; this script is the headless/ops path).
 *
 *   DATABASE_URL=… pnpm tsx apps/worker/scripts/reproject-tentative.ts <channelId> [--dry]
 *
 * Episodes whose idea already holds a real publication keep their locked
 * schedule and are skipped (the 2026-07-11 backfill shifted a whole series by
 * giving slot #1 to an already-scheduled episode — never again).
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb, channelDna, channels, episodes, productions, publications, series } from "@ytauto/db";
import { channelWarmupState, projectTentativeSlots } from "@ytauto/core";

const channelId = process.argv[2];
const dry = process.argv.includes("--dry");
if (!channelId) {
  console.error("usage: reproject-tentative.ts <channelId> [--dry]");
  process.exit(1);
}

const db = getDb();
const [channel] = await db.select().from(channels).where(eq(channels.id, channelId));
if (!channel) throw new Error(`channel ${channelId} not found`);
const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, channelId));
const activeSeries = await db
  .select({ id: series.id, title: series.title })
  .from(series)
  .where(and(eq(series.channelId, channelId), eq(series.status, "active")))
  .orderBy(asc(series.createdAt));
if (activeSeries.length === 0) throw new Error("no active series");

const format = channel.contentFormat === "long" ? ("long" as const) : ("shorts" as const);
const now = new Date();
const state = await channelWarmupState(db, channelId, now, format);

const eps: { id: string; title: string; status: string; ideaId: string | null }[] = [];
for (const s of activeSeries) {
  eps.push(
    ...(await db
      .select({ id: episodes.id, title: episodes.title, status: episodes.status, ideaId: episodes.ideaId })
      .from(episodes)
      .where(eq(episodes.seriesId, s.id))
      .orderBy(asc(episodes.position))),
  );
}
const ideaIds = eps.map((e) => e.ideaId).filter((x): x is string => !!x);
const lockedRows = ideaIds.length
  ? await db
      .select({ ideaId: productions.ideaId })
      .from(publications)
      .innerJoin(productions, eq(publications.productionId, productions.id))
      .where(inArray(productions.ideaId, ideaIds))
  : [];
const locked = new Set(lockedRows.map((r) => r.ideaId));
const target = eps.filter(
  (e) => !["cut", "published"].includes(e.status) && !(e.ideaId && locked.has(e.ideaId)),
);

const slots = projectTentativeSlots({
  format,
  launchedAt: state?.launchedAt ?? channel.createdAt ?? now,
  now,
  count: target.length,
  releasedThisWeek: state?.releasedThisWeek ?? 0,
  cadencePerWeek: dna?.cadencePerWeek,
  releasePlan: dna?.releasePlan ?? null,
});

for (let i = 0; i < target.length; i++) {
  const when = slots[i] ?? null;
  console.log(`${target[i]!.title.slice(0, 55).padEnd(55)} -> ${when?.toISOString() ?? "(none)"}`);
  if (!dry) {
    await db.update(episodes).set({ tentativeFor: when }).where(eq(episodes.id, target[i]!.id));
  }
}
console.log(`${dry ? "[dry-run] " : ""}${target.length} slots ${dry ? "computed" : "updated"}, ${eps.length - target.length} locked/terminal skipped`);
process.exit(0);
