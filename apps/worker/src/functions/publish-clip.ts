import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { assets, ideas, productions, publications } from "@ytauto/db";
import { inngest } from "@ytauto/core";
import { getContext } from "../context";

/**
 * Publish one derived clip on its scheduled date (BACKLOG #6). #20: uploads
 * IMMEDIATELY with YouTube-native `status.publishAt` — YouTube releases the
 * clip public at the slot itself (no sleeping run; the publish-finalize cron
 * flips the DB row live when the slot passes). A clip whose slot has already
 * passed uploads + releases right away, as before. The description one-way
 * links to the master.
 */
export const publishClipFn = inngest.createFunction(
  { id: "publish-clip", concurrency: 5, retries: 3 },
  { event: "production/publish-clip.requested" },
  async ({ event, step }) => {
    const { productionId, scheduledFor } = event.data;

    return step.run("upload", async () => {
      const { db, providers } = await getContext();
      const [prod] = await db.select().from(productions).where(eq(productions.id, productionId));
      if (!prod || prod.status === "published") return { skipped: true as const };
      const [existing] = await db
        .select({ id: publications.id, providerVideoId: publications.providerVideoId })
        .from(publications)
        .where(eq(publications.productionId, productionId))
        .limit(1);
      if (existing?.providerVideoId) return { skipped: true as const }; // already uploaded
      const [idea] = await db.select().from(ideas).where(eq(ideas.id, prod.ideaId));
      const [render] = await db
        .select()
        .from(assets)
        .where(and(eq(assets.productionId, productionId), eq(assets.kind, "render")));
      if (!idea || !render) return { skipped: true as const };

      // funnel: link the clip to its long-form master (one-way)
      let funnel = "";
      if (prod.masterProductionId) {
        const [mpub] = await db
          .select({ url: publications.url })
          .from(publications)
          .where(eq(publications.productionId, prod.masterProductionId));
        if (mpub?.url) funnel = `\n\n▶ Watch the full video: ${mpub.url}`;
      }

      const publishAt =
        new Date(scheduledFor).getTime() > Date.now()
          ? new Date(scheduledFor).toISOString()
          : undefined;
      const res = await providers.publish.upload({
        channelId: prod.channelId,
        productionId,
        videoStorageKey: render.storageKey,
        title: idea.title.slice(0, 100),
        description: `${idea.angle}${funnel}\n\nThis video contains AI-generated content.`.slice(0, 4900),
        tags: [],
        privacy: "private",
        publishAt,
        selfDeclaredAiContent: true,
        madeForKids: false,
      });
      // clips auto-release: a past/immediate slot flips public right away
      if (!publishAt) {
        await providers.publish.release({ channelId: prod.channelId, providerVideoId: res.providerVideoId });
      }
      await db.insert(publications).values({
        id: ulid(),
        productionId,
        provider: providers.publish.name,
        providerVideoId: res.providerVideoId,
        url: res.url,
        privacyStatus: publishAt ? "scheduled" : "public",
        aiDisclosure: true,
        publishedAt: publishAt ? null : new Date(),
        scheduledFor: new Date(scheduledFor),
      });
      await db
        .update(productions)
        .set({ status: publishAt ? "scheduled" : "published", currentGateId: null })
        .where(eq(productions.id, productionId));
      return { url: res.url, scheduled: !!publishAt };
    });
  },
);
