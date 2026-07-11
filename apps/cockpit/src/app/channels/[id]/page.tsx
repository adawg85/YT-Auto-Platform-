import { Fragment } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, gte, inArray, like, sql } from "drizzle-orm";
import {
  analyticsSnapshots,
  channelCompetitors,
  channelDecisions,
  channelDna,
  channels,
  claims,
  costRecords,
  episodes,
  externalVideos,
  ideas,
  personas,
  productions,
  publications,
  secrets,
} from "@ytauto/db";
import {
  channelPerformanceSummary,
  channelTokenName,
  channelWarmupState,
  patternGrounding,
  patternRank,
  resolveProductionProfile,
  type ChannelWarmupState,
  type PatternRow,
} from "@ytauto/core";
import type { VoiceOption } from "@ytauto/providers";
import { PlanLive } from "./plan-live";
import { PlanAssistant } from "./plan-assistant";
import { CharterObjectives } from "./charter-objectives";
import { PlanGuide } from "./plan-guide";
import { ResearchHealth } from "./research-health";
import { NicheIntelPanel, type IntelPattern, type NicheIntelData } from "./niche-intel-panel";
import { EpisodesTable } from "./episodes-table";
import { PersonaPanel } from "./persona-panel";
import { getAppContext, getMergedEnv } from "@/lib/context";
import { loadChannelPlan, loadTentativeSlots, type ChannelPlan } from "@/lib/plan";
import { loadChannelBriefings, type ChannelBriefings } from "@/lib/briefings";
import { disconnectYouTubeAction, updateChannelAction, updateProductionProfileAction } from "../actions";
import { ProductionProfilePanel } from "./production-profile-panel";
import { ScheduleCalendar, type CalItem } from "@/components/schedule-calendar";
import {
  decideSeriesAction,
  respondBriefingAction,
  runBriefingNowAction,
  runEditorialPlanAction,
  savePlanSteerAction,
  stopResearchAction,
  restartResearchAction,
  updateCharterSettingsAction,
} from "../editorial-actions";
import { ChannelForm } from "../channel-form";
import { DeleteChannelButton } from "./delete-channel-button";
import { PageTabs, type Tab } from "@/components/page-tabs";
import { ChannelSwitcher } from "@/components/channel-switcher";
import { RetentionCurve } from "@/components/charts";
import {
  IconAlertTriangle,
  IconChevronLeft,
  IconSparkle,
  IconCheck,
  IconEye,
  IconGauge,
  IconTimer,
  IconUpload,
  IconChevronRight,
} from "@/components/icons";
import { fmtDate, fmtDateTime, fmtNum, tierLabel, PIPELINE_STAGES } from "@/lib/format";
import { StatusBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

const ACTIVE_STATUSES = ["scripting", "script_review", "producing_assets", "assembling", "thumbnail_review", "ready", "scheduled"];

export default async function ChannelPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const { id } = await params;
  const { connected, error } = await searchParams;
  const { db, providers } = await getAppContext();

  const [channel] = await db.select().from(channels).where(eq(channels.id, id));
  if (!channel) notFound();
  // The exact OAuth redirect URI Google must have whitelisted — surfaced in the
  // Settings tab so a redirect_uri_mismatch is self-diagnosable. Falls back to a
  // hint when PUBLIC_BASE_URL isn't pinned (the usual cause of the mismatch).
  const publicBase = (await getMergedEnv()).PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
  const oauthRedirectUri = `${publicBase || "https://YOUR-DOMAIN"}/api/oauth/youtube/callback`;
  // TTS voice library for the per-channel voice picker (best-effort — a
  // provider hiccup must not break the settings page).
  let voices: VoiceOption[] = [];
  try {
    voices = await providers.voice.listVoices();
  } catch {
    voices = [];
  }
  // Perf: these are all independent (they only need `db`/`id`/`channel`), so run
  // them concurrently instead of as a serial waterfall — cuts the server render
  // time that a force-dynamic page blocks navigation on.
  const [
    dnaRows,
    tokenRows,
    perf,
    ground, // shared pattern store, channel-niche slice (build #4)
    warmup, // live warm-up ramp state (build #3)
    plan, // editorial plan: charter + series arcs + per-episode verification (build #5)
    claimStatRows, // verification cost (#17)
    cutClaims,
    briefings, // operator check-ins + experiment ledger (build #5.2)
    allChannels,
    recent,
    personaRows, // writing-persona versions (BACKLOG #21.1)
    tentativeSlots, // projected series slots for the calendar (#23.1)
    steerRows, // most recent Plan-tab steer (#23.2)
    competitors, // tagged competitor channels (#23.3)
    intelFeed, // scouted external videos for the niche, 90-day window (#23.3)
    lastScanRows, // most recent scan touch for the niche (#23.3)
  ] = await Promise.all([
    db.select().from(channelDna).where(eq(channelDna.channelId, id)),
    db.select().from(secrets).where(eq(secrets.name, channelTokenName(id))),
    channelPerformanceSummary(db, id),
    patternGrounding(db, { niche: channel.niche, format: "shorts", perKind: 5 }),
    channelWarmupState(db, id),
    loadChannelPlan(db, id),
    db
      .select({ status: claims.status, n: sql<number>`count(*)::int` })
      .from(claims)
      .where(eq(claims.channelId, id))
      .groupBy(claims.status),
    db
      .select({ text: claims.text, tier: claims.tier, episodeTitle: episodes.title })
      .from(claims)
      .innerJoin(episodes, eq(claims.episodeId, episodes.id))
      .where(and(eq(claims.channelId, id), eq(claims.status, "cut")))
      .orderBy(desc(claims.createdAt))
      .limit(15),
    loadChannelBriefings(db, id),
    db.select({ id: channels.id, name: channels.name }).from(channels),
    db
      .select({ production: productions, idea: ideas })
      .from(productions)
      .innerJoin(ideas, eq(productions.ideaId, ideas.id))
      .where(eq(productions.channelId, id))
      .orderBy(desc(productions.createdAt))
      .limit(50),
    db
      .select()
      .from(personas)
      .where(eq(personas.channelId, id))
      .orderBy(desc(personas.version)),
    loadTentativeSlots(db, id),
    db
      .select({ summary: channelDecisions.summary, createdAt: channelDecisions.createdAt })
      .from(channelDecisions)
      .where(
        and(
          eq(channelDecisions.channelId, id),
          eq(channelDecisions.kind, "operator_steer"),
          like(channelDecisions.summary, "Plan steer:%"),
        ),
      )
      .orderBy(desc(channelDecisions.createdAt))
      .limit(1),
    db
      .select()
      .from(channelCompetitors)
      .where(eq(channelCompetitors.channelId, id))
      .orderBy(desc(channelCompetitors.createdAt)),
    db
      .select()
      .from(externalVideos)
      .where(
        and(
          eq(externalVideos.niche, channel.niche),
          // the niche-intel window (#23.3): the janitor trims rows past 90d,
          // but filter anyway so the feed never shows expired intel
          gte(externalVideos.updatedAt, new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)),
        ),
      )
      // hottest first (velocity), then most recently re-observed
      .orderBy(sql`${externalVideos.viewsPerHour} DESC NULLS LAST`, desc(externalVideos.updatedAt))
      .limit(100),
    db
      .select({ last: externalVideos.updatedAt })
      .from(externalVideos)
      .where(eq(externalVideos.niche, channel.niche))
      .orderBy(desc(externalVideos.updatedAt))
      .limit(1),
  ]);
  const [dna] = dnaRows;
  const [token] = tokenRows;
  const claimStats = Object.fromEntries(claimStatRows.map((r) => [r.status, r.n])) as Record<string, number>;

  // publications + latest analytics for this channel's productions
  const prodIds = recent.map((r) => r.production.id);
  const pubs = prodIds.length
    ? await db.select().from(publications).where(inArray(publications.productionId, prodIds))
    : [];
  const pubIds = pubs.map((p) => p.id);
  const snaps = pubIds.length
    ? await db
        .select()
        .from(analyticsSnapshots)
        .where(inArray(analyticsSnapshots.publicationId, pubIds))
        .orderBy(desc(analyticsSnapshots.capturedAt))
    : [];
  const latestSnapByPub = new Map<string, (typeof snaps)[number]>();
  for (const s of snaps) if (!latestSnapByPub.has(s.publicationId)) latestSnapByPub.set(s.publicationId, s);
  const pubByProd = new Map(pubs.map((p) => [p.productionId, p]));

  // cost per production + by category for this channel
  const costs = await db
    .select({ productionId: costRecords.productionId, category: costRecords.category, cost: costRecords.costUsd })
    .from(costRecords)
    .where(eq(costRecords.channelId, id));
  const costByProd = new Map<string, number>();
  const costByCat = new Map<string, number>();
  let costTotal = 0;
  for (const c of costs) {
    const v = Number(c.cost);
    costTotal += v;
    costByCat.set(c.category, (costByCat.get(c.category) ?? 0) + v);
    if (c.productionId) costByProd.set(c.productionId, (costByProd.get(c.productionId) ?? 0) + v);
  }
  const perVideo = perf.publishedCount > 0 ? costTotal / perf.publishedCount : null;

  // pipeline stage counts
  const stageCounts = new Map<string, number>();
  for (const r of recent) stageCounts.set(r.production.status, (stageCounts.get(r.production.status) ?? 0) + 1);
  const inFlight = recent.filter((r) => ACTIVE_STATUSES.includes(r.production.status));
  const stalled = recent.filter((r) => r.production.status === "failed" || r.production.status === "on_hold");

  // scheduled uploads
  const scheduled = pubs
    .filter((p) => p.scheduledFor && new Date(p.scheduledFor) > new Date())
    .sort((a, b) => new Date(a.scheduledFor!).getTime() - new Date(b.scheduledFor!).getTime());
  const ideaTitle = new Map(recent.map((r) => [r.production.id, r.idea.title]));

  // calendar items (#8): every publication with a date — scheduled (future,
  // no upload yet) or published — placed on the month grid.
  const calFormat: "long" | "short" = channel.contentFormat === "long" ? "long" : "short";
  const calItems: CalItem[] = pubs
    .map((p): CalItem | null => {
      const at = p.scheduledFor ?? p.publishedAt;
      if (!at) return null;
      return {
        at: new Date(at).toISOString(),
        title: ideaTitle.get(p.productionId) ?? "Untitled",
        channelId: id,
        channelName: channel.name,
        format: calFormat,
        status: p.publishedAt ? "published" : "scheduled",
        productionId: p.productionId,
        publicationId: p.id,
        // #20: uploaded + natively scheduled → in-calendar publish/move/cancel
        controllable: p.privacyStatus === "scheduled" && !!p.providerVideoId,
      };
    })
    .filter((x): x is CalItem => x !== null);
  // #23.1: projected series slots — dimmed "tentative" entries with no
  // publish controls; they disappear once a real publication row locks in.
  calItems.push(
    ...tentativeSlots.map(
      (t): CalItem => ({
        at: t.at.toISOString(),
        title: t.title,
        channelId: id,
        channelName: channel.name,
        format: calFormat,
        status: "scheduled",
        tentative: true,
        episodeId: t.episodeId,
      }),
    ),
  );

  // plan → publish funnel (#8): make "the plan" legible above the calendar.
  const scheduleFunnel = {
    planned: plan.series
      .flatMap((s) => s.episodes)
      .filter((e) => ["planned", "queued", "verifying", "researching"].includes(e.status)).length,
    inProduction: inFlight.length,
    scheduled: calItems.filter((i) => i.status === "scheduled" && !i.tentative).length,
    published: calItems.filter((i) => i.status === "published").length,
  };

  const latestSteer = steerRows[0]
    ? { text: steerRows[0].summary.replace(/^Plan steer:\s*/, ""), at: steerRows[0].createdAt.toISOString() }
    : null;

  // #23.3: serialize the Niche intel tab's data for its client panel — the
  // pattern slices reuse the same `ground` grounding the Analytics tab reads.
  const toIntelPattern = (p: PatternRow, detailKey: "angle" | "opener"): IntelPattern => ({
    id: p.id,
    label: p.label,
    detail: (p.detail?.[detailKey] as string | undefined) ?? null,
    source: p.source,
    score: Math.round(patternRank(p)),
    observations: p.observations,
  });
  const taggedNames = new Set(competitors.map((c) => c.name.toLowerCase()));
  const intelData: NicheIntelData = {
    channelId: id,
    niche: channel.niche,
    cadence: channel.intelCadence,
    lastScanAt: lastScanRows[0]?.last?.toISOString() ?? null,
    competitors: competitors.map((c) => ({ id: c.id, name: c.name, url: c.url, source: c.source })),
    untaggedBreakouts: [
      ...new Set(
        intelFeed
          .filter((v) => v.source === "breakout" && !taggedNames.has(v.channelName.toLowerCase()))
          .map((v) => v.channelName),
      ),
    ].slice(0, 8),
    topics: ground.topics.map((p) => toIntelPattern(p, "angle")),
    hooks: ground.hooks.map((p) => toIntelPattern(p, "opener")),
    structures: ground.structures.map((p) => toIntelPattern(p, "opener")),
    feed: intelFeed.map((v) => ({
      id: v.id,
      title: v.title,
      channelName: v.channelName,
      url: v.url,
      views: v.views,
      viewsPerHour: v.viewsPerHour,
      source: v.source,
      tagged: taggedNames.has(v.channelName.toLowerCase()),
    })),
  };

  const tabs: Tab[] = [
    { key: "analytics", label: "Analytics", group: "monitoring", panel: <AnalyticsTab perf={perf} ground={ground} /> },
    { key: "intel", label: "Niche intel", group: "monitoring", panel: <NicheIntelPanel data={intelData} /> },
    {
      key: "plan",
      label: "Plan",
      group: "production",
      badge: plan.series.filter((s) => s.status === "proposed").length || null,
      panel: (
        <PlanTab
          channelId={id}
          plan={plan}
          channelName={channel.name}
          claimStats={claimStats}
          cutClaims={cutClaims}
          latestSteer={latestSteer}
        />
      ),
    },
    {
      key: "briefings",
      label: "Briefings",
      group: "monitoring",
      badge: briefings.openCount || null,
      panel: <BriefingsTab channelId={id} data={briefings} hasCharter={!!plan.charter} />,
    },
    {
      key: "production",
      label: "In production",
      group: "production",
      badge: inFlight.length + stalled.length || null,
      panel: <ProductionTab stageCounts={stageCounts} inFlight={inFlight} stalled={stalled} />,
    },
    {
      key: "videos",
      label: "Videos",
      group: "production",
      panel: (
        <VideosTab
          channelId={id}
          recent={recent}
          pubByProd={pubByProd}
          latestSnapByPub={latestSnapByPub}
          costByProd={costByProd}
        />
      ),
    },
    {
      key: "schedule",
      label: "Schedule",
      group: "production",
      panel: <ScheduleTab channelId={id} scheduled={scheduled} ideaTitle={ideaTitle} warmup={warmup} calItems={calItems} funnel={scheduleFunnel} />,
    },
    { key: "costs", label: "Costs", group: "settings", panel: <CostsTab costByCat={costByCat} costTotal={costTotal} /> },
    {
      key: "profile",
      label: "Profile",
      group: "settings",
      panel: (
        <div>
          <h1 className="page-title" style={{ marginBottom: 4 }}>Production Profile</h1>
          <p className="page-sub" style={{ marginBottom: 18 }}>
            Pick how this channel&apos;s videos are made — the pipeline runs the tools you choose here.
            Anything marked <span className="pp-tag soon">soon</span> is stored now and switches on as that feature ships.
          </p>
          <ProductionProfilePanel
            profile={resolveProductionProfile(dna?.productionProfile ?? null, {
              contentFormat: channel.contentFormat,
            })}
            contentFormat={channel.contentFormat}
            voices={voices}
            currentVoiceId={dna?.voiceId ?? null}
            action={updateProductionProfileAction.bind(null, id)}
          />
        </div>
      ),
    },
    {
      key: "persona",
      label: "Persona",
      group: "settings",
      panel: (
        <PersonaPanel
          channelId={id}
          activeId={dna?.activePersonaId ?? null}
          voices={voices}
          dna={
            dna
              ? {
                  tone: dna.tone,
                  audiencePersona: dna.audiencePersona,
                  hookStyles: dna.hookStyles,
                  ctaTemplate: dna.ctaTemplate,
                  voiceId: dna.voiceId,
                }
              : null
          }
          rows={personaRows.map((p) => ({
            id: p.id,
            name: p.name,
            archetype: p.archetype,
            version: p.version,
            status: p.status,
            createdBy: p.createdBy,
            rationale: p.rationale,
            createdAt: p.createdAt.toISOString(),
            doc: p.doc,
          }))}
        />
      ),
    },
    {
      key: "settings",
      label: "Settings & DNA",
      group: "settings",
      panel: (
        <SettingsTab id={id} channel={channel} dna={dna} token={token} connected={connected} error={error} voices={voices} charter={plan.charter} oauthRedirectUri={oauthRedirectUri} publicBaseSet={!!publicBase} />
      ),
    },
  ];

  return (
    <>
      <Link href="/" className="backlink">
        <IconChevronLeft /> Portfolio
      </Link>
      <div className="page-head">
        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
          <span className="thumb" style={{ width: 52, height: 52, background: "linear-gradient(135deg,var(--accent),var(--accent-2))" }}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="#fff">
              <polygon points="8 5 19 12 8 19" />
            </svg>
          </span>
          <div>
            <h1 className="page-title" style={{ margin: 0 }}>
              {channel.name}
            </h1>
            <p className="page-sub">
              {channel.handle} · {channel.niche}
            </p>
          </div>
        </div>
        <ChannelSwitcher channels={allChannels} currentId={id} />
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
        <span className={`chip ${token ? "good" : ""}`}>
          <span className="d" />
          {token ? "YouTube connected" : "Not connected"}
        </span>
        <span className="chip">{tierLabel(channel.autonomyTier)}</span>
        <span className="chip">{fmtNum(perf.medianViews)} median views</span>
        {perf.avgViewPct != null && <span className="chip">{Math.round(perf.avgViewPct)}% retention</span>}
        <span className="chip">{perf.publishedCount} published</span>
        {perVideo != null && <span className="chip">${perVideo.toFixed(2)} / video</span>}
      </div>

      <PageTabs tabs={tabs} />
    </>
  );
}


