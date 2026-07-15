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
  productions,
  publications,
  reviewGates,
  scriptDrafts,
  styleTestScenes,
  thumbnails,
  visualStyles,
} from "@ytauto/db";
import { styleBlockForImagePrompts } from "@ytauto/core";
import { getAppContext } from "@/lib/context";
import { CLIP_PRICE_PER_SEC, deriveShotPlan } from "@/lib/shot-plan";
import { autoTitleWords } from "./thumbnail-compose";
import { forceForwardAction, resumeProductionAction, setVoiceSourceAction } from "../../actions";
import { GatePanel } from "./gate-panel";
import { VoiceoverRecorder } from "./voiceover-recorder";
import { HaltPanel } from "./halt-panel";
import { PublishControls } from "./publish-controls";
import { RetryStagePanel } from "./retry-stage";
import { VisualsGrid } from "./visuals-grid";
import { RegenerateVisuals } from "./regenerate-visuals";
import { ThumbnailGallery } from "./thumbnail-gallery";
import { StatusBadge, ZoomImage } from "@/components/ui";
import { ProductionStepper, buildProductionSteps } from "@/components/production-stepper";
import type { HaltDiscard } from "../../actions";
import { IconAlertTriangle, IconChevronLeft, IconRefresh, IconUpload, IconZap } from "@/components/icons";
import {
  costCategoryLabel,
  fmtDateTime,
  fmtDuration,
  fmtMoney,
  gateDecisionLabel,
  gateKindLabel,
} from "@/lib/format";

export const dynamic = "force-dynamic";

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
  const totalCost = costs.reduce((sum, c) => sum + Number(c.costUsd), 0);
  const pendingGate = gates.find((g) => g.status === "pending");
  const render = productionAssets.find((a) => a.kind === "render");
  const voiceover = productionAssets.find((a) => a.kind === "voiceover");
  // #27: operator-recorded per-beat takes (permanent — voice-clone material)
  const voTakes = productionAssets.filter((a) => a.kind === "voiceover_take");
  const images = productionAssets.filter((a) => a.kind === "image");
  const clips = productionAssets.filter((a) => a.kind === "video_clip");
  const clipByIdx = new Map(clips.map((c) => [c.idx, c]));
  // shot timing for the Animate control (2026-07-14): same deterministic
  // derivation the pipeline used; null until a voiceover exists
  const shotPlan = await deriveShotPlan(db, id);
  const shotSecByIdx = new Map<number, number>((shotPlan?.shots ?? []).map((s, i) => [i, s.endSec - s.startSec]));
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

  // Halt is available from any stage that isn't already terminal. `failed` and
  // `on_hold` stay haltable on purpose — that's how you recover them.
  const HALT_HIDDEN = new Set(["published", "halted", "rejected"]);
  const canHalt = !HALT_HIDDEN.has(production.status);
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
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        <StatusBadge status={production.status} />
        <span className="chip">Cost so far {fmtMoney(totalCost)}</span>
        {production.revisionCount > 0 && <span className="chip">Revision {production.revisionCount}</span>}
        {canHalt && (
          <span style={{ marginLeft: "auto" }}>
            <HaltPanel productionId={production.id} artifacts={haltArtifacts} />
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
        })}
      />

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

      <div
        className={render || voiceover || images.length > 0 || pubs.length > 0 ? "grid-2 grid" : undefined}
      >
        <div>
          {render && (
            <>
              <h2>Rendered short</h2>
              <video className="preview" controls src={`/api/media/${render.storageKey}`} />
            </>
          )}
          {voiceover && (
            <>
              <h2>Voiceover</h2>
              {(voiceover.meta as { source?: string } | null)?.source === "operator" && (
                <p className="muted" style={{ margin: "0 0 6px", fontSize: 12.5 }}>
                  Assembled from your recorded takes (TTS-filled where unrecorded).
                </p>
              )}
              <audio controls src={`/api/media/${voiceover.storageKey}`} />
              <div style={{ marginTop: 6 }}>
                <a className="btn ghost sm" href={`/api/media/${voiceover.storageKey}`} download="voiceover.mp3">
                  Download voiceover
                </a>
              </div>
            </>
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
                    source: typeof m.source === "string" ? m.source : null,
                    entity: typeof m.entity === "string" ? m.entity : null,
                    license: typeof m.license === "string" ? m.license : null,
                    prompt: typeof m.prompt === "string" ? m.prompt : null,
                    narration: typeof m.narration === "string" ? m.narration : null,
                    character: typeof m.character === "string" ? m.character : null,
                    characterId: typeof m.characterId === "string" ? m.characterId : null,
                    hero: m.hero === true,
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
                          src={`/api/media/${c.storageKey}`}
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

        <div>
          {latestDraft && (
            <>
              <h2>
                Script <span className="muted">v{latestDraft.version}</span>
              </h2>
              <div className="card">
                {latestDraft.beats.map((b, i) => (
                  <p key={i} style={{ margin: "0 0 10px" }}>
                    <span className="chip" style={{ marginRight: 7 }}>
                      {b.type === "cta" ? "CTA" : b.type.charAt(0).toUpperCase() + b.type.slice(1)}
                    </span>
                    {b.text}
                    {typeof b.estSec === "number" && (
                      <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>
                        ~{b.estSec}s
                      </span>
                    )}
                  </p>
                ))}
                <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                  {latestDraft.wordCount} words · ~{fmtDuration(Math.round(latestDraft.wordCount / 2.5))} of narration (est.)
                </p>
              </div>
            </>
          )}

          <h2>Review history</h2>
          <div className="tablewrap">
            <table className="data">
              <tbody>
                {gates.map((g) => (
                  <tr key={g.id}>
                    <td>{gateKindLabel(g.kind)}</td>
                    <td>
                      {g.status === "pending" ? (
                        <span className="chip warn">Pending</span>
                      ) : (
                        <span
                          className={`chip ${g.decision === "approved" ? "good" : g.decision === "rejected" ? "crit" : "warn"}`}
                        >
                          {g.decision ? gateDecisionLabel(g.decision) : "—"}
                        </span>
                      )}
                      {g.notes && <div className="muted" style={{ marginTop: 4 }}>“{g.notes}”</div>}
                    </td>
                    <td className="muted" style={{ whiteSpace: "nowrap" }}>
                      {g.decidedAt ? fmtDateTime(g.decidedAt) : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2>Cost breakdown</h2>
          <div className="tablewrap">
            <table className="data">
              <tbody>
                {costs.map((c) => (
                  <tr key={c.id}>
                    <td>{costCategoryLabel(c.category)}</td>
                    <td className="muted">
                      {c.provider}
                      {c.model ? ` · ${c.model}` : ""}
                    </td>
                    <td className="r">{fmtMoney(Number(c.costUsd))}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={2}>
                    <strong>Total</strong>
                  </td>
                  <td className="r">
                    <strong>{fmtMoney(totalCost)}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
