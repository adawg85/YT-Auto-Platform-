import { and, eq, isNotNull } from "drizzle-orm";
import { ulid } from "ulid";
import { agentActions, productions, publications } from "@ytauto/db";
import { inngest, markPublicationLive, markScheduleCancelled } from "@ytauto/core";
import { getContext } from "../context";

/** grace before calling a past-due slot "stuck" — YouTube's flip isn't instant */
const STUCK_GRACE_MS = 15 * 60_000;

/**
 * Scheduled-release bookkeeping + reconciliation (BACKLOG #20). Videos upload
 * immediately with `status.publishAt` and YouTube flips them public at the
 * slot itself — no pipeline run is alive at that moment, so this cron sweeps
 * every publication in the `scheduled` state and reconciles it against the
 * provider (the platform calendar is the source of truth for *changes*, but
 * provider-side reality must flow back rather than silently diverge):
 *
 *  - provider says PUBLIC       → mark live (publication public + publishedAt,
 *    production published) and fire the post-publish events at the moment the
 *    video is actually out.
 *  - provider publishAt moved   → sync scheduledFor (a Studio-side edit).
 *  - provider schedule cleared  → back to private-until-release; slot comes
 *    off the calendar (a Studio-side cancel).
 *  - video missing/deleted      → same cancel bookkeeping (row stays for the
 *    audit trail; never re-upload — deletion is a spam signal, BACKLOG #10).
 *  - provider can't answer (mock mode, or a read error) → fall back to
 *    time-based bookkeeping: flip live once the slot has passed.
 *
 * Legacy rows from the sleep-based pipeline are untouched: they were uploaded
 * as privacyStatus "private", never "scheduled".
 */
export const publishFinalize = inngest.createFunction(
  { id: "publish-finalize", retries: 3 },
  { cron: "*/10 * * * *" },
  async ({ step }) => {
    const rows = await step.run("find-scheduled", async () => {
      const { db } = await getContext();
      const found = await db
        .select({
          publicationId: publications.id,
          productionId: publications.productionId,
          providerVideoId: publications.providerVideoId,
          scheduledFor: publications.scheduledFor,
          channelId: productions.channelId,
        })
        .from(publications)
        .innerJoin(productions, eq(productions.id, publications.productionId))
        .where(
          and(eq(publications.privacyStatus, "scheduled"), isNotNull(publications.providerVideoId)),
        );
      return found.map((r) => ({
        ...r,
        scheduledFor: r.scheduledFor ? new Date(r.scheduledFor).toISOString() : null,
      }));
    });

    let released = 0;
    let resynced = 0;
    let cancelled = 0;
    let stuck = 0;
    for (const row of rows) {
      const outcome = await step.run(`reconcile-${row.publicationId}`, async () => {
        const { db, providers } = await getContext();
        const remote = await providers.publish.videoStatus({
          channelId: row.channelId,
          providerVideoId: row.providerVideoId!,
        });
        const duePassed =
          !!row.scheduledFor && new Date(row.scheduledFor).getTime() <= Date.now();

        if (remote.state === "found") {
          if (remote.privacyStatus === "public") {
            await markPublicationLive(db, {
              publicationId: row.publicationId,
              productionId: row.productionId,
              publishedAt: row.scheduledFor ? new Date(row.scheduledFor) : new Date(),
            });
            return "released" as const;
          }
          if (!remote.publishAt) {
            // schedule cleared in Studio — video is plain private now
            await markScheduleCancelled(db, {
              publicationId: row.publicationId,
              productionId: row.productionId,
            });
            return "cancelled" as const;
          }
          // epoch comparison — YouTube's ISO string drops milliseconds, so a
          // string compare would flag a benign format difference as drift
          const remoteMs = new Date(remote.publishAt).getTime();
          const localMs = row.scheduledFor ? new Date(row.scheduledFor).getTime() : NaN;
          if (remoteMs !== localMs) {
            // Studio-side reschedule — the calendar follows reality
            await db
              .update(publications)
              .set({ scheduledFor: new Date(remote.publishAt) })
              .where(eq(publications.id, row.publicationId));
            return "resynced" as const;
          }
          // Stuck-release alarm (2026-07-12 incident: a medialess shell sat
          // "scheduled" forever and every sweep reported a quiet "pending").
          // Past the slot + grace, a video that is still private is NOT
          // pending — it is stuck: either the provider never got the media
          // (durationSec null) or the native flip didn't happen. Shout once
          // into agent_actions (deduped) and on every sweep in the logs.
          const stuckMs =
            row.scheduledFor ? Date.now() - new Date(row.scheduledFor).getTime() : 0;
          if (stuckMs > STUCK_GRACE_MS) {
            const why =
              remote.durationSec == null
                ? `provider has NO MEDIA for it (uploadStatus=${remote.uploadStatus ?? "?"}) — the release can never fire; delete the dead record and re-run publish`
                : `provider has media but did not flip it public at the slot`;
            console.error(
              `[publish-finalize] STUCK: publication ${row.publicationId} (video ${row.providerVideoId}) is ${Math.round(stuckMs / 60_000)} min past its slot and still private — ${why}`,
            );
            const [already] = await db
              .select({ id: agentActions.id })
              .from(agentActions)
              .where(
                and(
                  eq(agentActions.agentName, "publish_stuck_alert"),
                  eq(agentActions.productionId, row.productionId),
                ),
              )
              .limit(1);
            if (!already) {
              await db.insert(agentActions).values({
                id: ulid(),
                agentName: "publish_stuck_alert",
                channelId: row.channelId,
                productionId: row.productionId,
                inputSummary: `scheduled release is stuck: video ${row.providerVideoId} still private past its slot — ${why}`,
                output: {
                  publicationId: row.publicationId,
                  providerVideoId: row.providerVideoId,
                  scheduledFor: row.scheduledFor,
                  durationSec: remote.durationSec,
                  uploadStatus: remote.uploadStatus,
                  processingStatus: remote.processingStatus,
                },
              });
            }
            return "stuck" as const;
          }
          // still pending at the agreed slot (or the flip is seconds away —
          // the next sweep catches it)
          return "pending" as const;
        }

        if (remote.state === "missing") {
          await markScheduleCancelled(db, {
            publicationId: row.publicationId,
            productionId: row.productionId,
          });
          return "cancelled" as const;
        }

        // state unknown (mock mode / read error): time-based fallback
        if (duePassed) {
          await markPublicationLive(db, {
            publicationId: row.publicationId,
            productionId: row.productionId,
            publishedAt: row.scheduledFor ? new Date(row.scheduledFor) : new Date(),
          });
          return "released" as const;
        }
        return "pending" as const;
      });
      if (outcome === "released") released++;
      else if (outcome === "resynced") resynced++;
      else if (outcome === "cancelled") cancelled++;
      else if (outcome === "stuck") stuck++;
    }

    return { scheduled: rows.length, released, resynced, cancelled, stuck };
  },
);
