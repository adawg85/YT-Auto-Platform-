import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { channels, ideas, productions } from "@ytauto/db";
import { inngest } from "@ytauto/core";
import { scanTrendsForChannel } from "@ytauto/agents";
import { getContext } from "../context";

/**
 * Trend-replication fast lane (spec §5.5): daily scan (or on demand) for
 * rising formats that fit each channel's DNA. Suggestions land as
 * fast-track ideas; on T2+ channels the top suggestion is auto-greenlit
 * (the topical window is short — speed is the point).
 */
export const trendScan = inngest.createFunction(
  { id: "trend-scan", concurrency: 1, retries: 2 },
  [{ cron: "0 7 * * *" }, { event: "trend/scan.requested" }],
  async ({ event, step }) => {
    const onlyChannelId =
      event?.name === "trend/scan.requested" ? event.data.channelId : undefined;

    const activeChannels = await step.run("list-channels", async () => {
      const { db } = await getContext();
      const rows = await db.select().from(channels).where(eq(channels.status, "active"));
      return rows.filter((c) => !onlyChannelId || c.id === onlyChannelId);
    });

    let created = 0;
    let greenlit = 0;
    for (const channel of activeChannels) {
      const result = await step.run(`scan-${channel.id}`, async () => {
        const { db, providers, costSink } = await getContext();
        const ideasCreated = await scanTrendsForChannel(
          { db, llm: providers.llm, costSink, channelId: channel.id },
          providers.research,
        );

        // fast lane: auto-greenlight the top suggestion on supervised+ channels
        let autoGreenlit: string | null = null;
        if (channel.autonomyTier >= 2 && ideasCreated.length > 0) {
          const top = ideasCreated[0]!;
          const productionId = ulid();
          await db.insert(productions).values({
            id: productionId,
            ideaId: top.id,
            channelId: channel.id,
            status: "greenlit",
          });
          await db.update(ideas).set({ status: "greenlit" }).where(eq(ideas.id, top.id));
          autoGreenlit = productionId;
        }
        return { count: ideasCreated.length, autoGreenlit };
      });
      created += result.count;
      if (result.autoGreenlit) {
        greenlit++;
        await step.sendEvent(`greenlit-${channel.id}`, {
          name: "production/greenlit",
          data: { productionId: result.autoGreenlit, attempt: "0" },
        });
      }
    }
    return { channels: activeChannels.length, ideasCreated: created, autoGreenlit: greenlit };
  },
);
