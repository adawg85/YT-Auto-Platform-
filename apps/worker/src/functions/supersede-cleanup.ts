import { and, eq, isNotNull } from "drizzle-orm";
import { ulid } from "ulid";
import { agentActions, productions, publications } from "@ytauto/db";
import { inngest } from "@ytauto/core";
import { getContext } from "../context";

/**
 * "Make a corrected copy" cleanup (2026-07-19 operator). A published video that
 * shipped with a mistake can't be fixed in place — YouTube won't replace a live
 * video's file — so the operator makes a corrected copy that publishes as a NEW
 * upload (correctPublishedProductionAction). This runs when that corrected copy
 * goes live and, ONLY when the operator opted in (supersedeDeleteOld), deletes
 * the superseded original's live YouTube video and marks it `superseded`.
 *
 * Opt-out is the default: when supersedeDeleteOld is false the old upload stays
 * live and untouched (the corrected copy still carries the supersedesProductionId
 * provenance link) — the operator removes the old video themselves if/when they
 * want. Fires on `production/published`, which both the pipeline (publish-now)
 * and publish-finalize (scheduled go-live) emit, so a scheduled correction is
 * covered too. Idempotent: deleteVideo treats an already-gone video as success.
 */
export const supersedeCleanup = inngest.createFunction(
  { id: "supersede-cleanup", retries: 3 },
  { event: "production/published" },
  async ({ event, step }) => {
    const productionId = event.data.productionId as string;

    const plan = await step.run("resolve-superseded", async () => {
      const { db } = await getContext();
      const [prod] = await db
        .select({
          supersedesProductionId: productions.supersedesProductionId,
          supersedeDeleteOld: productions.supersedeDeleteOld,
        })
        .from(productions)
        .where(eq(productions.id, productionId));
      // not a corrected copy, or the operator did NOT opt into auto-delete →
      // leave the original alone (provenance link is enough).
      if (!prod?.supersedesProductionId || !prod.supersedeDeleteOld) return null;

      const [oldPub] = await db
        .select({
          providerVideoId: publications.providerVideoId,
          channelId: productions.channelId,
        })
        .from(publications)
        .innerJoin(productions, eq(productions.id, publications.productionId))
        .where(
          and(
            eq(publications.productionId, prod.supersedesProductionId),
            isNotNull(publications.providerVideoId),
          ),
        )
        .limit(1);
      return {
        oldProductionId: prod.supersedesProductionId,
        providerVideoId: oldPub?.providerVideoId ?? null,
        channelId: oldPub?.channelId ?? null,
      };
    });

    if (!plan) return { superseded: false as const };

    await step.run("delete-and-mark", async () => {
      const { db, providers } = await getContext();
      if (plan.providerVideoId && plan.channelId) {
        await providers.publish.deleteVideo({
          channelId: plan.channelId,
          providerVideoId: plan.providerVideoId,
        });
      }
      // reflect that the original is no longer the live cut
      await db
        .update(productions)
        .set({ status: "superseded", currentGateId: null })
        .where(eq(productions.id, plan.oldProductionId));
      await db.insert(agentActions).values({
        id: ulid(),
        agentName: "supersede_delete_old",
        ...(plan.channelId ? { channelId: plan.channelId } : {}),
        productionId: plan.oldProductionId,
        inputSummary: plan.providerVideoId
          ? `corrected copy ${productionId} is live — deleted the superseded original video ${plan.providerVideoId} and marked production ${plan.oldProductionId} superseded`
          : `corrected copy ${productionId} is live — original ${plan.oldProductionId} had no live video to delete; marked superseded`,
        output: { correctedBy: productionId, deletedVideoId: plan.providerVideoId },
      });
      return { deletedVideoId: plan.providerVideoId };
    });

    return { superseded: true as const, oldProductionId: plan.oldProductionId };
  },
);
