import { and, desc, eq } from "drizzle-orm";
import { ulid } from "ulid";
import {
  channelDecisions,
  channelDna,
  channels,
  visualStyleRefs,
  visualStyles,
  type VisualStyleDoc,
} from "@ytauto/db";
import { inngest } from "@ytauto/core";
import { distillVisualStyle, MAX_STYLE_REF_IMAGES } from "@ytauto/agents";
import { getContext } from "../context";
import { downscaleImage } from "../footage";

/** Never feed the vision model anything absurd even if ffmpeg passed it through. */
const HARD_SKIP_BYTES = 20 * 1024 * 1024;

/**
 * #35.1 async distill (2026-07-14, 502 fix): the vision distillation used to
 * run inside a cockpit server action — the app's heaviest sync HTTP request
 * (≤8 full-res images buffered + one long vision call). Render's edge kills
 * ~100s requests and small instances OOM'd → operator-facing 502s. It now
 * runs here: no HTTP timeout, refs downscaled to max-edge 1024 JPEG first
 * (2K refs are pointless for style extraction), and failures land in the
 * decisions ledger instead of a dead browser tab.
 */
export const styleDistill = inngest.createFunction(
  { id: "style-distill", retries: 1 },
  { event: "style/distill.requested" },
  async ({ event, step }) => {
    const { channelId, notes, autoActivate } = event.data;

    const result = await step.run("distill", async () => {
      const { db, providers, costSink } = await getContext();
      const refs = await db
        .select()
        .from(visualStyleRefs)
        .where(and(eq(visualStyleRefs.channelId, channelId), eq(visualStyleRefs.enabled, true)))
        .orderBy(desc(visualStyleRefs.createdAt))
        .limit(MAX_STYLE_REF_IMAGES);
      if (refs.length === 0) return { error: "no enabled example images" };

      const [channel] = await db.select().from(channels).where(eq(channels.id, channelId));
      const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, channelId));
      if (!channel) return { error: "channel not found" };

      const images: { bytes: Buffer; mimeType: string }[] = [];
      for (const r of refs) {
        try {
          const raw = await providers.store.getBuffer(r.storageKey);
          if (raw.length > HARD_SKIP_BYTES) continue;
          const scaled = await downscaleImage(raw);
          images.push({
            bytes: scaled.bytes,
            mimeType: scaled.mimeType || r.mimeType,
          });
        } catch {
          // a missing blob never blocks distillation of the rest
        }
      }
      if (images.length === 0) return { error: "no readable example images" };

      const distilled = await distillVisualStyle(
        { db, llm: providers.llm, costSink, channelId },
        {
          images,
          niche: channel.niche,
          imageStyle: dna?.visualStyle?.imageStyle ?? "",
          notes,
        },
      );

      const existing = await db
        .select({ version: visualStyles.version, id: visualStyles.id, status: visualStyles.status })
        .from(visualStyles)
        .where(eq(visualStyles.channelId, channelId))
        .orderBy(desc(visualStyles.version));
      const active = existing.find((s) => s.status === "active");
      const { rationale, ...docFields } = distilled;
      const doc: VisualStyleDoc = {
        ...docFields,
        refIds: refs.map((r) => r.id),
        // all_generated (2026-07-15): the example images condition EVERY
        // generated shot, not just heroes — the operator's ask was that the
        // whole video carry the distilled look (dial back on the Style tab)
        conditioning: { scope: "all_generated", strength: 0.45 },
      };
      const styleId = ulid();
      await db.insert(visualStyles).values({
        id: styleId,
        channelId,
        name: `Style v${(existing[0]?.version ?? 0) + 1}`,
        version: (existing[0]?.version ?? 0) + 1,
        parentId: active?.id ?? null,
        status: autoActivate ? "active" : "draft",
        createdBy: "operator",
        doc,
        rationale,
      });
      if (autoActivate) {
        // retire the prior active first (parity with activateStyleAction —
        // otherwise autoActivate leaves two rows marked active)
        if (active) {
          await db.update(visualStyles).set({ status: "retired" }).where(eq(visualStyles.id, active.id));
        }
        await db.update(channelDna).set({ activeStyleId: styleId }).where(eq(channelDna.channelId, channelId));
      }
      return { styleId, images: images.length };
    });

    if ("error" in result) {
      // visible failure: the operator asked for this distill from the UI
      await step.run("log-failure", async () => {
        const { db } = await getContext();
        await db.insert(channelDecisions).values({
          id: ulid(),
          channelId,
          kind: "retro_observation",
          summary: `Style distill failed: ${result.error}`,
          detail: { notes: notes ?? null },
          actor: "agent",
        });
      });
    }
    return result;
  },
);
