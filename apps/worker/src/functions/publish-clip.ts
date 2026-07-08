import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { assets, ideas, productions, publications } from "@ytauto/db";
import { inngest } from "@ytauto/core";
import { getContext } from "../context";

/**
 * Publish one derived clip on its scheduled date (BACKLOG #6). Durable
 * sleepUntil the scheduled time, then upload the stored clip to the Shorts
 * channel and release it public. The description one-way links to the master.
 */
export const publishClipFn = inngest.createFunction(
  { id: "publish-clip", concurrency: 5, retries: 3 },
  { event: "production/publish-clip.requested" },
  async ({ event, step }) => {
    const { productionId, scheduledFor } = event.data;
    if (new Date(scheduledFor).getTime() > Date.now()) {
      await step.sleepUntil("wait-for-schedule", new Date(scheduledFor));
    }

    return step.run("upload-and-release", async () => {
      const { db, providers } = await getContext();
      const [prod] = await db.select().from(productions).where(eq(productions.id, productionId));
      if (!prod || prod.status === "published") return { skipped: true as const };
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

      const res = await providers.publish.upload({
        channelId: prod.channelId,
        productionId,
        videoStorageKey: render.storageKey,
        title: idea.title.slice(0, 100),
        description: `${idea.angle}${funnel}\n\nThis video contains AI-generated content.`.slice(0, 4900),
        tags: [],
        privacy: "private",
        selfDeclaredAiContent: true,
        madeForKids: false,
      });
      await providers.publish.release({ channelId: prod.channelId, providerVideoId: res.providerVideoId });
      await db.insert(publications).values({
        id: ulid(),
        productionId,
        provider: providers.publish.name,
        providerVideoId: res.providerVideoId,
        url: res.url,
        privacyStatus: "public",
        aiDisclosure: true,
        publishedAt: new Date(),
      });
      await db.update(productions).set({ status: "published", currentGateId: null }).where(eq(productions.id, productionId));
      return { url: res.url };
    });
  },
);
