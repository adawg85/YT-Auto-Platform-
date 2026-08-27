import { and, eq, inArray } from "drizzle-orm";
import { ulid } from "ulid";
import { assets, channels, ideas, productions, publications } from "@ytauto/db";
import {
  assemblePublishDescription,
  imageCreditLines,
  inngest,
  musicCreditLines,
  musicCreditText,
  selectedMusicCreditRow,
} from "@ytauto/core";
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
      // #53: the channel's COPPA designation (null → false) — declared on upload
      // and re-sent on the immediate release so a clip never uploads as not-for-kids
      // when the channel is Made for Kids.
      const [clipChannel] = await db.select({ madeForKids: channels.madeForKids }).from(channels).where(eq(channels.id, prod.channelId));
      const madeForKids = clipChannel?.madeForKids === true;

      // funnel: link the clip to its long-form master (one-way)
      let funnel = "";
      if (prod.masterProductionId) {
        const [mpub] = await db
          .select({ url: publications.url })
          .from(publications)
          .where(eq(publications.productionId, prod.masterProductionId));
        if (mpub?.url) funnel = `\n\n▶ Watch the full video: ${mpub.url}`;
      }

      // #131: a derived clip is a PUBLICATION like any other, and this path used
      // to hand-roll its description — so it shipped with NO image credits and
      // NO music credit at all. For a CC-BY bed track that is a licence breach;
      // for a Content-ID-registered library track it is the claim the operator
      // can never release, because the credit that entitles the release was
      // never in the description. Assemble it through the same shared builder
      // the pipeline and the post-publish editor use ("any path that writes a
      // description to YouTube goes through here", publish-credits.ts).
      const licensedAssets = await db
        .select({ meta: assets.meta })
        .from(assets)
        .where(and(eq(assets.productionId, productionId), inArray(assets.kind, ["image", "video_clip"])));
      const musicRow = await selectedMusicCreditRow(db, productionId);
      const musicCredit = musicCreditText(musicRow);
      const description = assemblePublishDescription({
        body: idea.angle,
        // the clip's body is pipeline-generated, but its funnel link is already
        // composed here — pass it through rather than re-deriving a CTA
        authored: true,
        funnelLines: funnel ? [funnel.trim()] : [],
        imageCredits: imageCreditLines(
          licensedAssets.map((a) => a.meta as { entity?: string; source?: string; license?: string; attribution?: string } | null),
        ),
        musicCredits: musicCreditLines(musicRow),
      });

      const publishAt =
        new Date(scheduledFor).getTime() > Date.now()
          ? new Date(scheduledFor).toISOString()
          : undefined;
      const res = await providers.publish.upload({
        channelId: prod.channelId,
        productionId,
        videoStorageKey: render.storageKey,
        title: idea.title.slice(0, 100),
        description,
        tags: [],
        privacy: "private",
        publishAt,
        selfDeclaredAiContent: true,
        madeForKids,
      });
      // clips auto-release: a past/immediate slot flips public right away
      if (!publishAt) {
        await providers.publish.release({ channelId: prod.channelId, providerVideoId: res.providerVideoId, madeForKids });
      }
      // #126: UPDATE the row this clip already has (created at schedule time with
      // no video id) instead of inserting a second one. Two publication rows for
      // one production make every reader disagree — the pipeline's own upsert
      // takes an arbitrary row, the cockpit and MCP read the NEWEST, and the
      // finalize sweep walks all of them — which is how a record can sit
      // 'scheduled' against a video that is already live.
      const values = {
        provider: providers.publish.name,
        providerVideoId: res.providerVideoId,
        url: res.url,
        privacyStatus: publishAt ? "scheduled" : "public",
        aiDisclosure: true,
        publishedAt: publishAt ? null : new Date(),
        scheduledFor: new Date(scheduledFor),
        // #131: what the description actually carries, so a claim-release credit
        // is verifiable from MCP without reading the live YouTube description
        musicCredit,
      };
      if (existing) {
        await db.update(publications).set(values).where(eq(publications.id, existing.id));
      } else {
        await db.insert(publications).values({ id: ulid(), productionId, ...values });
      }
      await db
        .update(productions)
        .set({ status: publishAt ? "scheduled" : "published", currentGateId: null })
        .where(eq(productions.id, productionId));
      return { url: res.url, scheduled: !!publishAt };
    });
  },
);
