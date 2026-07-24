import { eq } from "drizzle-orm";
import { channelDna, visualStyleRefs, visualStyles, type Db } from "@ytauto/db";
import { resolveConditioning, styleBlockForImagePrompts } from "@ytauto/core";

/**
 * The channel's ACTIVE visual style, resolved for the image-prompt builder
 * (production-pipeline.ts §2): the distilled prompt block, the example-image ref
 * keys that drive image-to-image conditioning (doc.refIds → enabled
 * visualStyleRefs), and the conditioning scope/strength.
 *
 * This is the ONE definition of "the channel look" — Studio Generate, thumbnails,
 * AND character reference sheets all condition on it, so a character is rendered in
 * the same visual style the operator built in the Style tab instead of a hardcoded
 * default. Empty (block null, no refs, scope off) when the channel has no active
 * style yet.
 */
export type ActiveStyle = {
  block: string | null;
  refKeys: string[];
  conditioning: ReturnType<typeof resolveConditioning>;
  styleId: string | null;
};

export async function activeStyleFor(db: Db, channelId: string): Promise<ActiveStyle> {
  const empty: ActiveStyle = { block: null, refKeys: [], conditioning: resolveConditioning(null), styleId: null };
  const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, channelId));
  if (!dna?.activeStyleId) return empty;
  const [style] = await db.select().from(visualStyles).where(eq(visualStyles.id, dna.activeStyleId));
  if (!style || style.status !== "active") return empty;
  const refs = await db
    .select({ id: visualStyleRefs.id, storageKey: visualStyleRefs.storageKey, enabled: visualStyleRefs.enabled })
    .from(visualStyleRefs)
    .where(eq(visualStyleRefs.channelId, channelId));
  const byId = new Map(refs.filter((r) => r.enabled).map((r) => [r.id, r.storageKey]));
  const refKeys = (style.doc.refIds ?? []).map((id) => byId.get(id)).filter((k): k is string => Boolean(k));
  return { block: styleBlockForImagePrompts(style.doc), refKeys, conditioning: resolveConditioning(style.doc), styleId: style.id };
}
