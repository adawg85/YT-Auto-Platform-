import { desc, eq } from "drizzle-orm";
import { channelBriefings, experiments, type Db } from "@ytauto/db";

export type ChannelBriefing = typeof channelBriefings.$inferSelect;
export type ChannelExperiment = typeof experiments.$inferSelect;

export type ChannelBriefings = {
  briefings: ChannelBriefing[];
  experiments: ChannelExperiment[];
  /** id → experiment, for rendering experiment suggestions inline */
  experimentById: Map<string, ChannelExperiment>;
  openCount: number;
};

/** The per-channel Briefings tab data: check-ins + the experiment ledger. */
export async function loadChannelBriefings(db: Db, channelId: string): Promise<ChannelBriefings> {
  const briefings = await db
    .select()
    .from(channelBriefings)
    .where(eq(channelBriefings.channelId, channelId))
    .orderBy(desc(channelBriefings.createdAt))
    .limit(20);
  const experimentRows = await db
    .select()
    .from(experiments)
    .where(eq(experiments.channelId, channelId))
    .orderBy(desc(experiments.createdAt))
    .limit(20);
  return {
    briefings,
    experiments: experimentRows,
    experimentById: new Map(experimentRows.map((e) => [e.id, e])),
    openCount: briefings.filter((b) => b.status === "open").length,
  };
}
