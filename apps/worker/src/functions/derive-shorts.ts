import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { assets, channelDna, channels, ideas, productions } from "@ytauto/db";
import { inngest } from "@ytauto/core";
import { getContext } from "../context";
import { clipToVerticalShorts } from "../clip";

/** First clip goes out this many hours after derivation; the rest follow the
 * Shorts channel's cadence. */
const FIRST_DELAY_HOURS = 24;

/**
 * Long→Shorts LITERAL clipping (BACKLOG #6). When a long-form master publishes
 * and its channel feeds a linked Shorts channel, cut the master render into
 * vertical 9:16 "Part N" clips (no re-scripting), store each as a scheduled
 * production on the Shorts channel with masterProductionId provenance, and fire
 * a durable publish per clip so they post on a staggered schedule.
 */
export const deriveShortsFn = inngest.createFunction(
  { id: "derive-shorts", concurrency: 2, retries: 1 },
  { event: "editorial/derive-shorts.requested" },
  async ({ event, step }) => {
    const { masterProductionId } = event.data;

    const info = await step.run("load-master", async () => {
      const { db } = await getContext();
      const [master] = await db.select().from(productions).where(eq(productions.id, masterProductionId));
      if (!master) return null;
      const [idea] = await db.select().from(ideas).where(eq(ideas.id, master.ideaId));
      const [render] = await db
        .select()
        .from(assets)
        .where(and(eq(assets.productionId, masterProductionId), eq(assets.kind, "render")));
      const [shortsChannel] = await db
        .select()
        .from(channels)
        .where(and(eq(channels.derivedFromChannelId, master.channelId), eq(channels.status, "active")));
      if (!idea || !render || !shortsChannel) return null;
      const [shortsDna] = await db.select().from(channelDna).where(eq(channelDna.channelId, shortsChannel.id));
      return {
        masterTitle: idea.title,
        renderKey: render.storageKey,
        durationSec: render.durationSec ?? 0,
        shortsChannelId: shortsChannel.id,
        cadence: shortsDna?.cadencePerWeek ?? 12,
      };
    });
    if (!info) return { skipped: true, reason: "no master render or no linked Shorts channel" };

    // cut the master into vertical Part-N clips + store each as a scheduled
    // production on the Shorts channel
    const clips = await step.run("cut-clips", async () => {
      const { db, providers } = await getContext();
      const work = join(tmpdir(), `ytauto-clip-${masterProductionId}`);
      await mkdir(work, { recursive: true });
      try {
        const inPath = join(work, "master.mp4");
        // STREAM the master to disk. getBuffer held an entire long-form render
        // (hundreds of MB) in a Node Buffer, and with the clip re-encode on top
        // that was the ~1.9GB spike that ran the 2GB worker to ~95% of its
        // limit (2026-08-05 memory review). Nothing here needs the bytes in
        // RAM — ffmpeg reads the file.
        const master = await providers.store.getStream(info.renderKey);
        await pipeline(master.stream, createWriteStream(inPath));
        const files = await clipToVerticalShorts(inPath, info.durationSec || 600, work);
        const out: string[] = [];
        for (let i = 0; i < files.length; i++) {
          const productionId = ulid();
          const key = `productions/${productionId}/final.mp4`;
          // same on the way back up: stream the cut clip, don't readFile it.
          const { size } = await stat(files[i]!);
          await providers.store.put(key, createReadStream(files[i]!), "video/mp4", {
            contentLength: size,
          });
          const ideaId = ulid();
          await db.insert(ideas).values({
            id: ideaId,
            channelId: info.shortsChannelId,
            title: `Part ${i + 1}: ${info.masterTitle}`.slice(0, 120),
            angle: `Clip of "${info.masterTitle}"`,
            sourceType: "editorial",
            status: "greenlit",
          });
          await db.insert(productions).values({
            id: productionId,
            ideaId,
            channelId: info.shortsChannelId,
            status: "scheduled",
            masterProductionId,
          });
          await db.insert(assets).values({
            id: ulid(),
            productionId,
            kind: "render",
            idx: 0,
            storageKey: key,
            mimeType: "video/mp4",
            durationSec: Math.max(1, Math.min(60, info.durationSec - i * 60)),
          });
          out.push(productionId);
        }
        return out;
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    });

    // schedule each clip's publish, staggered by the Shorts channel's cadence
    const intervalMs = Math.min(72, Math.max(6, Math.round((7 * 24) / info.cadence))) * 3_600_000;
    const base = Date.now() + FIRST_DELAY_HOURS * 3_600_000;
    await Promise.all(
      clips.map((productionId, i) =>
        step.sendEvent(`schedule-clip-${productionId}`, {
          name: "production/publish-clip.requested",
          data: { productionId, scheduledFor: new Date(base + i * intervalMs).toISOString() },
        }),
      ),
    );
    return { clips: clips.length, shortsChannelId: info.shortsChannelId };
  },
);
