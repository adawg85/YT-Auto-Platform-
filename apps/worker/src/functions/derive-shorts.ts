import { and, desc, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { channelDna, channels, ideas, productions, scriptDrafts } from "@ytauto/db";
import { inngest } from "@ytauto/core";
import { deriveShorts } from "@ytauto/agents";
import { getContext } from "../context";

/**
 * Long→Shorts derivation (BACKLOG #6). When a long-form master publishes and its
 * channel has a linked Shorts channel, derive self-contained vertical Shorts
 * from the master's verified script and seed each as a production on the Shorts
 * channel (Land-2 pre-seeded script → the pipeline skips drafting). Provenance
 * via masterProductionId; the funnel link is added at publish time.
 */
export const deriveShortsFn = inngest.createFunction(
  { id: "derive-shorts", concurrency: 3, retries: 2 },
  { event: "editorial/derive-shorts.requested" },
  async ({ event, step }) => {
    const { masterProductionId } = event.data;

    const ctx = await step.run("load-master", async () => {
      const { db } = await getContext();
      const [master] = await db.select().from(productions).where(eq(productions.id, masterProductionId));
      if (!master) return null;
      const [idea] = await db.select().from(ideas).where(eq(ideas.id, master.ideaId));
      const [draft] = await db
        .select()
        .from(scriptDrafts)
        .where(eq(scriptDrafts.productionId, masterProductionId))
        .orderBy(desc(scriptDrafts.version))
        .limit(1);
      const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, master.channelId));
      // the linked Shorts channel that feeds from this master's channel
      const [shortsChannel] = await db
        .select()
        .from(channels)
        .where(and(eq(channels.derivedFromChannelId, master.channelId), eq(channels.status, "active")));
      if (!idea || !draft || !shortsChannel) return null;
      return {
        shortsChannelId: shortsChannel.id,
        title: idea.title,
        angle: idea.angle,
        fullText: draft.fullText,
        imageStyle: dna?.visualStyle?.imageStyle ?? null,
        ctaTemplate: dna?.ctaTemplate ?? null,
      };
    });
    if (!ctx) return { skipped: true, reason: "no master script or no linked Shorts channel" };

    const derived = await step.run("derive-short-scripts", async () => {
      const { db, providers, costSink } = await getContext();
      return deriveShorts(
        { db, llm: providers.llm, costSink, channelId: ctx.shortsChannelId },
        {
          title: ctx.title,
          angle: ctx.angle,
          fullText: ctx.fullText,
          imageStyle: ctx.imageStyle ?? undefined,
          ctaTemplate: ctx.ctaTemplate ?? undefined,
        },
        3,
      );
    });

    // one seeded production per derived Short on the linked Shorts channel
    const created = await step.run("seed-short-productions", async () => {
      const { db } = await getContext();
      const out: string[] = [];
      for (const short of derived.shorts) {
        const ideaId = ulid();
        await db.insert(ideas).values({
          id: ideaId,
          channelId: ctx.shortsChannelId,
          title: short.hookText.slice(0, 120),
          angle: `Derived Short of "${ctx.title}"`,
          sourceType: "editorial",
          status: "greenlit",
        });
        const productionId = ulid();
        await db.insert(productions).values({
          id: productionId,
          ideaId,
          channelId: ctx.shortsChannelId,
          status: "greenlit",
          substanceFingerprint: short.substanceFingerprint,
          masterProductionId,
        });
        await db.insert(scriptDrafts).values({
          id: ulid(),
          productionId,
          version: 1,
          hookText: short.hookText,
          beats: short.beats,
          fullText: short.fullText,
          wordCount: short.fullText.split(/\s+/).filter(Boolean).length,
        });
        out.push(productionId);
      }
      return out;
    });

    await Promise.all(
      created.map((productionId) =>
        step.sendEvent(`greenlight-${productionId}`, {
          name: "production/greenlit",
          data: { productionId },
        }),
      ),
    );
    return { derived: created.length, shortsChannelId: ctx.shortsChannelId };
  },
);
