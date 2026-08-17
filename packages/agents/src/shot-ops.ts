/**
 * Shot operations — regenerate one shot's image, (re)write its prompt, and fill
 * every thin prompt on a production.
 *
 * These used to live ONLY as cockpit server actions, which meant they ran inside
 * the operator's browser request: background the tab and the connection is torn
 * down mid-flight, so the work never lands and a refresh shows no trace and no
 * "still running" state (2026-07-25 operator: "it's like it requires me to be
 * there for it to exist"). The style distill hit the same wall and was moved to
 * the worker; "Regen all" already queues an Inngest event and survives.
 *
 * The logic now lives here, taking its context explicitly, so it can be called
 * from EITHER side with identical behaviour:
 *   - the worker, from a durable Inngest event (the cockpit UI path — survives
 *     the browser closing, and Inngest retries it), and
 *   - directly, server-to-server, where a synchronous result is wanted (the MCP
 *     regenerate_shot tool, which returns the new image URL to the caller).
 */
import { and, desc, eq } from "drizzle-orm";
import { ulid } from "ulid";
import {
  assets,
  channelCharacters,
  channelDna,
  channels,
  productions,
  scriptDrafts,
  type Db,
  type ScriptBeat,
  type WordTimestamp,
} from "@ytauto/db";
import {
  applyHouseImageStyle,
  resolveShotStyleRegister,
  type StyleSource,
  imageEngineForRole,
  imageEnginePreference,
  resolveProductionProfile,
  planShots,
  planShotsFromDirection,
  shotPlanOptions,
  isLongFormShotPlan,
  styleRefKeyForIndex,
  videoAspect,
  videoEngineFor,
  type Shot,
} from "@ytauto/core";
import type { Providers } from "@ytauto/providers";
import type { CostSink } from "@ytauto/core";
import { buildImagePrompts } from "./image-prompt";
import { activeStyleFor } from "./active-style";

/** Everything these operations need — the same shape the cockpit and the worker
 * each already build (`getAppContext()` / `getContext()`). */
export type ShotOpsCtx = { db: Db; providers: Providers; costSink: CostSink };

/** vendor clip ceiling (env-tunable), moved with deriveShotPlan */
const MAX_CLIP_SEC = () => Number(process.env.VIDEO_MAX_CLIP_SEC ?? "10");

