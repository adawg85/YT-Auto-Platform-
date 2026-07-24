/**
 * Recurring channel characters — shared domain logic (2026-07-24).
 *
 * A named on-screen character (e.g. an educational channel's teacher, or a
 * mascot) with a canonical appearance paragraph and a Nano Banana reference
 * sheet, cast into generated shots so it stays consistent across every video.
 * Characters are per-channel and MANY per channel; the pipeline can force
 * several of them onto one video (see `assignForcedCharacterShots`).
 *
 * This module is the single home for the create / refine / cast / list / delete
 * operations. It is plain (NOT "use server") so BOTH the cockpit Style-tab form
 * actions (`channels/style-actions.ts`) and the MCP tool registry
 * (`lib/mcp/tools.ts`) call the exact same code — no drift between what the
 * operator does in the UI and what Claude-in-chat does over the connector.
 *
 * Every mutation logs a `channel_decisions` row (actor `operator`); an MCP-driven
 * change passes `via: "mcp"` so the audit trail shows the origin.
 */
import { and, desc, eq } from "drizzle-orm";
import {
  channelCharacters,
  channelDecisions,
  channelDna,
  ulid,
} from "@ytauto/db";
import {
  CHARACTER_CAST_MODES,
  DEFAULT_CAST_TARGET,
} from "@ytauto/core";
import { generateCharacterSheet } from "@ytauto/agents";
import { getAppContext } from "@/lib/context";
import { referenceUrlFor } from "@/lib/reference-url";
import { activeStyleFor } from "@/lib/active-style";

/** A character as returned to callers (UI cards + MCP list). */
export interface CharacterSummary {
  id: string;
  name: string;
  brief: string;
  /** canonical appearance paragraph injected verbatim into image prompts */
  description: string;
  role: string;
  castMode: string;
  castTarget: number;
  enabled: boolean;
  imageKey: string;
  mimeType: string;
  createdAt: string;
}

const clampTarget = (n: number | null | undefined): number =>
  Math.max(0, Math.min(100, Math.round(Number.isFinite(n as number) ? (n as number) : DEFAULT_CAST_TARGET)));

const isCastMode = (m: string): boolean => (CHARACTER_CAST_MODES as readonly string[]).includes(m);

function toSummary(row: typeof channelCharacters.$inferSelect): CharacterSummary {
  return {
    id: row.id,
    name: row.name,
    brief: row.brief,
    description: row.description,
    role: row.role,
    castMode: row.castMode,
    castTarget: row.castTarget,
    enabled: row.enabled,
    imageKey: row.imageKey,
    mimeType: row.mimeType,
    createdAt: row.createdAt.toISOString(),
  };
}

/** All characters on a channel, newest first. */
export async function listChannelCharacters(channelId: string): Promise<CharacterSummary[]> {
  const { db } = await getAppContext();
  const rows = await db
    .select()
    .from(channelCharacters)
    .where(eq(channelCharacters.channelId, channelId))
    .orderBy(desc(channelCharacters.createdAt));
  return rows.map(toSummary);
}

/**
 * The character reference-CARD prompt. The card is a neutral IDENTITY anchor —
 * whole figure, front-on, plain ground — so the face, build and clothing read
 * cleanly when the sheet is reused as an identity reference in scenes. Two rules
 * make it obey the operator's Style tab instead of a hidden default:
 *
 *  1. Its LOOK is the channel's active visual style (distilled from the
 *     operator's uploaded examples) — the SAME base every scene uses — never a
 *     hardcoded photoreal/studio register. The look rides as TEXT (`styleBlock`),
 *     not an image ref: conditioning a character on the style's scene examples
 *     drags identity off-model (operator-reported "3D background"), so the
 *     distilled block carries the channel look instead (mirrors Studio Generate).
 *  2. The neutral framing lives ONLY here, never in the stored description, so a
 *     scene stays free to pose and scale the character however the shot needs
 *     (human-sized, god-size, mid-action) — the card doesn't lock them into a
 *     portrait.
 */
function characterSheetPrompt(
  description: string,
  styleBlock: string | null,
  imageStyle: string,
  change?: string,
): string {
  const look = styleBlock
    ? `Render entirely in the channel's visual style — this is the ONLY style authority; do not add any other medium, finish, or realism of your own:\n${styleBlock}`
    : `Visual style: ${imageStyle}.`;
  return (
    `Character reference of ${description} ` +
    (change ? `Apply this change to the existing character: ${change}. Keep the SAME person — identical face and identity. ` : "") +
    `Show the whole figure head to feet, seen front-on against a plain, uncluttered neutral ` +
    `background — a clean identity reference with the face, build and clothing clearly legible ` +
    `and nothing else in frame. ${look}`
  );
}

/**
 * Create a character: an LLM pass distills the operator's brief into the
 * canonical appearance paragraph, then Nano Banana renders the reference sheet
 * in the channel's active style. Throws on a hard failure (missing input, model
 * error) — the caller decides whether to surface or swallow it.
 */
