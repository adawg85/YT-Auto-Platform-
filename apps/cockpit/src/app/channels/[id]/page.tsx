import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  analyticsSnapshots,
  channelDna,
  channels,
  claims,
  costRecords,
  episodes,
  ideas,
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
  type ChannelWarmupState,
  type PatternRow,
} from "@ytauto/core";
import type { VoiceOption } from "@ytauto/providers";
import { PlanLive } from "./plan-live";
import { PlanAssistant } from "./plan-assistant";
import { CharterObjectives } from "./charter-objectives";
import { getAppContext } from "@/lib/context";
import { loadChannelPlan, type ChannelPlan } from "@/lib/plan";
import { loadChannelBriefings, type ChannelBriefings } from "@/lib/briefings";
import { disconnectYouTubeAction, updateChannelAction } from "../actions";
import {
  decideSeriesAction,
  respondBriefingAction,
  runBriefingNowAction,
  runEditorialPlanAction,
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
} from "@/components/icons";
import { fmtDateTime, fmtNum, prodStatusLabel, tierLabel, PIPELINE_STAGES } from "@/lib/format";

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
  // TTS voice library for the per-channel voice picker (best-effort — a
  // provider hiccup must not break the settings page).
  let voices: VoiceOption[] = [];
  try {
    voices = await providers.voice.listVoices();
  } catch {
    voices = [];
  }
  const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, id));
  const [token] = await db.select().from(secrets).where(eq(secrets.name, channelTokenName(id)));
  const perf = await channelPerformanceSummary(db, id);
  // shared pattern store, channel-niche slice (build #4): what's working here
  const ground = await patternGrounding(db, { niche: channel.niche, format: "shorts", perKind: 5 });
  // live warm-up ramp state (build #3)
  const warmup = await channelWarmupState(db, id);
  // editorial plan: charter + series arcs + per-episode verification (build #5)
  const plan = await loadChannelPlan(db, id);
  // verification cost (#17): what the corroboration bar is costing this channel
  const claimStatRows = await db
    .select({ status: claims.status, n: sql<number>`count(*)::int` })
    .from(claims)
    .where(eq(claims.channelId, id))
    .groupBy(claims.status);
  const claimStats = Object.fromEntries(claimStatRows.map((r) => [r.status, r.n])) as Record<string, number>;
  const cutClaims = await db
    .select({ text: claims.text, tier: claims.tier, episodeTitle: episodes.title })
    .from(claims)
    .innerJoin(episodes, eq(claims.episodeId, episodes.id))
    .where(and(eq(claims.channelId, id), eq(claims.status, "cut")))
    .orderBy(desc(claims.createdAt))
    .limit(15);
  // operator check-ins + experiment ledger (build #5.2)
  const briefings = await loadChannelBriefings(db, id);
  const allChannels = await db.select({ id: channels.id, name: channels.name }).from(channels);

  const recent = await db
    .select({ production: productions, idea: ideas })
    .from(productions)
    .innerJoin(ideas, eq(productions.ideaId, ideas.id))
    .where(eq(productions.channelId, id))
    .orderBy(desc(productions.createdAt))
    .limit(50);

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

  const tabs: Tab[] = [
    { key: "analytics", label: "Analytics", panel: <AnalyticsTab perf={perf} ground={ground} /> },
    {
      key: "plan",
      label: "Plan",
      badge: plan.series.filter((s) => s.status === "proposed").length || null,
      panel: (
        <PlanTab
          channelId={id}
          plan={plan}
          channelName={channel.name}
          claimStats={claimStats}
          cutClaims={cutClaims}
        />
      ),
    },
    {
      key: "briefings",
      label: "Briefings",
      badge: briefings.openCount || null,
      panel: <BriefingsTab channelId={id} data={briefings} hasCharter={!!plan.charter} />,
    },
    {
      key: "production",
      label: "In production",
      badge: inFlight.length + stalled.length || null,
      panel: <ProductionTab stageCounts={stageCounts} inFlight={inFlight} stalled={stalled} />,
    },
    {
      key: "videos",
      label: "Videos",
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
      panel: <ScheduleTab scheduled={scheduled} ideaTitle={ideaTitle} warmup={warmup} />,
    },
    { key: "costs", label: "Costs", panel: <CostsTab costByCat={costByCat} costTotal={costTotal} /> },
    {
      key: "settings",
      label: "Settings & DNA",
      panel: (
        <SettingsTab id={id} channel={channel} dna={dna} token={token} connected={connected} error={error} voices={voices} charter={plan.charter} />
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

const EPISODE_BADGE: Record<string, string> = {
  planned: "",
  researching: "accent",
  verifying: "accent",
  briefed: "amber",
  queued: "amber",
  produced: "green",
  published: "green",
  cut: "red",
};

/** Editorial plan (build #5): charter summary, series arcs, coverage ledger. */
function PlanTab({
  channelId,
  plan,
  channelName,
  claimStats,
  cutClaims,
}: {
  channelId: string;
  plan: ChannelPlan;
  channelName: string;
  claimStats: Record<string, number>;
  cutClaims: { text: string; tier: string; episodeTitle: string }[];
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
      <div className="panel">
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
            <span className="chip">established facts: ≥{bar.establishedMinSources} sources</span>
            {bar.presentDebateMode && <span className="chip">present-the-debate</span>}
            <span className="chip">check-in: {plan.charter.checkinCadence}</span>
          </div>
        </div>
      </div>

      {(claimStats.cut ?? 0) + (claimStats.verified ?? 0) + (claimStats.attributed ?? 0) > 0 && (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel-head">
            <h3>Verification cost</h3>
          </div>
          <div className="panel-body">
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              <span className="chip good">{claimStats.verified ?? 0} verified</span>
              <span className="chip">{claimStats.attributed ?? 0} attributed</span>
              <span className={`chip ${(claimStats.cut ?? 0) > (claimStats.verified ?? 0) ? "crit" : "warn"}`}>
                <span className="d" />
                {claimStats.cut ?? 0} cut (didn&apos;t reach the corroboration bar)
              </span>
              {(claimStats.unverified ?? 0) > 0 && (
                <span className="chip warn">{claimStats.unverified} unverified</span>
              )}
            </div>
            <p className="muted" style={{ margin: "0 0 10px", fontSize: 12.5 }}>
              Lots cut vs verified? The corroboration bar (Settings &amp; DNA → Charter) may be too high for this
              niche, or the extractor is over-flagging. Lower the bar or turn on present-the-debate.
            </p>
            {cutClaims.length > 0 && (
              <div className="tablewrap">
                <table className="data">
                  <tbody>
                    {cutClaims.map((c, i) => (
                      <tr key={i}>
                        <td>{c.text}</td>
                        <td className="muted" style={{ whiteSpace: "nowrap" }}>
                          <span className="chip">{c.tier}</span>
                        </td>
                        <td className="muted" style={{ whiteSpace: "nowrap" }}>
                          {c.episodeTitle}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {plan.series.length === 0 && (
        <p className="muted">
          No series planned yet — the daily planner will draft the first arc, or click &quot;Plan /
          research now&quot;.
        </p>
      )}

      {plan.series.map((s) => {
        const done = s.episodes.filter((e) => ["produced", "published"].includes(e.status)).length;
        return (
          <div className="panel" key={s.id} style={{ marginTop: 16 }}>
            <div className="panel-head">
              <h3>
                {s.title}{" "}
                <span
                  className={`badge ${s.status === "active" ? "green" : s.status === "proposed" ? "amber" : ""}`}
                >
                  {s.status}
                </span>{" "}
                <span className="muted">
                  {done}/{s.plannedEpisodeCount || s.episodes.length} published
                </span>
              </h3>
              {s.status === "proposed" && (
                <div style={{ display: "flex", gap: 8 }}>
                  <form action={decideSeriesAction.bind(null, s.id, "approve")}>
                    <button type="submit">Approve</button>
                  </form>
                  <form action={decideSeriesAction.bind(null, s.id, "reject")}>
                    <button type="submit" className="secondary">
                      Reject
                    </button>
                  </form>
                </div>
              )}
            </div>
            <div className="panel-body">
              <p className="muted">{s.description}</p>
              <table className="data">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Episode</th>
                    <th>Status</th>
                    <th>Claims</th>
                    <th>Coverage</th>
                  </tr>
                </thead>
                <tbody>
                  {s.episodes.map((e) => (
                    <tr key={e.id}>
                      <td className="num">{e.position + 1}</td>
                      <td>
                        {e.title}
                        <div className="muted" style={{ fontSize: "0.85em" }}>
                          {e.angle}
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${EPISODE_BADGE[e.status] ?? ""}`}>{e.status}</span>
                      </td>
                      <td className="num">
                        {e.verifiedClaims + e.attributedClaims + e.cutClaims > 0 ? (
                          <>
                            <span className="badge green">{e.verifiedClaims}✓</span>{" "}
                            {e.attributedClaims > 0 && (
                              <span className="badge amber">{e.attributedClaims}~</span>
                            )}{" "}
                            {e.cutClaims > 0 && <span className="badge red">{e.cutClaims}✗</span>}
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="muted" style={{ maxWidth: 260 }}>
                        {e.coverageSummary ?? ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
              {new Date(b.periodStart).toLocaleDateString()} → {new Date(b.periodEnd).toLocaleDateString()}{" "}
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
                      <span className={`chip ${production.status === "failed" ? "crit" : "warn"}`}>
                        <span className="d" />
                        {prodStatusLabel(production.status)}
                      </span>
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
                      <span className="chip acc live">
                        <span className="d" />
                        {prodStatusLabel(production.status)}
                      </span>
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
                      <span className="chip">{prodStatusLabel(production.status)}</span>
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
  scheduled,
  ideaTitle,
  warmup,
}: {
  scheduled: (typeof publications.$inferSelect)[];
  ideaTitle: Map<string, string>;
  warmup: ChannelWarmupState | null;
}) {
  return (
    <>
      <div className="panel">
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
                      <span className="chip acc">{p.privacyStatus === "private" ? "Private until release" : "Public"}</span>
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
}: {
  id: string;
  channel: typeof channels.$inferSelect;
  dna: typeof channelDna.$inferSelect | undefined;
  token: typeof secrets.$inferSelect | undefined;
  connected?: string;
  error?: string;
  voices: VoiceOption[];
  charter: ChannelPlan["charter"];
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
        <p className="muted" style={{ marginBottom: 0, fontSize: 12.5 }}>
          Requires the YouTube OAuth client ID and secret on the{" "}
          <Link href="/account" style={{ color: "var(--accent-ink)", fontWeight: 600 }}>
            Account &amp; keys
          </Link>{" "}
          page. Add <span className="mono">…/api/oauth/youtube/callback</span> as an authorized redirect URI in the
          GCP console.
        </p>
      </div>

      <ChannelForm action={updateChannelAction.bind(null, id)} channel={channel} dna={dna} submitLabel="Save changes" voices={voices} />

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