export async function regenerateShotPrompt(
  ctx: ShotOpsCtx,
  productionId: string,
  assetId: string,
  opts: { persist?: boolean } = {},
): Promise<{ prompt?: string; error?: string }> {
  const { db, providers, costSink } = ctx;
  const [asset] = await db
    .select({ idx: assets.idx, meta: assets.meta })
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.productionId, productionId), eq(assets.kind, "image")));
  if (!asset) return { error: "Image not found" };
  const [production] = await db.select().from(productions).where(eq(productions.id, productionId));
  if (!production) return { error: "Production not found" };
  const [channel] = await db.select().from(channels).where(eq(channels.id, production.channelId));
  if (!channel) return { error: "Channel not found" };
  const plan = await deriveShotPlan(db, productionId);
  const shot = plan?.shots[asset.idx];
  if (!shot) return { error: "This shot isn't in the current plan — regenerate the image set first" };

  const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, production.channelId));
  const style = await activeStyleFor(db, production.channelId);
  const profile = resolveProductionProfile(production.productionProfile ?? dna?.productionProfile ?? null, {
    contentFormat: channel.contentFormat,
  });
  const isLong = videoAspect({ contentFormat: channel.contentFormat, targetLengthSec: dna?.targetLengthSec, orientation: resolveProductionProfile(dna?.productionProfile ?? null).orientation }) === "16:9";
  const chars = await db
    .select()
    .from(channelCharacters)
    .where(eq(channelCharacters.channelId, production.channelId));
  try {
    const built = await buildImagePrompts(
      { db, llm: providers.llm, costSink, channelId: production.channelId, productionId },
      {
        // the DIRECTOR'S full instruction set for this shot — same fields the
        // pipeline passes, so the retry matches the "great" prompts it wrote
        shots: [
          {
            text: shot.text,
            imagePrompt: shot.imagePrompt,
            referenceEntity: shot.referenceEntity,
            visualBrief: shot.visualBrief,
            shotScale: shot.shotScale,
            angle: shot.angle,
            intent: shot.intent,
            motif: shot.motif,
          },
        ],
        imageStyle: dna?.visualStyle?.imageStyle ?? null,
        artDirection: profile.artDirection ?? null,
        orientation: isLong ? "landscape" : "portrait",
        niche: channel.niche,
        styleBlock: style.block,
        characters: chars
          .filter((c) => c.castMode !== "off")
          .map((c) => ({ name: c.name, description: c.description, role: c.role, castMode: c.castMode })),
        // one operator-triggered call — worth the frontier model for reliability
        tier: "frontier",
      },
    );
    const prompt = built[0]?.prompt;
    if (!prompt) return { error: "The prompt agent returned nothing — try again" };
    // buildImagePrompts falls back to the raw brief when the model call failed;
    // that draft has NO Style/Mood suffix. Detecting it lets us tell the operator
    // "it didn't elaborate, retry" instead of silently showing a thin prompt.
    const draft = shot.visualBrief ?? shot.imagePrompt;
    if (prompt.trim() === (draft ?? "").trim()) {
      return { error: "The prompt agent couldn't elaborate this shot just now — try Regenerate prompt again." };
    }
    // inline "Prompt" button persists so the next image Regenerate uses it and
    // the storyboard reflects it; the dialog omits persist (just fills the box).
    if (opts.persist) {
      const m = (asset.meta ?? {}) as Record<string, unknown>;
      await db.update(assets).set({ meta: { ...m, prompt } }).where(eq(assets.id, assetId));

    }
    return { prompt };
  } catch (err) {
    return { error: `Prompt generation failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function fillThinPrompts(
  ctx: ShotOpsCtx,
  productionId: string,
): Promise<{ filled?: number; thin?: number; error?: string }> {
  const { db, providers, costSink } = ctx;
  const [production] = await db.select().from(productions).where(eq(productions.id, productionId));
  if (!production) return { error: "Production not found" };
  const [channel] = await db.select().from(channels).where(eq(channels.id, production.channelId));
  if (!channel) return { error: "Channel not found" };
  const plan = await deriveShotPlan(db, productionId);
  if (!plan) return { error: "No shot plan yet — add a voiceover first" };

  const imgs = await db
    .select()
    .from(assets)
    .where(and(eq(assets.productionId, productionId), eq(assets.kind, "image")));
  const thin = imgs.filter((a) => {
    const m = (a.meta ?? {}) as Record<string, unknown>;
    if (typeof m.source === "string" && m.source) return false; // archival — no prompt
    return isThinPrompt(typeof m.prompt === "string" ? m.prompt : null);
  });
  if (thin.length === 0) return { filled: 0, thin: 0 };

  const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, production.channelId));
  const style = await activeStyleFor(db, production.channelId);
  const profile = resolveProductionProfile(production.productionProfile ?? dna?.productionProfile ?? null, {
    contentFormat: channel.contentFormat,
  });
  const isLong = videoAspect({ contentFormat: channel.contentFormat, targetLengthSec: dna?.targetLengthSec, orientation: resolveProductionProfile(dna?.productionProfile ?? null).orientation }) === "16:9";
  const chars = await db
    .select()
    .from(channelCharacters)
    .where(eq(channelCharacters.channelId, production.channelId));

  try {
    // one batched pass over all thin shots (buildImagePrompts batches 8 + split-retries)
    const built = await buildImagePrompts(
      { db, llm: providers.llm, costSink, channelId: production.channelId, productionId },
      {
        shots: thin.map((a) => {
          const shot = plan.shots[a.idx];
          return {
            text: shot?.text ?? "",
            imagePrompt: shot?.imagePrompt ?? "",
            referenceEntity: shot?.referenceEntity ?? null,
            visualBrief: shot?.visualBrief ?? null,
            shotScale: shot?.shotScale ?? null,
            angle: shot?.angle ?? null,
            intent: shot?.intent ?? null,
            motif: shot?.motif ?? null,
          };
        }),
        imageStyle: dna?.visualStyle?.imageStyle ?? null,
        artDirection: profile.artDirection ?? null,
        orientation: isLong ? "landscape" : "portrait",
        niche: channel.niche,
        styleBlock: style.block,
        characters: chars
          .filter((c) => c.castMode !== "off")
          .map((c) => ({ name: c.name, description: c.description, role: c.role, castMode: c.castMode })),
      },
    );

    let filled = 0;
    for (let i = 0; i < thin.length; i++) {
      const newPrompt = built[i]?.prompt;
      const shot = plan.shots[thin[i]!.idx];
      const draft = (shot?.visualBrief ?? shot?.imagePrompt ?? "").trim();
      // only persist a genuine elaboration (skip any that still fell back)
      if (!newPrompt || isThinPrompt(newPrompt) || newPrompt.trim() === draft) continue;
      const m = (thin[i]!.meta ?? {}) as Record<string, unknown>;
      await db.update(assets).set({ meta: { ...m, prompt: newPrompt } }).where(eq(assets.id, thin[i]!.id));
      filled++;
    }

    return { filled, thin: thin.length };
  } catch (err) {
    return { error: `Prompt generation failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function swapShotImage(
  ctx: ShotOpsCtx,
  productionId: string,
  assetId: string,
  mode: "real" | "standard" | "hero",
  opts: {
    prompt?: string;
    /** regenerate USING the current image as a reference (nano /edit, flux
     * /image-to-image) — keeps the composition, reworks the content */
    useReference?: boolean;
    /** 2026-07-14: cast a channel character — its canonical description leads
     * the prompt and its reference sheet takes the reference slot (identity
     * wins; mutually exclusive with useReference) */
    characterId?: string;
    /** 2026-07-16: operator's explicit model pick from the Regenerate dropdown
     * (nano-banana | qwen | seedream). Overrides the profile-derived engine;
     * nano-banana implies hero quality. Ignored for mode "real". */
    engine?: "nano-banana" | "qwen" | "seedream";
    /** #50 (ticket 01KY9EBK…): force the render aspect for THIS regeneration,
     * overriding the production-derived one — the escape hatch for a shot that
     * came back the wrong shape. Omitted → the normal videoAspect derivation. */
    aspectOverride?: "9:16" | "16:9" | "1:1";
  } = {},
): Promise<{ error?: string; clipRemoved?: boolean; storageKey?: string; aspect?: "9:16" | "16:9" | "1:1" }> {
  const { prompt, useReference, characterId } = opts;
  const { db, providers, costSink } = ctx;
  const [asset] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.productionId, productionId), eq(assets.kind, "image")));
  if (!asset) return { error: "Image not found" };
  const [production] = await db.select().from(productions).where(eq(productions.id, productionId));
  const [channel] = production
    ? await db.select().from(channels).where(eq(channels.id, production.channelId))
    : [];
  if (!production || !channel) return { error: "Production or channel not found" };
  const [swapDna] = await db.select().from(channelDna).where(eq(channelDna.channelId, production.channelId));
  // ONE aspect rule (core videoAspect): the Production Profile's explicit
  // orientation wins, else the long-form derivation. This action used to test
  // `contentFormat === "long"` alone, so a "both" channel regenerated its shots
  // as PORTRAIT on a 16:9 video (2026-07-25 operator).
  const swapAspect =
    opts.aspectOverride ??
    videoAspect({
      contentFormat: channel.contentFormat,
      targetLengthSec: swapDna?.targetLengthSec,
      orientation: resolveProductionProfile(swapDna?.productionProfile ?? null).orientation,
    });
  const isLong = swapAspect === "16:9";
  const meta = (asset.meta ?? {}) as Record<string, unknown>;
  let newStorageKey: string | undefined; // returned so the client updates the thumbnail without a refresh

  if (mode === "real") {
    const query =
      (typeof meta.entity === "string" && meta.entity) ||
      (typeof meta.topic === "string" && meta.topic) ||
      (typeof meta.draftPrompt === "string" && meta.draftPrompt) ||
      null;
    if (!query) return { error: "This shot has no subject to search the archives for — regenerate instead" };
    if (!providers.reference.findEntityImages) {
      return { error: "The configured reference provider can't list candidates" };
    }
    const siblings = await db
      .select({ meta: assets.meta })
      .from(assets)
      .where(and(eq(assets.productionId, productionId), eq(assets.kind, "image")));
    const used = new Set(
      siblings
        .map((s) => (s.meta as Record<string, unknown> | null)?.source)
        .filter((x): x is string => typeof x === "string"),
    );
    // random idx block: candidate files must never collide with the
    // pipeline's ref-{idx*100+n} keys OR a previous swap's (re-swapping the
    // same shot would otherwise overwrite the currently-chosen file)
    const swapIdx = 100_000 + Math.floor(Math.random() * 800_000);
    const hint =
      (typeof meta.prompt === "string" && meta.prompt) ||
      (typeof meta.draftPrompt === "string" && meta.draftPrompt) ||
      undefined;
    const cands = await providers.reference.findEntityImages({
      entity: query.slice(0, 120),
      channelId: production.channelId,
      productionId,
      idx: swapIdx,
      limit: 16,
      ...(hint ? { hint: hint.slice(0, 60) } : {}),
    });
    const fresh = cands.find((c) => !used.has(c.sourceUrl));
    if (!fresh) {
      return { error: "No unused archival photo found for this subject — try a regenerate instead" };
    }
    await db
      .update(assets)
      .set({
        storageKey: fresh.storageKey,
        mimeType: fresh.mimeType,
        meta: {
          ...(typeof meta.entity === "string" ? { entity: meta.entity } : {}),
          // narration belongs to the SHOT, not the image — survives every swap
          ...(typeof meta.narration === "string" ? { narration: meta.narration } : {}),
          source: fresh.sourceUrl,
          license: fresh.license,
          attribution: fresh.attribution,
          operatorSwap: "real",
          // #50: record the render aspect this image was fetched under so the
          // gate tools can report it and flag an orientation mismatch.
          aspect: swapAspect,
        },
      })
      .where(eq(assets.id, assetId));
    newStorageKey = fresh.storageKey;
  } else {
    // Prompt priority (2026-07-15): an operator-typed prompt wins; else RE-DERIVE
    // from THIS shot's narration (the stored meta.prompt may be a beat brief that
    // leaked onto the wrong shot — welding on a museums frame); the stored prompt
    // is only the last resort.
    let genPrompt: string | null = prompt?.trim() || null;
    // Did the prompt come from the BUILDER (which weaves the channel's style in
    // itself), or is it authored/stored text the builder never saw? Only the
    // latter needs the register appended — see the #93 block below.
    let builderStyled = false;
    // which register steered the redraw — stored on the asset so get_production_shots
    // can report it without a render (#93 reopen)
    let redrawStyleSource: StyleSource = "none";
    if (!genPrompt) {
      genPrompt = await rederivePromptFromNarration(
        db,
        providers.llm,
        costSink,
        production,
        channel,
        asset.idx,
        isLong,
      ).catch(() => null);
      // #63 (ticket 01KYE…): the re-derive can fall back to the raw narration verbatim
      // (the prompt builder returning its input). Never store the shot's own NARRATION
      // as its imagePrompt — that corrupts the audit record ("imagePrompt should never
      // be silently populated with the shot's own narration"). Discard it and fall
      // through to the stored prompt below.
      const narr = typeof meta.narration === "string" ? meta.narration.trim() : "";
      if (genPrompt && narr && genPrompt.trim() === narr) genPrompt = null;
      builderStyled = genPrompt !== null;
    }
    if (!genPrompt) {
      genPrompt =
        (typeof meta.prompt === "string" && meta.prompt) ||
        (typeof meta.draftPrompt === "string" && meta.draftPrompt) ||
        null;
    }
    // #93 (follow-up): the pipeline appends the channel's render register to an
    // AUTHORED prompt, but this REDRAW path renders authored/stored text
    // straight — no builder ran, so nothing ever applied the style. That is the
    // same defect on the repair route the ticket itself names: the remediation
    // for a styleless episode is `edit_shot_prompts(regenerate:true)`, which
    // writes the raw authored prompt to `meta.prompt` and lands here. Without
    // this, redrawing 118 shots to FIX the look would reproduce it exactly.
    // A distilled Style-tab style wins when active (its promptSuffix is built to
    // be appended verbatim); unlike the pipeline this path applies no style
    // reference conditioning, so the suffix is the only register available.
    if (genPrompt && !builderStyled) {
      const active = await activeStyleFor(db, production.channelId).catch(() => null);
      const reg = resolveShotStyleRegister({
        distilledPromptSuffix: active?.doc?.promptSuffix ?? null,
        houseImageStyle: swapDna?.visualStyle?.imageStyle ?? null,
      });
      genPrompt = applyHouseImageStyle(genPrompt, reg.register);
      redrawStyleSource = reg.register ? reg.source : "none";
    }
    let finalPrompt = genPrompt;
    let referenceImageUrl: string | undefined;
    let referenceStrength: number | undefined;
    let castCharacter: { id: string; name: string } | null = null;
    if (characterId) {
      // 2026-07-14: character casting — canonical description leads the
      // prompt, reference sheet takes the reference slot (identity wins),
      // exactly the pipeline's conditioning.
      const [character] = await db
        .select()
        .from(channelCharacters)
        .where(and(eq(channelCharacters.id, characterId), eq(channelCharacters.channelId, production.channelId)));
      if (!character) return { error: "Character not found on this channel" };
      finalPrompt = genPrompt ? `${character.description} — ${genPrompt}` : null;
      if (!finalPrompt) return { error: "No prompt available — type one to regenerate this image" };
      // Reference-sheet conditioning is best-effort: a missing/broken character
      // image key (or a store without presign) must NOT throw the whole action —
      // that surfaced as a silent "nothing happened" on the inline Image button
      // (2026-07-17). Degrade to the text description leading the prompt.
      if (providers.store.presignGet && !character.mimeType.includes("svg")) {
        try {
          referenceImageUrl = await providers.store.presignGet(character.imageKey, 900);
          referenceStrength = 0.55;
        } catch (err) {
          console.warn(
            `[swap] character "${character.name}" reference sheet could not be presigned (${character.imageKey}) — regenerating on the description only:`,
            err,
          );
        }
      }
      castCharacter = { id: character.id, name: character.name };
    } else if (useReference) {
      if (!providers.store.presignGet) {
        return { error: "Reference mode needs the S3/R2 store (presigned URLs) — not available here" };
      }
      // short-lived URL: the vendor fetches it once during the generation call
      referenceImageUrl = await providers.store.presignGet(asset.storageKey, 900);
    }
    if (!finalPrompt) return { error: "No prompt available — type one to regenerate this image" };
    // #122: carry the routing wrapper's placeholder verdict, so a regenerate that
    // ALSO lands on the mock backstop is declared instead of quietly replacing
    // one grey frame with another.
    let img: { storageKey: string; mimeType: string; engine?: string; placeholder?: boolean; engineErrors?: string[] };
    try {
      img = await providers.media.generateImage({
        prompt: finalPrompt,
        aspect: swapAspect,
        channelId: production.channelId,
        productionId,
        storageKeyBase: `productions/${productionId}/swap-${asset.idx}-${ulid().toLowerCase()}`,
        // operator's dropdown pick wins; nano-banana implies hero quality.
        // Otherwise fall back to the profile-derived engine + mode quality.
        quality: opts.engine
          ? opts.engine === "nano-banana"
            ? "hero"
            : undefined
          : mode === "hero"
            ? "hero"
            : undefined,
        // route per the channel profile, using the SAME role the fallbacks use —
        // the legacy imageEngineFor(…, "hero") always pinned nano-banana and
        // ignored the Style-tab heroImageEngine/characterImageEngine
        // (2026-07-25 operator)
        engine:
          opts.engine ??
          imageEngineForRole(
            resolveProductionProfile(swapDna?.productionProfile ?? null),
            castCharacter ? "character" : mode === "hero" ? "hero" : "bulk",
          ),
        // on failure, degrade down the Style-tab engines only (not a hardcoded qwen)
        fallbackEngines: imageEnginePreference(
          resolveProductionProfile(swapDna?.productionProfile ?? null),
          castCharacter ? "character" : mode === "hero" ? "hero" : "bulk",
        ),
        ...(referenceImageUrl ? { referenceImageUrl } : {}),
        ...(referenceStrength != null ? { referenceStrength } : {}),
      });
    } catch (err) {
      return { error: `Generation failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    // Derivative credit (licence compliance): regenerating WITH a licensed
    // real photo as reference produces a derivative — its source/licence/
    // attribution stay on the asset so the description credits it. PD/CC0
    // sources need no carry-over.
    const isLicensedSource =
      useReference &&
      typeof meta.source === "string" &&
      typeof meta.license === "string" &&
      /cc[- ]?by/i.test(meta.license);
    await db
      .update(assets)
      .set({
        storageKey: img.storageKey,
        mimeType: img.mimeType,
        meta: {
          prompt: finalPrompt,
          styleSource: redrawStyleSource,
          // carry-forward fix (2026-07-14): regenerates used to strip these,
          // losing the builder draft and subject for later swaps
          ...(typeof meta.draftPrompt === "string" ? { draftPrompt: meta.draftPrompt } : {}),
          ...(typeof meta.entity === "string" ? { entity: meta.entity } : {}),
          ...(typeof meta.narration === "string" ? { narration: meta.narration } : {}),
          ...(castCharacter ? { character: castCharacter.name, characterId: castCharacter.id } : {}),
          ...(mode === "hero" ? { hero: true } : {}),
          operatorSwap: mode,
          // #50: record the render aspect this still was generated at.
          aspect: swapAspect,
          // #122: what served the redraw — and whether it is a PLACEHOLDER.
          ...(img.engine ? { engineServed: img.engine } : {}),
          ...(img.placeholder ? { placeholder: true } : {}),
          ...(img.engineErrors?.length ? { engineErrors: img.engineErrors.slice(0, 4) } : {}),
          ...(isLicensedSource
            ? {
                source: meta.source,
                license: `${meta.license} (derivative)`,
                attribution: typeof meta.attribution === "string" ? meta.attribution : "",
                derived: true,
              }
            : {}),
        },
      })
      .where(eq(assets.id, assetId));
    newStorageKey = img.storageKey;
  }
  // 2026-07-14 (operator decision): a video clip derives from its shot's
  // image, and the render prefers the clip — a clip left behind after a swap
  // would silently override the new image. Delete it; the shot falls back to
  // the still until the operator hits Animate again.
  // #112: EXCEPT operator-recorded footage — that clip does NOT derive from
  // the image (the still is just its poster), and a Regenerate on the row
  // silently destroying real recorded footage is the worst possible trade.
  const [existingClip] = await db
    .select({ meta: assets.meta })
    .from(assets)
    .where(and(eq(assets.productionId, productionId), eq(assets.kind, "video_clip"), eq(assets.idx, asset.idx)));
  const isOperatorFootage = ((existingClip?.meta ?? {}) as Record<string, unknown>).operatorFootage === true;
  const staleClip = isOperatorFootage
    ? []
    : await db
        .delete(assets)
        .where(and(eq(assets.productionId, productionId), eq(assets.kind, "video_clip"), eq(assets.idx, asset.idx)))
        .returning({ id: assets.id });

  return {
    ...(staleClip.length ? { clipRemoved: true } : {}),
    ...(newStorageKey ? { storageKey: newStorageKey } : {}),
    aspect: swapAspect,
  };
}


// ── helpers moved with the operations above ──────────────────────────────

function isThinPrompt(p: string | null | undefined): boolean {
  if (!p || !p.trim()) return true;
  return !/style\s*:/i.test(p) && !/mood\s*:/i.test(p);
}

async function rederivePromptFromNarration(
  db: Db,
  llm: Providers["llm"],
  costSink: CostSink,
  production: typeof productions.$inferSelect,
  channel: typeof channels.$inferSelect,
  idx: number,
  isLong: boolean,
): Promise<string | null> {
  const plan = await deriveShotPlan(db, production.id);
  const shot = plan?.shots[idx];
  if (!shot) return null;
  const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, production.channelId));
  const style = await activeStyleFor(db, production.channelId);
  const artDirection = resolveProductionProfile(production.productionProfile ?? dna?.productionProfile ?? null, {
    contentFormat: channel.contentFormat,
  }).artDirection;
  const built = await buildImagePrompts(
    { db, llm, costSink, channelId: production.channelId, productionId: production.id },
    {
      // narration is the ONLY driver — no beat brief to leak the wrong subject
      shots: [{ text: shot.text, imagePrompt: shot.text, referenceEntity: shot.referenceEntity, visualBrief: null }],
      imageStyle: dna?.visualStyle?.imageStyle ?? null,
      artDirection: artDirection ?? null,
      orientation: isLong ? "landscape" : "portrait",
      niche: channel.niche,
      styleBlock: style.block,
    },
  );
  return built[0]?.prompt ?? null;
}

export async function deriveShotPlan(
  db: Db,
  productionId: string,
): Promise<{ shots: Shot[]; aspect: "9:16" | "16:9"; engine: "wan" | "minimax" | "seedance" | "seedance-pro" | "kling" } | null> {
  const [production] = await db.select().from(productions).where(eq(productions.id, productionId));
  if (!production) return null;
  const [channel] = await db.select().from(channels).where(eq(channels.id, production.channelId));
  if (!channel) return null;
  const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, production.channelId));
  const [draft] = await db
    .select()
    .from(scriptDrafts)
    .where(eq(scriptDrafts.productionId, productionId))
    .orderBy(desc(scriptDrafts.version))
    .limit(1);
  const [voiceover] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.productionId, productionId), eq(assets.kind, "voiceover"), eq(assets.idx, 0)));
  if (!draft || !voiceover || voiceover.durationSec == null) return null;
  const words = ((voiceover.meta as { words?: WordTimestamp[] } | null)?.words ?? []) as WordTimestamp[];
  const profile = resolveProductionProfile(production.productionProfile ?? dna?.productionProfile ?? null, {
    contentFormat: channel.contentFormat,
  });
  // #105 (reopen): ONE rule, the render's — an explicit productionProfile
  // orientation wins over the channel derivation. This path used to disagree
  // with the render on any portrait production on a "both"/long channel.
  const isLong = isLongFormShotPlan({
    contentFormat: channel.contentFormat,
    targetLengthSec: dna?.targetLengthSec,
    orientation: profile.orientation,
  });
  const spo = shotPlanOptions(profile, { isLong, durationSec: voiceover.durationSec, maxClipSec: MAX_CLIP_SEC() });
  let shots = planShots(draft.beats as ScriptBeat[], words, spo);
  // Visual Director (#37): mirror the render's directed cut when present
  const directedSeq = draft.directedSequence;
  if (profile.visualDirector && directedSeq?.length) {
    const directed = planShotsFromDirection(draft.beats as ScriptBeat[], words, directedSeq, {
      durationSec: voiceover.durationSec,
      maxShotSec: spo.maxShotSec,
    });
    if (directed) shots = directed;
  }
  return { shots, aspect: isLong ? "16:9" : "9:16", engine: videoEngineFor(profile) };
}

