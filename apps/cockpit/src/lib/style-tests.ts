/**
 * Style TEST SCENES — shared domain logic (2026-07-25 operator: "the test scene
 * does not have a prompt section to create scenes or allow me to test scenes
 * with inject one of many characters, and needs to be open on the MCP also").
 *
 * A test scene is a throwaway render used to try the channel's look — and, above
 * all, to see how a character's reference sheet actually behaves as an input —
 * before committing to a style or shipping a video. Three things this module
 * fixes versus the old Style-tab-only action:
 *
 *  1. NO DISTILLED STYLE REQUIRED. The scene renders against whatever the
 *     channel has: an active/newest distilled style if there is one, else the
 *     plain house `imageStyle`, else no style at all. Requiring a distilled
 *     version is why a fresh channel had no prompt box (migration 0063 makes
 *     `styleId` nullable).
 *  2. MANY CHARACTERS. Cast any subset of the channel's cast into one scene.
 *     Every character's canonical description is injected, and their reference
 *     sheets ride as image references (the first in the primary slot, the rest as
 *     extras) so identity holds for each.
 *  3. ONE code path for the cockpit form AND the MCP tools — no drift, exactly
 *     like `lib/characters.ts`.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  channelCharacters,
  channelDna,
  styleTestScenes,
  ulid,
  visualStyles,
} from "@ytauto/db";
import {
  imageEngineForRole,
  imageEnginePreference,
  resolveImageStyle,
  resolveProductionProfile,
  styleBlockForImagePrompts,
} from "@ytauto/core";
import { getAppContext } from "@/lib/context";
import { referenceUrlFor } from "@/lib/reference-url";
import { asCharacterEngine, type CharacterImageEngine } from "@/lib/characters";

export type TestSceneResult = {
  sceneId: string;
  url: string;
  /** what actually steered the look, for the operator's confidence */
  styleUsed: { kind: "distilled"; version: number } | { kind: "house" } | { kind: "none" };
  charactersCast: { id: string; name: string }[];
  engine: CharacterImageEngine;
};

/** Resolve the style that a test scene should render under. */
async function resolveSceneStyle(
  db: Awaited<ReturnType<typeof getAppContext>>["db"],
  channelId: string,
  requestedStyleId: string | null | undefined,
) {
  const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, channelId));
  const versions = await db
    .select()
    .from(visualStyles)
    .where(eq(visualStyles.channelId, channelId))
    .orderBy(desc(visualStyles.version));
  // explicit pick → the ACTIVE version → the newest draft → none
  const style =
    (requestedStyleId ? versions.find((v) => v.id === requestedStyleId) : undefined) ??
    versions.find((v) => v.id === dna?.activeStyleId && v.status === "active") ??
    versions[0] ??
    null;
  return { dna, style };
}

/**
 * Render a test scene. `scene` is the operator's plain-language ask; every id in
 * `characterIds` is cast into it. Returns the stored scene + what steered it.
 */
export async function generateStyleTestScene(
  channelId: string,
  input: {
    scene: string;
    characterIds?: string[];
    /** pin a specific style version; omitted → active, else newest, else none */
    styleId?: string | null;
    imageEngine?: string | null;
  },
): Promise<TestSceneResult> {
  const scene = input.scene.trim();
  if (!scene) throw new Error("Describe the scene first");

  const { db, providers } = await getAppContext();
  const { dna, style } = await resolveSceneStyle(db, channelId, input.styleId);

  // cast — preserve the caller's order, drop unknown/foreign ids
  const wanted = (input.characterIds ?? []).filter(Boolean);
  const cast = wanted.length
    ? (
        await db
          .select()
          .from(channelCharacters)
          .where(and(eq(channelCharacters.channelId, channelId), inArray(channelCharacters.id, wanted)))
      ).sort((a, b) => wanted.indexOf(a.id) - wanted.indexOf(b.id))
    : [];
  const missing = wanted.filter((id) => !cast.some((c) => c.id === id));
  if (missing.length) throw new Error(`Character not found on this channel: ${missing.join(", ")}`);

  // every cast member's sheet rides as an image reference so each identity holds
  const refUrls = (
    await Promise.all(cast.map((c) => referenceUrlFor(providers.store, c.imageKey, c.mimeType).catch(() => null)))
  ).filter((u): u is string => Boolean(u));

  const houseStyle = resolveImageStyle(dna?.visualStyle?.imageStyle);
  const styleClause = style
    ? styleBlockForImagePrompts(style.doc)
    : houseStyle
      ? `Visual style: ${houseStyle}.`
      : "";

  // Lead with the SCENE, then place each character in it (mirrors the pipeline's
  // rule: the scene is the subject, a character is a participant).
  const castClause = cast.length
    ? `Cast in this scene — render each as described and keep them distinct from one another: ${cast
        .map((c) => `${c.name}: ${c.description}`)
        .join(" | ")}`
    : "";
  const prompt = [scene, castClause, "Explicit natural lighting, cinematic composition.", styleClause]
    .filter(Boolean)
    .join(" ");

  const profile = resolveProductionProfile(dna?.productionProfile);
  const engine = asCharacterEngine(input.imageEngine) ?? imageEngineForRole(profile, "hero");
  const fallbackEngines = [...new Set([engine, ...imageEnginePreference(profile, "hero")])];

  const { storageKey, mimeType } = await providers.media.generateImage({
    prompt,
    aspect: "16:9",
    channelId,
    storageKeyBase: `channels/${channelId}/style-tests/${ulid()}`,
    quality: "hero",
    engine,
    fallbackEngines,
    ...(refUrls[0] ? { referenceImageUrl: refUrls[0] } : {}),
    ...(refUrls.length > 1 ? { extraReferenceImageUrls: refUrls.slice(1) } : {}),
  });

  const sceneId = ulid();
  await db.insert(styleTestScenes).values({
    id: sceneId,
    channelId,
    styleId: style?.id ?? null,
    characterId: cast[0]?.id ?? null,
    characterIds: cast.length ? cast.map((c) => c.id) : null,
    prompt: scene,
    imageKey: storageKey,
    mimeType,
  });

  return {
    sceneId,
    url: `/api/media/${storageKey}`,
    styleUsed: style
      ? { kind: "distilled", version: style.version }
      : houseStyle
        ? { kind: "house" }
        : { kind: "none" },
    charactersCast: cast.map((c) => ({ id: c.id, name: c.name })),
    engine,
  };
}