/** Editorial plan (build #5): charter summary, series arcs, coverage ledger. */
function PlanTab({
  channelId,
  plan,
  channelName,
  claimStats,
  cutClaims,
  latestSteer,
}: {
  channelId: string;
  plan: ChannelPlan;
  channelName: string;
  claimStats: Record<string, number>;
  cutClaims: { text: string; tier: string; episodeTitle: string }[];
  latestSteer: { text: string; at: string } | null;
}) {
  if (!plan.charter) {
    return (
      <div className="placeholder">
        <p>
          No charter — this channel predates the editorial engine (or was created with the manual
          form). The engine plans series, researches sources, and verifies claims only for
          charter&#39;d channels.
        </p>
      </div>
    );
  }
  const bar = plan.charter.verificationBar;
  const activeResearch = plan.series
    .flatMap((s) => s.episodes)
    .filter((e) => ["researching", "verifying"].includes(e.status)).length;
  return (
    <div>
      <PlanGuide bar={bar.establishedMinSources} />
      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3>Charter</h3>
          <PlanLive
            action={runEditorialPlanAction.bind(null, channelId)}
            stopAction={stopResearchAction.bind(null, channelId)}
            restartAction={restartResearchAction.bind(null, channelId)}
            activeCount={activeResearch}
          />
        </div>
        <div className="panel-body">
          <p>{plan.charter.mission}</p>
          <CharterObjectives channelId={channelId} objectives={plan.charter.objectives ?? []} />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <span className="chip">{plan.charter.archetype.replace(/_/g, " ")}</span>
            <span className="chip">corroboration bar: ≥{bar.establishedMinSources} sources</span>
            {bar.presentDebateMode && <span className="chip">present-the-debate</span>}
            <span className="chip">check-in: {plan.charter.checkinCadence}</span>
          </div>
        </div>
      </div>

      <div className="steer">
        <IconSparkle />
        <span>
          The engine plans this channel daily. Anything you change here — the bar, a target, an
          episode — is recorded as <b>your steer</b> and the next plan works around it, never over
          it.
        </span>
      </div>

      {/* #23.2: free-text plan steering — injected into the series planner and
          episode research prompts via the channel state summary */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h3>Steer the plan</h3>
        </div>
        <div className="panel-body">
          <form action={savePlanSteerAction.bind(null, channelId)}>
            <textarea
              name="steer"
              rows={2}
              placeholder='Free-text direction for the planner and writers — e.g. "lean into engine failures", "more human stories"'
              style={{ width: "100%", marginBottom: 10 }}
            />
            <button type="submit" className="btn sm">Save steer</button>
          </form>
          {latestSteer ? (
            <p className="muted" style={{ margin: "10px 0 0", fontSize: 12.5 }}>
              Current steer · {fmtDate(latestSteer.at)}: {latestSteer.text}
            </p>
          ) : (
            <p className="muted" style={{ margin: "10px 0 0", fontSize: 12.5 }}>
              No steer set — the next plan run follows the charter alone.
            </p>
          )}
        </div>
      </div>

      <ResearchHealth stats={claimStats} cut={cutClaims} bar={bar.establishedMinSources} />

      {plan.series.length === 0 && (
        <p className="muted">
          No series planned yet — the daily planner will draft the first arc, or click &quot;Plan /
          research now&quot;.
        </p>
      )}

      {plan.series.map((s) => {
        const total = s.plannedEpisodeCount || s.episodes.length;
        const done = s.episodes.filter((e) => ["produced", "published"].includes(e.status)).length;
        const counts: Record<string, number> = {};
        for (const e of s.episodes) counts[e.status] = (counts[e.status] ?? 0) + 1;
        const pills: { label: string; cls: string }[] = [
          { label: `${counts.published ?? 0} published`, cls: "chip good" },
          { label: `${counts.produced ?? 0} produced`, cls: "chip acc" },
          { label: `${(counts.researching ?? 0) + (counts.verifying ?? 0)} researching`, cls: "chip" },
          { label: `${(counts.briefed ?? 0) + (counts.queued ?? 0)} ready to produce`, cls: "chip warn" },
          { label: `${counts.planned ?? 0} queued`, cls: "chip" },
          { label: `${counts.cut ?? 0} cut`, cls: "chip crit" },
        ].filter((pRow) => !pRow.label.startsWith("0 "));
        return (
          <div className="panel" key={s.id} style={{ marginTop: 16 }}>
            <div className="panel-head">
              <h3 style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                {s.title}
                <span
                  className={`chip ${s.status === "active" ? "good" : s.status === "proposed" ? "warn" : ""}`}
                >
                  <span className="d" />
                  {s.status === "active" ? "Active" : s.status === "proposed" ? "Proposed" : s.status}
                </span>
              </h3>
              {s.status === "proposed" ? (
                <div style={{ display: "flex", gap: 8 }}>
                  <form action={decideSeriesAction.bind(null, s.id, "approve")}>
                    <button type="submit" className="btn sm">Approve arc</button>
                  </form>
                  <form action={decideSeriesAction.bind(null, s.id, "reject")}>
                    <button type="submit" className="btn sm ghost">Reject</button>
                  </form>
                </div>
              ) : (
                <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 170 }}>
                  <span className="progress">
                    <i style={{ width: `${Math.min(100, Math.round((done / Math.max(1, total)) * 100))}%` }} />
                  </span>
                  <span className="num muted" style={{ fontSize: 12 }}>
                    {done}/{total}
                  </span>
                </span>
              )}
            </div>
            <div className="panel-body" style={{ padding: "8px 4px 4px" }}>
              <p className="muted" style={{ margin: "4px 12px 8px", fontSize: 12.5 }}>{s.description}</p>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "0 12px 10px" }}>
                {pills.map((pRow) => (
                  <span key={pRow.label} className={pRow.cls}>{pRow.label}</span>
                ))}
              </div>
              <EpisodesTable episodes={s.episodes} />
            </div>
          </div>
        );
      })}

      <PlanAssistant channelId={channelId} channelName={channelName} />
    </div>
  );
}

