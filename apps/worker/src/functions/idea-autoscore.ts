import { desc, eq, isNull } from "drizzle-orm";
import { ideas, scores } from "@ytauto/db";
import { inngest } from "@ytauto/core";
import { scoreIdea } from "@ytauto/agents";
import { getContext } from "../context";

/** Max ideas scored per run — generation batches are 3-10, this covers them. */
const MAX_PER_RUN = 12;

/**
 * Auto-scoring (operator ask 2026-07-11): scoring should never need a button.
 * Fired after idea generation/seeding (and an hourly sweep catches strays),
 * this scores every still-inbox unscored idea so the Ideas page and Plan tab
 * always show the rubric verdict, with the per-axis factors on hover.
 */
export const ideaAutoscore = inngest.createFunction(
  { id: "idea-autoscore", concurrency: 2, retries: 2 },
  [{ cron: "30 * * * *" }, { event: "ideas/autoscore.requested" }],
  async ({ event, step }) => {
    const channelId =
      event?.name === "ideas/autoscore.requested" ? event.data.channelId : undefined;

    const targets = await step.run("list-unscored", async () => {
      const { db } = await getContext();
      const rows = await db
        .select({ id: ideas.id, channelId: ideas.channelId })
        .from(ideas)
        .leftJoin(scores, eq(scores.ideaId, ideas.id))
        .where(isNull(scores.id))
        .orderBy(desc(ideas.createdAt))
        .limit(200);
      return rows
        .filter((r) => r.channelId && (!channelId || r.channelId === channelId))
        .slice(0, MAX_PER_RUN);
    });

    let scored = 0;
    for (const t of targets) {
      await step.run(`score-${t.id}`, async () => {
        const { db, providers, costSink } = await getContext();
        // only score ideas still in the inbox (greenlit/cut ones moved on)
        const [idea] = await db.select().from(ideas).where(eq(ideas.id, t.id));
        if (!idea || idea.status !== "inbox") return null;
        await scoreIdea({ db, llm: providers.llm, costSink, channelId: t.channelId }, t.id);
        return t.id;
      });
      scored++;
    }
    return { scored, considered: targets.length };
  },
);