/** Test scenes for a channel, newest first (with the cast resolved to names). */
export async function listStyleTestScenes(channelId: string): Promise<
  {
    id: string;
    prompt: string;
    url: string;
    characters: string[];
    styleVersion: number | null;
    lastComments: string | null;
    createdAt: string;
  }[]
> {
  const { db } = await getAppContext();
  const rows = await db
    .select()
    .from(styleTestScenes)
    .where(eq(styleTestScenes.channelId, channelId))
    .orderBy(desc(styleTestScenes.createdAt));
  const chars = await db.select().from(channelCharacters).where(eq(channelCharacters.channelId, channelId));
  const nameById = new Map(chars.map((c) => [c.id, c.name]));
  const versions = await db.select().from(visualStyles).where(eq(visualStyles.channelId, channelId));
  const versionById = new Map(versions.map((v) => [v.id, v.version]));
  return rows.map((s) => ({
    id: s.id,
    prompt: s.prompt,
    url: `/api/media/${s.imageKey}`,
    characters: (s.characterIds ?? (s.characterId ? [s.characterId] : []))
      .map((id) => nameById.get(id))
      .filter((n): n is string => Boolean(n)),
    styleVersion: s.styleId ? (versionById.get(s.styleId) ?? null) : null,
    lastComments: s.lastComments,
    createdAt: s.createdAt.toISOString(),
  }));
}

/** Rework a test scene from operator comments (its current image is the reference). */
export async function refineStyleTestScene(
  channelId: string,
  sceneId: string,
  comments: string,
): Promise<{ sceneId: string; url: string }> {
  const text = comments.trim();
  if (!text) throw new Error("Describe the changes you want first");
  const { db, providers } = await getAppContext();
  const [sceneRow] = await db
    .select()
    .from(styleTestScenes)
    .where(and(eq(styleTestScenes.id, sceneId), eq(styleTestScenes.channelId, channelId)));
  if (!sceneRow) throw new Error("Test scene not found");
  const { dna, style } = await resolveSceneStyle(db, channelId, sceneRow.styleId);
  const houseStyle = resolveImageStyle(dna?.visualStyle?.imageStyle);
  const referenceImageUrl = await referenceUrlFor(providers.store, sceneRow.imageKey, sceneRow.mimeType);
  const prompt = [
    `Rework this scene: ${sceneRow.prompt}.`,
    `Changes to apply: ${text}.`,
    "Keep everything not mentioned the same.",
    style ? styleBlockForImagePrompts(style.doc) : houseStyle ? `Visual style: ${houseStyle}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const profile = resolveProductionProfile(dna?.productionProfile);
  const engine = imageEngineForRole(profile, "hero");
  const { storageKey, mimeType } = await providers.media.generateImage({
    prompt,
    aspect: "16:9",
    channelId,
    storageKeyBase: `channels/${channelId}/style-tests/${ulid()}`,
    quality: "hero",
    engine,
    fallbackEngines: [...new Set([engine, ...imageEnginePreference(profile, "hero")])],
    ...(referenceImageUrl ? { referenceImageUrl } : {}),
  });
  await db
    .update(styleTestScenes)
    .set({ imageKey: storageKey, mimeType, lastComments: text })
    .where(eq(styleTestScenes.id, sceneId));
  return { sceneId, url: `/api/media/${storageKey}` };
}