export async function createChannelCharacter(
  channelId: string,
  input: { name: string; brief: string; role?: string; castMode?: string; castTarget?: number },
  opts: { via?: string } = {},
): Promise<CharacterSummary> {
  const name = input.name.trim();
  const brief = input.brief.trim();
  if (!name) throw new Error("Character name is required");
  if (!brief) throw new Error("Character brief is required");
  const role = input.role?.trim() || "main";
  const castMode = input.castMode && isCastMode(input.castMode) ? input.castMode : "auto";
  const castTarget = clampTarget(input.castTarget);

  const { db, providers, costSink } = await getAppContext();
  const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, channelId));
  const imageStyle = dna?.visualStyle?.imageStyle || "clean flat illustration, high contrast";
  const style = await activeStyleFor(db, channelId);

  const sheet = await generateCharacterSheet(
    { db, llm: providers.llm, costSink, channelId },
    { name, brief, imageStyle, styleBlock: style.block },
  );
  const prompt = characterSheetPrompt(sheet.description, style.block, imageStyle);
  const { storageKey, mimeType } = await providers.media.generateImage({
    prompt,
    aspect: "1:1",
    channelId,
    storageKeyBase: `channels/${channelId}/characters/${ulid()}`,
    quality: "hero",
    engine: "nano-banana",
  });

  const id = ulid();
  const [row] = await db
    .insert(channelCharacters)
    .values({
      id,
      channelId,
      name,
      brief,
      description: sheet.description,
      imageKey: storageKey,
      mimeType,
      role,
      castMode,
      castTarget,
    })
    .returning();
  await db.insert(channelDecisions).values({
    id: ulid(),
    channelId,
    kind: "operator_steer",
    summary: `Character "${name}" created for image consistency`,
    detail: { name, brief, ...(opts.via ? { via: opts.via } : {}) },
    actor: "operator",
  });
  return toSummary(row!);
}

/**
 * Regenerate a character's reference sheet per operator comments: the sheet
 * agent applies the comments to the canonical description (unmentioned details
 * stay verbatim), then the image model reworks the CURRENT image toward the
 * revised look — description and pixels stay in sync.
 */
export async function refineChannelCharacter(
  channelId: string,
  characterId: string,
  comments: string,
  opts: { via?: string } = {},
): Promise<{ imageKey: string; mimeType: string; description: string }> {
  const text = comments.trim();
  if (!text) throw new Error("Describe the changes you want first");
  const { db, providers, costSink } = await getAppContext();
  const [character] = await db
    .select()
    .from(channelCharacters)
    .where(and(eq(channelCharacters.id, characterId), eq(channelCharacters.channelId, channelId)));
  if (!character) throw new Error("Character not found on this channel");
  const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, channelId));
  const imageStyle = dna?.visualStyle?.imageStyle || "clean flat illustration, high contrast";
  const style = await activeStyleFor(db, channelId);

  const sheet = await generateCharacterSheet(
    { db, llm: providers.llm, costSink, channelId },
    {
      name: character.name,
      brief: character.brief,
      imageStyle,
      styleBlock: style.block,
      currentDescription: character.description,
      comments: text,
    },
  );
  // the character's CURRENT image is the identity anchor (keep the same face);
  // the channel look still rides as TEXT via style.block, not a second image ref
  const referenceImageUrl = await referenceUrlFor(providers.store, character.imageKey, character.mimeType);
  const prompt = characterSheetPrompt(sheet.description, style.block, imageStyle, text);
  const { storageKey, mimeType } = await providers.media.generateImage({
    prompt,
    aspect: "1:1",
    channelId,
    storageKeyBase: `channels/${channelId}/characters/${ulid()}`,
    quality: "hero",
    engine: "nano-banana",
    ...(referenceImageUrl ? { referenceImageUrl } : {}),
  });
  await db
    .update(channelCharacters)
    .set({ description: sheet.description, imageKey: storageKey, mimeType })
    .where(eq(channelCharacters.id, characterId));
  await db.insert(channelDecisions).values({
    id: ulid(),
    channelId,
    kind: "operator_steer",
    summary: `Character "${character.name}" refined: ${text.slice(0, 120)}`,
    detail: { characterId, comments: text, ...(opts.via ? { via: opts.via } : {}) },
    actor: "operator",
  });
  return { imageKey: storageKey, mimeType, description: sheet.description };
}

/**
 * Set how often a character is cast and whether it is enabled. `castMode`
 * controls forced presence (off/auto/smart/25/50/75/always); `castTarget` is the
 * share for `smart`; `enabled` toggles the character in/out of the pipeline
 * entirely. Only provided fields change. Returns the updated character.
 */
export async function setChannelCharacterCast(
  channelId: string,
  characterId: string,
  patch: { castMode?: string; castTarget?: number; enabled?: boolean },
  opts: { via?: string } = {},
): Promise<CharacterSummary> {
  const { db } = await getAppContext();
  const [row] = await db
    .select()
    .from(channelCharacters)
    .where(and(eq(channelCharacters.id, characterId), eq(channelCharacters.channelId, channelId)));
  if (!row) throw new Error("Character not found on this channel");

  const set: Partial<typeof channelCharacters.$inferInsert> = {};
  if (patch.castMode !== undefined) {
    if (!isCastMode(patch.castMode)) {
      throw new Error(`Invalid castMode "${patch.castMode}" — use one of: ${CHARACTER_CAST_MODES.join(", ")}`);
    }
    set.castMode = patch.castMode;
  }
  if (patch.castTarget !== undefined) set.castTarget = clampTarget(patch.castTarget);
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (Object.keys(set).length === 0) return toSummary(row);

  await db
    .update(channelCharacters)
    .set(set)
    .where(and(eq(channelCharacters.id, characterId), eq(channelCharacters.channelId, channelId)));
  await db.insert(channelDecisions).values({
    id: ulid(),
    channelId,
    kind: "operator_steer",
    summary: `Character "${row.name}" casting updated`,
    detail: { characterId, ...set, ...(opts.via ? { via: opts.via } : {}) },
    actor: "operator",
  });
  return toSummary({ ...row, ...set });
}

/** Remove a character. Reference-sheet bytes stay in the store — past
 * productions may cite them. */
export async function deleteChannelCharacter(channelId: string, characterId: string): Promise<void> {
  const { db } = await getAppContext();
  await db
    .delete(channelCharacters)
    .where(and(eq(channelCharacters.id, characterId), eq(channelCharacters.channelId, channelId)));
}
