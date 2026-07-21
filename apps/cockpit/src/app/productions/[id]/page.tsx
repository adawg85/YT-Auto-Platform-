import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  analyticsSnapshots,
  assets,
  channelCharacters,
  channelDna,
  channels,
  costRecords,
  ideas,
  productionMusic,
  productions,
  publications,
  reviewGates,
  scriptDrafts,
  styleTestScenes,
  thumbnails,
  visualStyles,
} from "@ytauto/db";
import { styleBlockForImagePrompts, imageEngineFellBack, resolveProductionProfile, listChannelBed, CHANNEL_BED_TARGET, MUSIC_VOLUMES } from "@ytauto/core";
import { getAppContext } from "@/lib/context";
import { loadUsdAudRates } from "@/lib/fx";
import { CLIP_PRICE_PER_SEC, deriveShotPlan } from "@/lib/shot-plan";
import { autoTitleWords } from "./thumbnail-compose";
import { forceForwardAction, resumeProductionAction, setVoiceSourceAction } from "../../actions";
import { GatePanel } from "./gate-panel";
import { ScriptEditor } from "./script-editor";
import { VoiceoverRecorder } from "./voiceover-recorder";
import { HaltPanel } from "./halt-panel";
import { PublishControls } from "./publish-controls";
import { RetryStagePanel } from "./retry-stage";
import { StaleRenderBanner } from "./stale-render-banner";
import { CorrectedCopyPanel } from "./corrected-copy-panel";
import { VisualsGrid } from "./visuals-grid";
import { MusicPanel } from "./music-panel";
import { AudioLevelsPanel } from "./audio-levels-panel";
import { RegenerateVisuals } from "./regenerate-visuals";
import { ThumbnailGallery } from "./thumbnail-gallery";
import { ProductionMetaBar } from "./production-meta-bar";
import { StatusBadge, ZoomImage } from "@/components/ui";
import { ProductionStepper, buildProductionSteps } from "@/components/production-stepper";
import type { HaltDiscard } from "../../actions";
import { IconAlertTriangle, IconChevronLeft, IconRefresh, IconUpload, IconZap } from "@/components/icons";
import { fmtDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

/** A built prompt always carries the "Style: … Mood: …" suffix; a thin fallback
 * draft (raw brief) has neither token. Mirrors actions.ts isThinPrompt. */
function isThinPromptText(p: string | null): boolean {
  if (!p || !p.trim()) return true;
  return !/style\s*:/i.test(p) && !/mood\s*:/i.test(p);
}

export default async function ProductionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { db } = await getAppContext();

  const [production] = await db.select().from(productions).where(eq(productions.id, id));
  if (!production) notFound();
  const [idea] = await db.select().from(ideas).where(eq(ideas.id, production.ideaId));
  const [channel] = await db.select().from(channels).where(eq(channels.id, production.channelId));
  // enabled characters for the swap dialog's Reference picker (2026-07-14)
  const characters = await db
    .select({ id: channelCharacters.id, name: channelCharacters.name })
    .from(channelCharacters)
    .where(and(eq(channelCharacters.channelId, production.channelId), eq(channelCharacters.enabled, true)));
  // thumbnail-studio references (2026-07-15): characters (with descriptions for
  // the live preview) + style scenes + the active style block string
  const [thumbCharacters, thumbScenes, thumbDna] = await Promise.all([
    db
      .select({ id: channelCharacters.id, name: channelCharacters.name, description: channelCharacters.description })
      .from(channelCharacters)
      .where(and(eq(channelCharacters.channelId, production.channelId), eq(channelCharacters.enabled, true)))
      .orderBy(desc(channelCharacters.createdAt)),
    db
      .select({ id: styleTestScenes.id, prompt: styleTestScenes.prompt })
      .from(styleTestScenes)
      .where(eq(styleTestScenes.channelId, production.channelId))
      .orderBy(desc(styleTestScenes.createdAt))
      .limit(12),
    db.select().from(channelDna).where(eq(channelDna.channelId, production.channelId)),
  ]);
  let thumbStyleBlock: string | null = null;
  if (thumbDna[0]?.activeStyleId) {
    const [st] = await db.select().from(visualStyles).where(eq(visualStyles.id, thumbDna[0].activeStyleId));
    if (st && st.status === "active") thumbStyleBlock = styleBlockForImagePrompts(st.doc);
  }
  const thumbReferences = [
    ...thumbCharacters.map((c) => ({ value: `char:${c.id}`, label: `Character: ${c.name}`, description: c.description })),
    ...thumbScenes.map((s) => ({
      value: `scene:${s.id}`,
      label: `Style scene: ${s.prompt.length > 50 ? `${s.prompt.slice(0, 50)}…` : s.prompt}`,
    })),
  ];
  const drafts = await db
    .select()
    .from(scriptDrafts)
    .where(eq(scriptDrafts.productionId, id))
    .orderBy(desc(scriptDrafts.version));
  const productionAssets = await db
    .select()
    .from(assets)
    .where(eq(assets.productionId, id))
    .orderBy(asc(assets.kind), asc(assets.idx));
  // background-music candidates + the resolved music level/mood (2026-07-17)
  const musicTracks = await db
    .select()
    .from(productionMusic)
    .where(eq(productionMusic.productionId, id))
    .orderBy(desc(productionMusic.createdAt));
  // Cross-video music library (2026-07-19, GLOBAL): every track generated on any
  // video, most-recent first, deduped by audio (storageKey) so the dropdown
  // lists each track once. Capped — the library is a convenience, not a browser.
  const libraryRows = await db
    .select({
      storageKey: productionMusic.storageKey,
      name: productionMusic.name,
      mood: productionMusic.mood,
      durationSec: productionMusic.durationSec,
      engine: productionMusic.engine,
    })
    .from(productionMusic)
    .orderBy(desc(productionMusic.createdAt))
    .limit(200);
  const seenLib = new Set<string>();
  const musicLibrary = libraryRows
    .filter((t) => (seenLib.has(t.storageKey) ? false : (seenLib.add(t.storageKey), true)))
    .slice(0, 60);
  // Per-channel music bed (2026-07-21): the curated pool the pipeline alternates
  // through. The Music panel shows/uses this by default; "search globally"
  // widens the reuse dropdown to the full cross-video library above.
  const channelBed = await listChannelBed(db, production.channelId);
  const musicProfile = resolveProductionProfile(production.productionProfile ?? thumbDna[0]?.productionProfile ?? null);
  const gates = await db
    .select()
    .from(reviewGates)
    .where(eq(reviewGates.productionId, id))
    .orderBy(desc(reviewGates.createdAt));
  const pubs = await db.select().from(publications).where(eq(publications.productionId, id));
  const snapshots = pubs.length
    ? await db
        .select()
        .from(analyticsSnapshots)
        .where(eq(analyticsSnapshots.publicationId, pubs[0]!.id))
        .orderBy(desc(analyticsSnapshots.capturedAt))
        .limit(1)
    : [];
  const latestSnap = snapshots[0];
  const costs = await db
    .select()
    .from(costRecords)
    .where(eq(costRecords.productionId, id))
    .orderBy(asc(costRecords.createdAt));

  const thumbs = await db.select().from(thumbnails).where(eq(thumbnails.productionId, id));
  // Costs are billed in USD; show them in AUD at each cost's OWN-day spot rate
  // (2026-07-19 operator, in Australia). USD kept alongside for reconciliation.
  const fx = await loadUsdAudRates(db, costs.map((c) => c.createdAt));
  const totalCost = costs.reduce((sum, c) => sum + Number(c.costUsd), 0);
  const totalCostAud = costs.reduce(
    (sum, c) => sum + Number(c.costUsd) * fx.rateFor(c.createdAt),
    0,
  );
  const pendingGate = gates.find((g) => g.status === "pending");
  const render = productionAssets.find((a) => a.kind === "render");
  const voiceover = productionAssets.find((a) => a.kind === "voiceover");
  // #27: operator-recorded per-beat takes (permanent — voice-clone material)
  const voTakes = productionAssets.filter((a) => a.kind === "voiceover_take");
  const images = productionAssets.filter((a) => a.kind === "image");
  const clips = productionAssets.filter((a) => a.kind === "video_clip");
  const clipByIdx = new Map(clips.map((c) => [c.idx, c]));
  // stale-render detection (2026-07-17): compare what the render baked in
  // (meta stamped by the render step) against the live clips + selected music.
  const renderMeta = (render?.meta ?? {}) as { clipIdxs?: number[]; musicKey?: string | null };
  const renderClipIdxs = new Set(Array.isArray(renderMeta.clipIdxs) ? renderMeta.clipIdxs : []);
  // clips: only trustworthy once a render has stamped its meta (legacy renders
  // didn't, so we don't false-alarm on them). music is new enough that a legacy
  // render never had any, so a selected track that isn't the render's = missing.
  const missingClipCount = Array.isArray(renderMeta.clipIdxs)
    ? clips.filter((c) => !renderClipIdxs.has(c.idx)).length
    : 0;
  // clips the render baked in that are no longer live — the operator removed them
  // ("Use the still instead"), but the render still shows the old clip until a
  // re-render (2026-07-20 operator: a Fix copy republished with removed footage).
  const liveClipIdxs = new Set(clips.map((c) => c.idx));
  const removedClipCount = Array.isArray(renderMeta.clipIdxs)
    ? [...renderClipIdxs].filter((i) => !liveClipIdxs.has(i)).length
    : 0;
  const selectedMusic = musicTracks.find((t) => t.selected) ?? null;
  const missingMusic = !!render && !!selectedMusic && (renderMeta.musicKey ?? null) !== selectedMusic.storageKey;
  const renderStale = !!render && (missingClipCount > 0 || removedClipCount > 0 || missingMusic);
  // shot timing for the Animate control (2026-07-14): same deterministic
  // derivation the pipeline used; null until a voiceover exists
  const shotPlan = await deriveShotPlan(db, id);
  const shotSecByIdx = new Map<number, number>((shotPlan?.shots ?? []).map((s, i) => [i, s.endSec - s.startSec]));
  // LIVE narration per shot from the current script/voiceover — the storyboard
  // shows this so a script edit reflects immediately, instead of the text
  // STAMPED on the image at generation time (2026-07-19 operator: edited the
  // script and the text above each shot didn't update).
  const shotTextByIdx = new Map<number, string>((shotPlan?.shots ?? []).map((s, i) => [i, s.text]));
  const maxClipSec = Number(process.env.VIDEO_MAX_CLIP_SEC ?? "10");
  // reference-image attribution (#7) + footage (#26) — licensed assets carry meta.license
  const seenCredit = new Set<string>();
  const imageCredits = [...images, ...clips]
    .map((a) => a.meta as { entity?: string; source?: string; license?: string; attribution?: string } | null)
    .filter((m): m is { entity?: string; source: string; license: string; attribution?: string } => {
      if (!m?.license || !m.source || seenCredit.has(m.source)) return false;
      seenCredit.add(m.source);
      return true;
    });
  // Duplicate flag (2026-07-20 operator): mark every shot that repeats another
  // shot — either the SAME narration line (the visible symptom when images
  // drift past the end of the shot list) OR the SAME image file. Shots that
  // match get the same short group label (A, B, …) so the pair is easy to find.
  const normDup = (s?: string | null) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const narrForImg = (a: (typeof images)[number]) =>
    normDup(shotTextByIdx.get(a.idx) ?? ((a.meta as { narration?: string } | null)?.narration ?? ""));
  const narrCounts = new Map<string, number>();
  const keyCounts = new Map<string, number>();
  for (const a of images) {
    const n = narrForImg(a);
    if (n) narrCounts.set(n, (narrCounts.get(n) ?? 0) + 1);
    keyCounts.set(a.storageKey, (keyCounts.get(a.storageKey) ?? 0) + 1);
  }
  const dupGroupByToken = new Map<string, string>();
  let dupGroupSeq = 0;
  const nextDupLetter = () => String.fromCharCode(65 + (dupGroupSeq++ % 26));
  for (const a of images) {
    const n = narrForImg(a);
    if (n && (narrCounts.get(n) ?? 0) > 1 && !dupGroupByToken.has(`n:${n}`)) dupGroupByToken.set(`n:${n}`, nextDupLetter());
  }
  for (const a of images) {
    if ((keyCounts.get(a.storageKey) ?? 0) > 1 && !dupGroupByToken.has(`k:${a.storageKey}`))
      dupGroupByToken.set(`k:${a.storageKey}`, nextDupLetter());
  }
  const dupGroupFor = (a: (typeof images)[number]): string | null => {
    const n = narrForImg(a);
    if (n && dupGroupByToken.has(`n:${n}`)) return dupGroupByToken.get(`n:${n}`)!;
    if (dupGroupByToken.has(`k:${a.storageKey}`)) return dupGroupByToken.get(`k:${a.storageKey}`)!;
    return null;
  };
  const latestDraft = drafts[0];
  // #24: real (archival) vs generated split — sourced assets carry meta.source
  const realImageCount = images.filter(
    (a) => Boolean((a.meta as { source?: string } | null)?.source),
  ).length;
  const generatedImageCount = images.length - realImageCount;
  // 2026-07-15 provenance: answer "is it using my distilled style + characters?"
  // at a glance. styleVersion is stamped on the row when an ACTIVE style rode
  // the render; per-image meta records which shots actually conditioned.
  const styleVersionUsed = (production as { styleVersion?: number | null }).styleVersion ?? null;
  const styleConditionedCount = images.filter(
    (a) => Boolean((a.meta as { styleRef?: string } | null)?.styleRef),
  ).length;
  const castCounts = new Map<string, number>();
  for (const a of images) {
    const c = (a.meta as { character?: string } | null)?.character;
    if (typeof c === "string") castCounts.set(c, (castCounts.get(c) ?? 0) + 1);
  }
  const castSummary = [...castCounts.entries()].map(([n, c]) => `${c}× ${n}`).join(", ");

  // Halt/kick-back is available from any stage that isn't already parked.
  // `failed`/`on_hold` stay haltable to recover them; `published`/`scheduled`
  // stay haltable too (2026-07-16) so a video that was uploaded but never truly
  // went public — or that you want to pull back — is never stuck with no way
  // back (the halt panel warns to handle the YouTube video manually). Only the
  // already-parked `halted`/`rejected` states hide it.
  const HALT_HIDDEN = new Set(["halted", "rejected"]);
  const canHalt = !HALT_HIDDEN.has(production.status);
  const uploadedVideo = pubs[0]?.providerVideoId
    ? { id: pubs[0].providerVideoId, url: pubs[0].url ?? null }
    : null;
  const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? "" : "s"}`;
  const haltArtifacts: { key: HaltDiscard; label: string; detail: string }[] = [];
  if (latestDraft) haltArtifacts.push({ key: "script", label: "script", detail: plural(drafts.length, "draft") });
  if (voiceover) haltArtifacts.push({ key: "voiceover", label: "voiceover", detail: "generated narration audio" });
  if (images.length) haltArtifacts.push({ key: "images", label: "beat visuals", detail: plural(images.length, "image") });
  if (render) haltArtifacts.push({ key: "render", label: "rendered video", detail: "the assembled short" });
  if (thumbs.length) haltArtifacts.push({ key: "thumbnails", label: "thumbnails", detail: plural(thumbs.length, "candidate") });

  return (
    <div>
      <Link href="/gates" className="backlink">
        <IconChevronLeft /> Review
      </Link>
      <div className="page-head" style={{ marginBottom: 14 }}>
        <div>
          <h1 className="page-title">{idea?.title ?? "Production"}</h1>
          <p className="page-sub">{channel?.name}</p>
        </div>
      </div>
      {renderStale && (
        <StaleRenderBanner
          productionId={production.id}
          missingClips={missingClipCount}
          removedClips={removedClipCount}
          missingMusic={missingMusic}
        />
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        <StatusBadge status={production.status} />
        {production.revisionCount > 0 && <span className="chip">Revision {production.revisionCount}</span>}
        <ProductionMetaBar
          script={
            latestDraft
              ? {
                  version: latestDraft.version,
                  beats: (latestDraft.beats as { type: string; text: string; estSec?: number | null }[]).map((b) => ({
                    type: b.type,
                    text: b.text,
                    estSec: b.estSec ?? null,
                  })),
                  wordCount: latestDraft.wordCount,
                }
              : null
          }
          costs={costs.map((c) => ({
            id: c.id,
            category: c.category,
            provider: c.provider,
            model: c.model,
            costAud: Number(c.costUsd) * fx.rateFor(c.createdAt),
          }))}
          total={totalCostAud}
          totalUsd={totalCost}
          gates={gates.map((g) => ({
            id: g.id,
            kind: g.kind,
            status: g.status,
            decision: g.decision ?? null,
            notes: g.notes ?? null,
            decidedAt: g.decidedAt ? new Date(g.decidedAt).toISOString() : null,
          }))}
        />
        {canHalt && (
          <span style={{ marginLeft: "auto" }}>
            <HaltPanel productionId={production.id} artifacts={haltArtifacts} uploaded={uploadedVideo} />
          </span>
        )}
      </div>

      <ProductionStepper
        steps={buildProductionSteps({
          status: production.status,
          failureReason: production.failureReason,
          draftCount: drafts.length,
          hasVoiceover: Boolean(voiceover),
          imageCount: images.length,
          hasRender: Boolean(render),
          scheduledFor: pubs[0]?.scheduledFor ?? null,
          publishedAt: pubs[0]?.publishedAt ?? null,
          isCorrectedCopy: Boolean(
            (production as { supersedesProductionId?: string | null }).supersedesProductionId,
          ),
        })}
      />

      {/* TEMP pipeline diagnostics (2026-07-19): a corrected copy still lands on
          the script gate in prod despite the skip. This surfaces the decisive
          row state so one screenshot gives ground truth. Shown open for a
          corrected copy, collapsed otherwise. Remove once the copy flow is
          confirmed working. */}
      <details
        open
        style={{ margin: "0 0 14px", fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--muted, #888)" }}
      >
        <summary style={{ cursor: "pointer", opacity: 0.8 }}>Pipeline diagnostics</summary>
        <div style={{ padding: "8px 4px 2px", lineHeight: 1.7, wordBreak: "break-all" }}>
          <div style={{ fontWeight: 700 }}>
            FLOW:{" "}
            {(production as { supersedesProductionId?: string | null }).supersedesProductionId
              ? "CORRECTED COPY (skips script/profile/visuals-director, no Sonnet)"
              : ["published", "scheduled"].includes(production.status)
                ? "PUBLISHED ORIGINAL — the source video; not running anything. Click “Fix a few things” to make a corrected copy."
                : (voiceover || images.length > 0)
                  ? "RESUME / re-run (copied media but NOT a corrected copy → full pipeline, fires Sonnet)"
                  : "FRESH production"}
          </div>
          <div>prodId: {production.id}</div>
          <div>
            corrected-copy (supersedes):{" "}
            {(production as { supersedesProductionId?: string | null }).supersedesProductionId ?? "— none —"}
          </div>
          <div>
            carried productionProfile:{" "}
            {(production as { productionProfile?: unknown }).productionProfile ? "yes (skips profile Sonnet)" : "— none (fires profile Sonnet) —"}
          </div>
          <div>status: {production.status}</div>
          <div>
            pipeline ran (inngestRunId):{" "}
            {(production as { inngestRunId?: string | null }).inngestRunId ?? "— never fired —"}
          </div>
          <div>
            script drafts: {drafts.length > 0 ? `v${drafts.map((d) => d.version).join(", v")}` : "— none —"}
            {latestDraft
              ? ` · directedSequence: ${
                  Array.isArray((latestDraft as { directedSequence?: unknown[] | null }).directedSequence)
                    ? `${(latestDraft as { directedSequence?: unknown[] }).directedSequence!.length} shots`
                    : "— missing —"
                }`
              : ""}
          </div>
          <div>
            pending gate: {pendingGate ? `${pendingGate.kind} (created ${fmtDateTime(pendingGate.createdAt)})` : "— none —"}
          </div>
          <div>
            copied media: {images.length} images · {clips.length} clips · voiceover {voiceover ? "yes" : "no"} · render{" "}
            {render ? "yes" : "no"}
          </div>
          <div>production created: {fmtDateTime(production.createdAt)}</div>
        </div>
      </details>

      {production.failureReason && (
        <div className="callout warn" style={{ marginTop: 0 }}>
          <IconAlertTriangle />
          <span>{production.failureReason}</span>
        </div>
      )}

      {/* #25: per-stage retry — resume from a chosen stage instead of a full
          restart. Also offered at the final gate (2026-07-12): after swapping
          shot images, "Retry from render" rebuilds the video with the new set. */}
      {["failed", "on_hold", "thumbnail_review"].includes(production.status) && (
        <RetryStagePanel productionId={production.id} />
      )}

      {/* Published/scheduled videos are locked (YouTube can't replace the file);
          "Make a corrected copy" is the way back in — a fresh editable re-cut
          that publishes anew (2026-07-19 operator: a published short shipped a
          stray real clip with no way to fix the shots). */}
      {["published", "scheduled"].includes(production.status) && latestDraft && (
        <CorrectedCopyPanel productionId={production.id} />
      )}

      {production.status === "halted" && latestDraft && (
        <div className="callout" style={{ marginTop: 0 }}>
          <IconRefresh />
          <div>
            <strong>Resume this production</strong>
            <p className="muted" style={{ margin: "4px 0 10px", fontSize: 12.5 }}>
              Reuses the kept script and regenerates voiceover, images and render on a fresh
              production. The script review is skipped.
            </p>
            <form action={resumeProductionAction.bind(null, production.id)}>
              <button type="submit" className="btn">
                <IconRefresh /> Resume — reuse script
              </button>
            </form>
          </div>
        </div>
      )}

      {["on_hold", "failed", "rejected"].includes(production.status) && latestDraft && (
        <div className="callout warn" style={{ marginTop: 0 }}>
          <IconZap />
          <div>
            <strong>Force this forward</strong>
            <p className="muted" style={{ margin: "4px 0 10px", fontSize: 12.5 }}>
              This production is blocked. Force-forward waives the failed soft checks (variation +
              review board) and resumes this production from where it stopped — the existing
              script, voiceover, images and render are reused, and only missing assets are
              generated. Use only after you&apos;ve reviewed the flag yourself; the override is
              logged for the compliance trail.
            </p>
            <form action={forceForwardAction.bind(null, production.id)}>
              <button type="submit" className="btn warn">
                <IconZap /> Force forward — override checks
              </button>
            </form>
          </div>
        </div>
      )}

      {/* #27: voice source — decide BEFORE assets are produced */}
      {!voiceover &&
        ["proposed", "scored", "greenlit", "scripting", "script_review", "profile_review"].includes(
          production.status,
        ) && (
          <div className="panel" style={{ marginBottom: 14 }}>
            <div className="panel-body" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <strong style={{ fontSize: 13 }}>Voiceover</strong>
              <span className="muted" style={{ fontSize: 12.5 }}>
                {production.voiceSource === "operator"
                  ? "You'll record per-beat takes after script approval; unrecorded beats are TTS-filled."
                  : "Narrated by the channel voice (TTS)."}
              </span>
              <form
                action={setVoiceSourceAction.bind(
                  null,
                  production.id,
                  production.voiceSource === "operator" ? "tts" : "operator",
                )}
                style={{ marginLeft: "auto" }}
              >
                <button type="submit" className="btn ghost sm">
                  {production.voiceSource === "operator" ? "Switch to TTS" : "Record my own voice"}
                </button>
              </form>
            </div>
          </div>
        )}

      {/* Direct script editing at the review gate — edit each segment yourself
          instead of only asking the LLM (2026-07-19 operator ask). */}
      {pendingGate?.kind === "script_review" && latestDraft && (
        <ScriptEditor
          productionId={production.id}
          beats={(latestDraft.beats as { type: string; text: string; estSec?: number | null }[]).map((b) => ({
            type: b.type,
            text: b.text,
            estSec: b.estSec ?? null,
          }))}
        />
      )}

      {pendingGate && (
        <GatePanel
          gateId={pendingGate.id}
          kind={pendingGate.kind}
          snapshot={pendingGate.payloadSnapshot ?? {}}
          productionId={production.id}
          renderStale={
            !!render &&
            // clips included (2026-07-14): the render prefers a same-idx clip,
            // so one animated AFTER the render is just as stale as a swap
            [...images, ...clips].some(
              (a) => new Date(a.updatedAt).getTime() > new Date(render.createdAt).getTime() + 1000,
            )
          }
          thumbnailCandidates={thumbs.map((t) => ({
            id: t.id,
            storageKey: t.storageKey,
            predictedCtr: t.predictedCtr,
          }))}
          thumbReferences={thumbReferences}
          thumbTitleAuto={idea ? autoTitleWords(idea.title) : ""}
          thumbTitle={idea?.title ?? ""}
          thumbIsLong={channel?.contentFormat === "long"}
          thumbStyleBlock={thumbStyleBlock}
          thumbImageStyle={thumbDna[0]?.visualStyle?.imageStyle ?? null}
        />
      )}

      {/* #27: the per-beat recording booth, live while the recording gate pends */}
      {pendingGate?.kind === "voiceover_recording" && latestDraft && (
        <VoiceoverRecorder
          productionId={production.id}
          beats={(latestDraft.beats as { text: string }[]).map((b, i) => ({ idx: i, text: b.text }))}
          takes={voTakes.map((t) => ({ idx: t.idx, storageKey: t.storageKey }))}
        />
      )}

      <div>
        <div>
          {(render || voiceover) && (
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start", marginBottom: 8 }}>
              {render && (
                <div>
                  <h2 style={{ marginTop: 0 }}>Rendered short</h2>
                  {/* cache-bust by updatedAt: final.mp4 is a DETERMINISTIC key,
                      so a re-render reuses the URL and the browser would serve
                      the stale cached video (max-age=3600) — 2026-07-17. */}
                  <video className="preview" controls src={`/api/media/${render.storageKey}?v=${new Date(render.updatedAt).getTime()}`} />
                </div>
              )}
              {voiceover && (
                <div style={{ flex: 1, minWidth: 280 }}>
                  <h2 style={{ marginTop: 0 }}>Voiceover</h2>
                  {(voiceover.meta as { source?: string } | null)?.source === "operator" && (
                    <p className="muted" style={{ margin: "0 0 6px", fontSize: 12.5 }}>
                      Assembled from your recorded takes (TTS-filled where unrecorded).
                    </p>
                  )}
                  <audio controls src={`/api/media/${voiceover.storageKey}`} style={{ width: "100%" }} />
                  <div style={{ marginTop: 6 }}>
                    <a className="btn ghost sm" href={`/api/media/${voiceover.storageKey}`} download="voiceover.mp3">
                      Download voiceover
                    </a>
                  </div>
                </div>
              )}
            </div>
          )}
          {voTakes.length > 0 && (
            <>
              <h2>Your recorded takes</h2>
              <p className="muted" style={{ margin: "0 0 8px", fontSize: 12.5 }}>
                Kept permanently — clean per-beat samples are ideal ElevenLabs voice-clone material.
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {voTakes.map((t) => (
                  <a
                    key={t.id}
                    className="btn ghost sm"
                    href={`/api/media/${t.storageKey}`}
                    download={`beat-${t.idx + 1}${t.storageKey.slice(t.storageKey.lastIndexOf("."))}`}
                  >
                    Beat {t.idx + 1}
                  </a>
                ))}
              </div>
            </>
          )}
          {images.length > 0 && (
            <>
              <h2>Beat visuals</h2>
              <p className="muted" style={{ margin: "0 0 8px", fontSize: 12.5 }}>
                Visuals: {realImageCount} real (archival) / {generatedImageCount} generated
                {clips.length > 0 ? ` · ${clips.length} with video` : ""}
              </p>
              {generatedImageCount > 0 && (
                <p className="muted" style={{ margin: "0 0 8px", fontSize: 12.5 }}>
                  {styleVersionUsed
                    ? `Style guide v${styleVersionUsed}${styleConditionedCount > 0 ? ` · ${styleConditionedCount} shot${styleConditionedCount === 1 ? "" : "s"} conditioned on your example images` : " (distilled look in every prompt)"}`
                    : "No active style guide — these ran on the plain channel image style. Activate a version on the channel's Style tab, then re-render."}
                  {castSummary ? ` · characters: ${castSummary}` : ""}
                </p>
              )}
              {/* 2026-07-15: at the visuals gate, rebuild the WHOLE set after
                  activating a style / adding a character (halt+resume reused
                  the old images, dead-ending the operator) */}
              {production.status === "visuals_review" && generatedImageCount > 0 && (
                <RegenerateVisuals productionId={production.id} />
              )}
              <VisualsGrid
                productionId={production.id}
                characters={characters.map((c) => ({ id: c.id, name: c.name }))}
                items={images.map((img) => {
                  const m = (img.meta ?? {}) as Record<string, unknown>;
                  const clip = clipByIdx.get(img.idx);
                  const shotSec = shotSecByIdx.get(img.idx) ?? null;
                  return {
                    id: img.id,
                    idx: img.idx,
                    storageKey: img.storageKey,
                    // cache-bust stamps: image + clip keys are DETERMINISTIC and
                    // get overwritten in place on regen/re-animate, so the media
                    // route's max-age would otherwise serve the stale asset.
                    storageVer: new Date(img.updatedAt).getTime(),
                    clipVer: clip ? new Date(clip.updatedAt).getTime() : null,
                    source: typeof m.source === "string" ? m.source : null,
                    entity: typeof m.entity === "string" ? m.entity : null,
                    license: typeof m.license === "string" ? m.license : null,
                    prompt: typeof m.prompt === "string" ? m.prompt : null,
                    // live shot text wins over the stamped copy so edits show
                    narration: shotTextByIdx.get(img.idx) ?? (typeof m.narration === "string" ? m.narration : null),
                    character: typeof m.character === "string" ? m.character : null,
                    characterId: typeof m.characterId === "string" ? m.characterId : null,
                    hero: m.hero === true,
                    shotScale: typeof m.shotScale === "string" ? m.shotScale : null,
                    directorIntent: typeof m.directorIntent === "string" ? m.directorIntent : null,
                    // engine transparency (2026-07-16): the model actually served
                    // + whether that was a silent fallback from what was requested
                    engineServed: typeof m.engineServed === "string" ? m.engineServed : null,
                    engineFallback: imageEngineFellBack(
                      typeof m.engineRequested === "string" ? m.engineRequested : null,
                      typeof m.engineServed === "string" ? m.engineServed : null,
                    ),
                    // only generated shots (no archival source) can have a thin prompt
                    promptThin:
                      !(typeof m.source === "string" && m.source) &&
                      isThinPromptText(typeof m.prompt === "string" ? m.prompt : null),
                    clipKey: clip?.storageKey ?? null,
                    shotSec,
                    clipEstUsd:
                      shotPlan && shotSec !== null
                        ? Math.round(Math.min(shotSec + 0.4, maxClipSec) * CLIP_PRICE_PER_SEC[shotPlan.engine] * 100) / 100
                        : null,
                    // Animate gating (2026-07-15): only HARD-block when there's
                    // no timed voiceover to size a clip against — the worker
                    // re-derives shot timing authoritatively and rejects a
                    // genuinely-too-long shot into the ledger, so an idx/plan
                    // mismatch or an over-cap estimate is advisory, not a hide.
                    animateHardBlock:
                      shotPlan === null ? "Add a voiceover first — clips are timed to the narration." : null,
                    animateWarn:
                      shotSec !== null && shotSec > maxClipSec + 0.5
                        ? `~${Math.round(shotSec)}s shot — the clip caps at ${maxClipSec}s, so the tail may hold the last frame.`
                        : null,
                    dupGroup: dupGroupFor(img),
                  };
                })}
              />
              {clips.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>
                    Video clips · {clips.length} shot{clips.length === 1 ? "" : "s"} — used instead of the still at render
                  </h3>
                  <div className="beats">
                    {clips
                      .slice()
                      .sort((a, b) => a.idx - b.idx)
                      .map((c) => (
                        // eslint-disable-next-line jsx-a11y/media-has-caption
                        <video
                          key={c.id}
                          src={`/api/media/${c.storageKey}?v=${new Date(c.updatedAt).getTime()}`}
                          muted
                          controls
                          preload="metadata"
                          style={{ width: 160, borderRadius: 8, border: "1px solid var(--border)" }}
                        />
                      ))}
                  </div>
                </div>
              )}
              {imageCredits.length > 0 && (
                <div className="card" style={{ marginTop: 10 }}>
                  <strong style={{ fontSize: 13 }}>Media credits</strong>
                  <p className="muted" style={{ margin: "2px 0 8px", fontSize: 12 }}>
                    Real licensed images &amp; footage — credited in the video description.
                  </p>
                  {imageCredits.map((c, i) => (
                    <div key={i} className="muted" style={{ fontSize: 12, marginBottom: 3 }}>
                      {c.entity ? <strong>{c.entity}</strong> : null}
                      {c.entity ? " — " : ""}
                      {c.attribution ? `${c.attribution}, ` : ""}
                      {c.license} ·{" "}
                      <a href={c.source} style={{ color: "var(--accent-ink)" }}>
                        source
                      </a>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          <AudioLevelsPanel
            productionId={production.id}
            initialVoice={production.voiceVolume ?? 1}
            initialMusic={
              production.musicVolume ??
              (musicProfile.music !== "off"
                ? MUSIC_VOLUMES[musicProfile.music] ?? 0
                : MUSIC_VOLUMES.standard)
            }
            hasRender={!!render}
          />
          <MusicPanel
            productionId={production.id}
            musicLevel={musicProfile.music}
            defaultMood={musicProfile.musicMood ?? null}
            tracks={musicTracks.map((t) => ({
              id: t.id,
              storageKey: t.storageKey,
              name: t.name,
              mood: t.mood,
              engine: t.engine,
              durationSec: t.durationSec,
              selected: t.selected,
            }))}
            library={musicLibrary}
            channelId={production.channelId}
            bedTarget={CHANNEL_BED_TARGET}
            bed={channelBed.map((t) => ({
              id: t.id,
              storageKey: t.storageKey,
              name: t.name,
              mood: t.mood,
              source: t.source,
              license: t.license,
              durationSec: t.durationSec,
              lastUsedAt: t.lastUsedAt ? t.lastUsedAt.toISOString() : null,
            }))}
          />
          {pubs.length > 0 && pubs.some((p) => p.providerVideoId) && (
            <ThumbnailGallery
              productionId={production.id}
              channelId={production.channelId}
              candidates={thumbs.map((t) => ({
                id: t.id,
                storageKey: t.storageKey,
                predictedCtr: t.predictedCtr,
                selected: t.selected,
                applyError: typeof t.meta?.applyError === "string" ? t.meta.applyError : null,
              }))}
            />
          )}
          {pubs.length > 0 && (
            <>
              <h2>Publication</h2>
              {pubs.map((p) => (
                <div className="card" key={p.id}>
                  {p.url ? (
                    <a href={p.url} style={{ color: "var(--accent-ink)", fontWeight: 600 }}>
                      {p.url}
                    </a>
                  ) : (
                    <span className="muted" style={{ fontWeight: 600 }}>Scheduled — not yet uploaded</span>
                  )}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
                    <span
                      className={`chip ${p.privacyStatus === "public" ? "good" : p.privacyStatus === "scheduled" ? "acc" : "warn"}`}
                    >
                      <span className="d" />
                      {p.privacyStatus === "public"
                        ? "Public"
                        : p.privacyStatus === "scheduled"
                          ? "Scheduled — goes public automatically"
                          : "Private"}
                    </span>
                    {p.aiDisclosure && <span className="chip">AI disclosure on</span>}
                    {p.publishedAt && <span className="chip">Published {fmtDateTime(p.publishedAt)}</span>}
                    {p.scheduledFor && <span className="chip acc">Scheduled {fmtDateTime(p.scheduledFor)}</span>}
                  </div>
                  {latestSnap && (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
                      <span className="chip acc">{latestSnap.views} views</span>
                      {latestSnap.avgViewPct !== null && (
                        <span className="chip">{latestSnap.avgViewPct.toFixed(0)}% retention</span>
                      )}
                      {latestSnap.ctr !== null && <span className="chip">{latestSnap.ctr}% CTR</span>}
                      <span className="muted" style={{ fontSize: 12 }}>
                        as of {fmtDateTime(latestSnap.capturedAt)}
                      </span>
                    </div>
                  )}
                  {p.privacyStatus !== "public" && p.providerVideoId && (
                    <PublishControls publicationId={p.id} privacyStatus={p.privacyStatus} />
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