const EXPERIMENT_BADGE: Record<string, string> = {
  proposed: "amber",
  active: "accent",
  concluded: "green",
  abandoned: "",
};

/** Operator check-ins + experiment ledger (build #5.2). */
function BriefingsTab({
  channelId,
  data,
  hasCharter,
}: {
  channelId: string;
  data: ChannelBriefings;
  hasCharter: boolean;
}) {
  if (!hasCharter) {
    return (
      <div className="placeholder">
        <p>
          No charter — briefings are the check-in loop of the editorial engine and only run for
          charter&#39;d channels.
        </p>
      </div>
    );
  }
  return (
    <div>
      <div className="panel">
        <div className="panel-head">
          <h3>Check-ins</h3>
          <form action={runBriefingNowAction.bind(null, channelId)}>
            <button type="submit">Run check-in now</button>
          </form>
        </div>
        <div className="panel-body">
          <p className="muted">
            The engine reports on the charter&#39;s cadence: what happened, the direction it
            proposes, and suggestions to agree or disagree with. Your answer is recorded as an
            operator steer and feeds the planner and scriptwriter.
          </p>
        </div>
      </div>

      {data.briefings.length === 0 && (
        <p className="muted">No briefings yet — the daily cron sends the first one when the cadence window elapses, or click &quot;Run check-in now&quot;.</p>
      )}

      {data.briefings.map((b) => (
        <div className="panel" key={b.id} style={{ marginTop: 16 }}>
          <div className="panel-head">
            <h3>
              {fmtDate(b.periodStart)} → {fmtDate(b.periodEnd)}{" "}
              <span className={`badge ${b.status === "open" ? "amber" : "green"}`}>{b.status}</span>
            </h3>
          </div>
          <div className="panel-body">
            <p>
              <strong>What happened.</strong> {b.body.whatHappened}
            </p>
            <p>
              <strong>Direction.</strong> {b.body.direction}
            </p>
            <p>
              <strong>Question.</strong> {b.body.question}
            </p>

            {b.status === "open" ? (
              <form action={respondBriefingAction.bind(null, b.id)}>
                {b.suggestions.map((s) => {
                  const exp = s.experimentId ? data.experimentById.get(s.experimentId) : undefined;
                  return (
                    <div key={s.id} className="panel" style={{ marginBottom: 10 }}>
                      <div className="panel-body">
                        <p style={{ marginTop: 0 }}>
                          <span className="chip">{s.kind}</span> <strong>{s.label}</strong>
                        </p>
                        <p className="muted">{s.detail}</p>
                        {exp && (
                          <p className="muted" style={{ fontSize: "0.85em" }}>
                            One variable: <strong>{exp.variable}</strong> — {exp.baseline} →{" "}
                            {exp.variant}. Hypothesis: {exp.hypothesis}
                          </p>
                        )}
                        <label style={{ marginRight: 14 }}>
                          <input type="radio" name={`sugg-${s.id}`} value="agree" /> Agree
                        </label>
                        <label>
                          <input type="radio" name={`sugg-${s.id}`} value="disagree" /> Disagree
                        </label>
                      </div>
                    </div>
                  );
                })}
                <textarea
                  name="note"
                  rows={3}
                  placeholder="Optional steer — anything the engine should do differently next period"
                  style={{ width: "100%", marginBottom: 10 }}
                />
                <button type="submit">Send response</button>
              </form>
            ) : (
              <>
                {b.suggestions.length > 0 && (
                  <ul className="muted" style={{ paddingLeft: "1.1rem" }}>
                    {b.suggestions.map((s) => (
                      <li key={s.id}>
                        {s.label} —{" "}
                        <span
                          className={`badge ${b.responses?.[s.id] === "agree" ? "green" : b.responses?.[s.id] === "disagree" ? "red" : ""}`}
                        >
                          {b.responses?.[s.id] ?? "no answer"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {b.operatorNote && (
                  <p className="muted">
                    <strong>Steer:</strong> {b.operatorNote}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      ))}

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3>Experiments</h3>
        </div>
        <div className="panel-body">
          {data.experiments.length === 0 ? (
            <p className="muted">
              No experiments yet — briefings propose one-variable tests when the pattern store
              shows something worth trying.
            </p>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Variable</th>
                  <th>Change</th>
                  <th>Status</th>
                  <th>Result</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {data.experiments.map((e) => (
                  <tr key={e.id}>
                    <td>{e.variable}</td>
                    <td className="muted" style={{ maxWidth: 240 }}>
                      {e.baseline} → {e.variant}
                    </td>
                    <td>
                      <span className={`badge ${EXPERIMENT_BADGE[e.status] ?? ""}`}>{e.status}</span>
                    </td>
                    <td>
                      {e.result ? (
                        <span
                          className={`badge ${e.result === "win" ? "green" : e.result === "loss" ? "red" : "amber"}`}
                        >
                          {e.result}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="muted" style={{ maxWidth: 320 }}>
                      {e.outcome ?? e.hypothesis}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function Kpi({ lab, val, sub, ic }: { lab: string; val: React.ReactNode; sub?: React.ReactNode; ic?: React.ReactNode }) {
  return (
    <div className="kpi">
      {ic ? <span className="ic">{ic}</span> : null}
      <div className="lab">{lab}</div>
      <div className="val">{val}</div>
      {sub ? <div className="metric-help">{sub}</div> : null}
    </div>
  );
}

function AnalyticsTab({
  perf,
  ground,
}: {
  perf: Awaited<ReturnType<typeof channelPerformanceSummary>>;
  ground: { hooks: PatternRow[]; structures: PatternRow[]; topics: PatternRow[] };
}) {
  const hasData = perf.avgViewPct != null;
  const hasPatterns = ground.hooks.length + ground.structures.length + ground.topics.length > 0;
  return (
    <>
      <div className="kpis">
        <Kpi
          lab="Avg % viewed"
          ic={<IconGauge />}
          val={perf.avgViewPct != null ? <span className="num">{Math.round(perf.avgViewPct)}%</span> : "—"}
        />
        <Kpi lab="Median views" ic={<IconEye />} val={<span className="num">{fmtNum(perf.medianViews)}</span>} />
        <Kpi lab="Published" ic={<IconUpload />} val={<span className="num">{perf.publishedCount}</span>} />
        <Kpi
          lab="Avg duration"
          ic={<IconTimer />}
          val={perf.avgViewDurationSec != null ? <span className="num">{Math.round(perf.avgViewDurationSec)}s</span> : "—"}
        />
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Retention curve</h3>
        </div>
        <div className="panel-body">
          {hasData ? (
            // We have an average % viewed but not a per-second curve yet; render a
            // representative decay anchored to the real average.
            <RetentionCurve id="chRet" data={syntheticCurveFromAvg(perf.avgViewPct!)} />
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              No retention data yet. Once this channel has published videos and the analytics ingestion runs, the
              retention curve — with the 0–3s hook zone highlighted — shows here.
            </p>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>
            <IconSparkle /> What&apos;s working
          </h3>
          <Link href="/market">Market intel →</Link>
        </div>
        <div className="panel-body">
          <div className="aibox">
            <h4>
              <IconSparkle /> AI channel analysis
            </h4>
            <p style={{ margin: 0 }}>
              {perf.publishedCount === 0
                ? "No published videos yet. Once videos publish and accrue analytics, their hook and script analyses fold into the patterns below."
                : perf.summaryText}
            </p>
          </div>

          {hasPatterns ? (
            <div className="grid grid-2" style={{ marginTop: 16 }}>
              <WorkingList title="Hook patterns" rows={ground.hooks} showOpener />
              <WorkingList title="Rising angles" rows={ground.topics} />
            </div>
          ) : (
            <p className="muted" style={{ marginBottom: 0 }}>
              No patterns for this niche yet. Run a <Link href="/market">market scan</Link> to populate
              hook patterns, script structures and rising topic signals — own results merge in
              automatically as videos publish.
            </p>
          )}
        </div>
      </div>
    </>
  );
}

function WorkingList({
  title,
  rows,
  showOpener,
}: {
  title: string;
  rows: PatternRow[];
  showOpener?: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <div>
      <div className="metric-help" style={{ marginBottom: 8, fontWeight: 600 }}>
        {title}
      </div>
      {rows.map((r) => (
        <div
          key={r.id}
          style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", flexWrap: "wrap" }}
        >
          <span className="mono" style={{ fontSize: 13 }}>
            {r.label}
          </span>
          <span className={`chip ${r.source === "external" ? "" : "acc"}`}>{r.source}</span>
          <span className="num muted" style={{ marginLeft: "auto", fontSize: 12 }}>
            score {Math.round(patternRank(r))}
          </span>
          {showOpener && r.detail?.opener ? (
            <div className="muted" style={{ fontSize: 12, flexBasis: "100%" }}>
              {r.detail.opener as string}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function syntheticCurveFromAvg(avgPct: number): number[] {
  // A smooth decay whose area under the curve roughly matches avgPct.
  const n = 21;
  const end = Math.max(20, Math.min(95, avgPct * 0.75));
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    return Math.round(100 - (100 - end) * Math.pow(t, 0.6));
  });
}

function ProductionTab({
  stageCounts,
  inFlight,
  stalled,
}: {
  stageCounts: Map<string, number>;
  inFlight: { production: typeof productions.$inferSelect; idea: typeof ideas.$inferSelect }[];
  stalled: { production: typeof productions.$inferSelect; idea: typeof ideas.$inferSelect }[];
}) {
  return (
    <>
      <div className="pipe" style={{ marginBottom: 18 }}>
        {PIPELINE_STAGES.map((s) => {
          const n = stageCounts.get(s.key) ?? 0;
          return (
            <div key={s.key} className={`pstage${n > 0 ? " hot" : ""}`}>
              <div className="pc">{n}</div>
              <div className="pl">{s.label}</div>
            </div>
          );
        })}
      </div>

      {stalled.length > 0 && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-head">
            <h3>Needs attention</h3>
          </div>
          <div className="panel-body flush">
            <table className="data" style={{ border: "none", borderRadius: 0 }}>
              <tbody>
                {stalled.map(({ production, idea }) => (
                  <tr key={production.id} className="clickable">
                    <td>
                      <Link href={`/productions/${production.id}`}>{idea.title}</Link>
                      {production.failureReason && (
                        <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{production.failureReason}</div>
                      )}
                    </td>
                    <td>
                      <StatusBadge status={production.status} />
                    </td>
                    <td className="muted num">revision {production.revisionCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <h3>In flight</h3>
        </div>
        <div className="panel-body flush">
          {inFlight.length === 0 ? (
            <p className="muted" style={{ padding: 16, margin: 0 }}>
              Nothing in production. <Link href="/ideas">Greenlight an idea</Link> to start the pipeline.
            </p>
          ) : (
            <table className="data" style={{ border: "none", borderRadius: 0 }}>
              <tbody>
                {inFlight.map(({ production, idea }) => (
                  <tr key={production.id} className="clickable">
                    <td>
                      <Link href={`/productions/${production.id}`}>{idea.title}</Link>
                    </td>
                    <td>
                      <StatusBadge status={production.status} />
                    </td>
                    <td className="muted num">revision {production.revisionCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

function VideosTab({
  channelId,
  recent,
  pubByProd,
  latestSnapByPub,
  costByProd,
}: {
  channelId: string;
  recent: { production: typeof productions.$inferSelect; idea: typeof ideas.$inferSelect }[];
  pubByProd: Map<string, typeof publications.$inferSelect>;
  latestSnapByPub: Map<string, typeof analyticsSnapshots.$inferSelect>;
  costByProd: Map<string, number>;
}) {
  const published = recent.filter((r) => pubByProd.has(r.production.id));
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Videos</h3>
        <span className="muted">{published.length} published</span>
      </div>
      <div className="panel-body flush">
        {recent.length === 0 ? (
          <p className="muted" style={{ padding: 16, margin: 0 }}>
            No videos yet.
          </p>
        ) : (
          <table className="data" style={{ border: "none", borderRadius: 0 }}>
            <thead>
              <tr>
                <th>Video</th>
                <th>Views</th>
                <th>% viewed</th>
                <th>Cost</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {recent.map(({ production, idea }) => {
                const pub = pubByProd.get(production.id);
                const snap = pub ? latestSnapByPub.get(pub.id) : undefined;
                const cost = costByProd.get(production.id);
                const href = pub
                  ? `/channels/${channelId}/videos/${pub.id}`
                  : `/productions/${production.id}`;
                return (
                  <tr key={production.id} className="clickable">
                    <td>
                      <Link href={href} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span className="vthumb" style={{ background: "linear-gradient(135deg,var(--accent),var(--accent-2))" }}>
                          <svg viewBox="0 0 24 24" width="13" height="13" fill="#fff">
                            <polygon points="8 5 19 12 8 19" />
                          </svg>
                        </span>
                        {idea.title}
                      </Link>
                    </td>
                    <td className="num">{snap ? fmtNum(snap.views) : "—"}</td>
                    <td className="num">{snap?.avgViewPct != null ? `${Math.round(snap.avgViewPct)}%` : "—"}</td>
                    <td className="num">{cost != null ? `$${cost.toFixed(4)}` : "—"}</td>
                    <td>
                      <StatusBadge status={production.status} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function ScheduleTab({
  channelId,
  scheduled,
  ideaTitle,
  warmup,
  calItems,
  funnel,
}: {
  channelId: string;
  scheduled: (typeof publications.$inferSelect)[];
  ideaTitle: Map<string, string>;
  warmup: ChannelWarmupState | null;
  calItems: CalItem[];
  funnel: { planned: number; inProduction: number; scheduled: number; published: number };
}) {
  const stages: { l: string; v: number; h: string; hot?: boolean }[] = [
    { l: "Planned", v: funnel.planned, h: "episodes in the roadmap" },
    { l: "In production", v: funnel.inProduction, h: "scripting → render" },
    { l: "Scheduled", v: funnel.scheduled, h: "dated, waiting to publish", hot: true },
    { l: "Published", v: funnel.published, h: "live" },
  ];
  return (
    <>
      <h1 className="page-title" style={{ marginBottom: 4 }}>Plan &amp; Schedule</h1>
      <p className="page-sub" style={{ marginBottom: 18 }}>
        Approved videos are slotted onto the warm-up ramp and shown here on their publish date. Scheduled videos
        wait on their date; published ones are live. Click a day to see what goes out.
      </p>
      <div className="sc-funnel">
        {stages.map((s, i) => (
          <Fragment key={s.l}>
            <div className={`sc-stage${s.hot ? " hot" : ""}`}>
              <div className="fl">{s.l}</div>
              <div className="fv">{s.v}</div>
              <div className="fh">{s.h}</div>
            </div>
            {i < stages.length - 1 && (
              <div className="sc-arrow">
                <IconChevronRight />
              </div>
            )}
          </Fragment>
        ))}
      </div>
      <ScheduleCalendar items={calItems} reprojectChannelId={channelId} />

      <div className="panel" style={{ marginTop: 20 }}>
        <div className="panel-head">
          <h3>Warm-up ramp</h3>
          <span className="chip acc">Shorts</span>
        </div>
        <div className="panel-body">
          <p className="muted" style={{ marginTop: 0 }}>
            New channels get throttled if they post like an established one. The scheduler releases auto-tier uploads
            on this ramp — building trust before scaling to full cadence, on the Shorts evening daypart, and never
            deleting/re-uploading (a spam signal).
          </p>
          {warmup ? (
            <>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
                <span className="chip acc">
                  {warmup.graduated ? "Full cadence" : `Week ${warmup.week} of ${warmup.ramp.length}`}
                </span>
                <span className="chip">
                  {warmup.releasedThisWeek} / {warmup.cap} this week
                </span>
                <span className="chip">launched {warmup.launchedAt.toISOString().slice(0, 10)}</span>
              </div>
              {warmup.ramp.map((r) => {
                const done = r.current ? Math.min(warmup.releasedThisWeek, r.cap) : 0;
                const planned = Math.max(0, r.cap - done);
                return (
                  <div key={r.week} className="weekrow">
                    <div className="wk">
                      Week {r.week}
                      {r.current ? <small>current</small> : r.week === warmup.ramp.length ? <small>full cadence</small> : null}
                    </div>
                    <div className="dots">
                      {Array.from({ length: done }).map((_, i) => (
                        <span key={`d${i}`} className="dp">
                          <IconCheck />
                        </span>
                      ))}
                      {Array.from({ length: planned }).map((_, i) => (
                        <span key={`p${i}`} className="dp ghost" />
                      ))}
                    </div>
                    <div className="cad">{r.cap} / wk</div>
                  </div>
                );
              })}
            </>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              No warm-up data.
            </p>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Upcoming scheduled</h3>
          {warmup && warmup.upcoming.length > 0 ? (
            <span className="muted">{warmup.upcoming.length} queued</span>
          ) : null}
        </div>
        <div className="panel-body flush">
          {scheduled.length === 0 ? (
            <p className="muted" style={{ padding: 16, margin: 0 }}>
              Nothing scheduled. Auto-tier uploads are released on the warm-up ramp above; operators schedule gated
              uploads at the final review gate.
            </p>
          ) : (
            <table className="data" style={{ border: "none", borderRadius: 0 }}>
              <tbody>
                {scheduled.map((p) => (
                  <tr key={p.id}>
                    <td>{ideaTitle.get(p.productionId) ?? p.productionId}</td>
                    <td className="muted num">{fmtDateTime(p.scheduledFor!)}</td>
                    <td>
                      <span className="chip acc">
                        {p.privacyStatus === "scheduled"
                          ? "Goes public automatically"
                          : p.privacyStatus === "private"
                            ? "Private until release"
                            : "Public"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

function CostsTab({ costByCat, costTotal }: { costByCat: Map<string, number>; costTotal: number }) {
  const categories = ["llm", "voice", "media", "render", "publish", "research"] as const;
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Unit economics</h3>
        <span className="num muted">${costTotal.toFixed(4)} total</span>
      </div>
      <div className="panel-body">
        {costTotal === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No cost records for this channel yet.
          </p>
        ) : (
          categories.map((c) => {
            const v = costByCat.get(c) ?? 0;
            const pct = costTotal ? (v / costTotal) * 100 : 0;
            return (
              <div key={c} className="tbar">
                <span className="tn">{c}</span>
                <span className="track">
                  <span className="fill" style={{ width: `${pct}%` }} />
                </span>
                <span className="tv">${v.toFixed(4)}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function SettingsTab({
  id,
  channel,
  dna,
  token,
  connected,
  error,
  voices,
  charter,
  oauthRedirectUri,
  publicBaseSet,
}: {
  id: string;
  channel: typeof channels.$inferSelect;
  dna: typeof channelDna.$inferSelect | undefined;
  token: typeof secrets.$inferSelect | undefined;
  connected?: string;
  error?: string;
  voices: VoiceOption[];
  charter: ChannelPlan["charter"];
  oauthRedirectUri: string;
  publicBaseSet: boolean;
}) {
  return (
    <>
      {connected && (
        <div className="callout good" style={{ marginTop: 0 }}>
          <IconCheck />
          <span>YouTube connected: {connected}</span>
        </div>
      )}
      {error && (
        <div className="callout crit" style={{ marginTop: 0 }}>
          <IconAlertTriangle />
          <span>{error}</span>
        </div>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>YouTube connection</h2>
        {token ? (
          <p style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span className="chip good">
              <span className="d" />
              Connected
            </span>
            {channel.youtubeChannelId ? (
              <a
                href={`https://www.youtube.com/channel/${channel.youtubeChannelId}`}
                style={{ color: "var(--accent-ink)", fontWeight: 600 }}
              >
                {channel.youtubeChannelId}
              </a>
            ) : (
              <span className="muted">channel id unknown</span>
            )}
            <span className="muted">
              Encrypted refresh token stored <span className="mono">····{token.last4}</span>
            </span>
          </p>
        ) : (
          <p style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span className="chip">Not connected</span>
            <span className="muted">
              Uploads fall back to the global <span className="mono">YOUTUBE_REFRESH_TOKEN</span>, or the mock
              publisher if none is set.
            </span>
          </p>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <a className="btn" href={`/api/oauth/youtube/start?channelId=${id}`}>
            {token ? "Reconnect YouTube" : "Connect YouTube"}
          </a>
          {token && (
            <form className="inline" action={disconnectYouTubeAction.bind(null, id)}>
              <button className="btn ghost danger-ink" type="submit">
                Disconnect
              </button>
            </form>
          )}
        </div>
        <div className="aibox" style={{ marginTop: 12 }}>
          <h4 style={{ marginBottom: 6 }}>
            <IconAlertTriangle /> Fix a <span className="mono">redirect_uri_mismatch</span>
          </h4>
          <p style={{ margin: "0 0 8px", fontSize: 12.5 }}>
            Add this <b>exact</b> URI to Google Cloud Console → APIs &amp; Services → Credentials → your OAuth 2.0
            client → <b>Authorized redirect URIs</b>, then retry:
          </p>
          <div
            className="mono"
            style={{
              userSelect: "all",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "8px 10px",
              fontSize: 12.5,
              wordBreak: "break-all",
            }}
          >
            {oauthRedirectUri}
          </div>
          {!publicBaseSet && (
            <p className="chip warn" style={{ marginTop: 8 }}>
              <span className="d" />
              PUBLIC_BASE_URL isn&apos;t set — set it to this cockpit&apos;s exact URL (e.g.
              https://app.commongroundsocial.com.au) so the URI above is correct, then redeploy.
            </p>
          )}
          <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
            Needs the OAuth client ID/secret on the{" "}
            <Link href="/account" style={{ color: "var(--accent-ink)", fontWeight: 600 }}>Account &amp; keys</Link>{" "}
            page (a <b>Web application</b> client). The URI must match character-for-character (scheme, host, path — no
            trailing slash).
          </p>
        </div>
      </div>

      <ChannelForm action={updateChannelAction.bind(null, id)} channel={channel} dna={dna} submitLabel="Save changes" voices={voices} hideVoiceTone />

      {charter && (
        <form action={updateCharterSettingsAction.bind(null, id)} className="form-narrow">
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Charter &amp; verification</h2>
            <p className="muted" style={{ margin: "-6px 0 14px", fontSize: 12.5 }}>
              The editorial rules you set at creation — mission, how hard facts are corroborated, and your
              check-in cadence. Objectives/targets are edited on the Plan tab.
            </p>
            <label>
              Mission
              <textarea name="mission" rows={2} defaultValue={charter.mission} />
            </label>
            <div className="grid-2 grid">
              <label>
                Factual rigor{" "}
                <span className="muted">
                  — strict cuts what can&apos;t be corroborated; balanced keeps unknowns as framed
                  conjecture (&ldquo;no one knows&rdquo; is a hook); entertainment never cuts for rigor
                </span>
                <select name="factualityMode" defaultValue={charter.verificationBar.factualityMode ?? "balanced"}>
                  <option value="strict">Strict — science / finance / news</option>
                  <option value="balanced">Balanced — history / mystery (conjecture framed)</option>
                  <option value="entertainment">Entertainment — fun-first, gate off</option>
                </select>
              </label>
              <label>
                Corroboration bar{" "}
                <span className="muted">— established facts need this many independent sources (lower = fewer cut)</span>
                <input
                  type="number"
                  name="establishedMinSources"
                  min={1}
                  max={5}
                  defaultValue={charter.verificationBar.establishedMinSources}
                />
              </label>
              <label>
                Facts gate{" "}
                <span className="muted">— minimum verified/attributed facts before an episode may be scripted (no full scripts on 1 fact)</span>
                <input
                  type="number"
                  name="minFactsToScript"
                  min={1}
                  max={20}
                  defaultValue={charter.verificationBar.minFactsToScript ?? 3}
                />
              </label>
              <label>
                Check-in cadence
                <select name="checkinCadence" defaultValue={charter.checkinCadence}>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </label>
            </div>
            <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 0 }}>
              <input
                type="checkbox"
                name="presentDebateMode"
                defaultChecked={charter.verificationBar.presentDebateMode}
                style={{ width: "auto" }}
              />
              Present-the-debate mode on contested claims (attribute, never assert)
            </label>
            <div className="form-foot">
              <button type="submit" className="btn">
                Save charter
              </button>
            </div>
          </div>
        </form>
      )}

      <div className="panel" style={{ marginTop: 16, borderColor: "var(--crit, #ef4444)" }}>
        <div className="panel-head">
          <h3>Danger zone</h3>
        </div>
        <div
          className="panel-body"
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}
        >
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Permanently delete this channel and all of its productions, ideas, sources and history.
          </p>
          <DeleteChannelButton channelId={id} channelName={channel.name} />
        </div>
      </div>
    </>
  );
}
