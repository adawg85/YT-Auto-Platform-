import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq, inArray } from "drizzle-orm";
import {
  analyticsSnapshots,
  channelDna,
  channels,
  costRecords,
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
import { getAppContext } from "@/lib/context";
import { loadChannelPlan, type ChannelPlan } from "@/lib/plan";
import { disconnectYouTubeAction, updateChannelAction } from "../actions";
import { decideSeriesAction, runEditorialPlanAction } from "../editorial-actions";
import { ChannelForm } from "../channel-form";
import { PageTabs, type Tab } from "@/components/page-tabs";
import { ChannelSwitcher } from "@/components/channel-switcher";
import { RetentionCurve } from "@/components/charts";
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  DataTable,
  EmptyState,
  Panel,
  StatGrid,
  StatTile,
  type Tone,
} from "@/components/ui";
import {
  IconChevronLeft,
  IconSparkle,
  IconCheck,
  IconX,
  IconInbox,
  IconFilm,
  IconClock,
  IconDollar,
  IconLightbulb,
  IconTrend,
} from "@/components/icons";
import { fmtNum, tierLabel, PIPELINE_STAGES } from "@/lib/format";

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
  const { db } = await getAppContext();

  const [channel] = await db.select().from(channels).where(eq(channels.id, id));
  if (!channel) notFound();
  const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, id));
  const [token] = await db.select().from(secrets).where(eq(secrets.name, channelTokenName(id)));
  const perf = await channelPerformanceSummary(db, id);
  // shared pattern store, channel-niche slice (build #4): what's working here
  const ground = await patternGrounding(db, { niche: channel.niche, format: "shorts", perKind: 5 });
  // live warm-up ramp state (build #3)
  const warmup = await channelWarmupState(db, id);
  // editorial plan: charter + series arcs + per-episode verification (build #5)
  const plan = await loadChannelPlan(db, id);
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
      panel: <PlanTab channelId={id} plan={plan} />,
    },
    {
      key: "production",
      label: "In production",
      badge: inFlight.length || null,
      panel: <ProductionTab stageCounts={stageCounts} inFlight={inFlight} />,
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
        <SettingsTab id={id} channel={channel} dna={dna} token={token} connected={connected} error={error} />
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
        <Badge tone={token ? "good" : "neutral"} dot>
          {token ? "YouTube connected" : "Not connected"}
        </Badge>
        <Badge>{tierLabel(channel.autonomyTier)}</Badge>
        <Badge>{fmtNum(perf.medianViews)} median views</Badge>
        {perf.avgViewPct != null && <Badge>{Math.round(perf.avgViewPct)}% retention</Badge>}
        <Badge>{perf.publishedCount} published</Badge>
        {perVideo != null && <Badge>${perVideo.toFixed(2)} / video</Badge>}
      </div>

      <PageTabs tabs={tabs} />
    </>
  );
}

const EPISODE_BADGE: Record<string, Tone> = {
  planned: "neutral",
  researching: "accent",
  verifying: "accent",
  briefed: "warn",
  queued: "warn",
  produced: "good",
  published: "good",
  cut: "crit",
};

/** Editorial plan (build #5): charter summary, series arcs, coverage ledger. */
function PlanTab({ channelId, plan }: { channelId: string; plan: ChannelPlan }) {
  if (!plan.charter) {
    return (
      <EmptyState
        icon={<IconLightbulb />}
        title="No charter yet"
        description="This channel predates the editorial engine (or was created with the manual form). The engine plans series, researches sources, and verifies claims only for charter'd channels."
      />
    );
  }
  const bar = plan.charter.verificationBar;
  return (
    <div>
      <Panel
        title="Charter"
        action={
          <form action={runEditorialPlanAction.bind(null, channelId)}>
            <Button type="submit" size="sm" icon={<IconSparkle />}>
              Plan / research now
            </Button>
          </form>
        }
      >
        <p>{plan.charter.mission}</p>
        <ul className="muted" style={{ margin: "0.4rem 0", paddingLeft: "1.1rem" }}>
          {(plan.charter.objectives ?? []).map((o) => (
            <li key={o}>{o}</li>
          ))}
        </ul>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Badge>{plan.charter.archetype.replace(/_/g, " ")}</Badge>
          <Badge>established facts: ≥{bar.establishedMinSources} sources</Badge>
          {bar.presentDebateMode && <Badge>present-the-debate</Badge>}
          <Badge>check-in: {plan.charter.checkinCadence}</Badge>
        </div>
      </Panel>

      {plan.series.length === 0 && (
        <div style={{ marginTop: 16 }}>
          <EmptyState
            icon={<IconInbox />}
            title="No series planned yet"
            description={'The daily planner will draft the first arc, or click "Plan / research now" above.'}
          />
        </div>
      )}

      {plan.series.map((s) => {
        const done = s.episodes.filter((e) => ["produced", "published"].includes(e.status)).length;
        return (
          <Panel
            key={s.id}
            title={
              <h3>
                {s.title}{" "}
                <Badge tone={s.status === "active" ? "good" : s.status === "proposed" ? "warn" : "neutral"}>
                  {s.status}
                </Badge>{" "}
                <span className="muted">
                  {done}/{s.plannedEpisodeCount || s.episodes.length} published
                </span>
              </h3>
            }
            action={
              s.status === "proposed" ? (
                <div style={{ display: "flex", gap: 8 }}>
                  <form action={decideSeriesAction.bind(null, s.id, "approve")}>
                    <Button type="submit" size="sm" variant="good" icon={<IconCheck />}>
                      Approve
                    </Button>
                  </form>
                  <form action={decideSeriesAction.bind(null, s.id, "reject")}>
                    <Button type="submit" size="sm" variant="secondary">
                      Reject
                    </Button>
                  </form>
                </div>
              ) : undefined
            }
          >
            <p className="muted">{s.description}</p>
            <DataTable>
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
                      <Badge tone={EPISODE_BADGE[e.status] ?? "neutral"}>{e.status}</Badge>
                    </td>
                    <td className="num">
                      {e.verifiedClaims + e.attributedClaims + e.cutClaims > 0 ? (
                        <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
                          <Badge tone="good">
                            <IconCheck className="ic" />
                            {e.verifiedClaims}
                          </Badge>
                          {e.attributedClaims > 0 && <Badge tone="warn">~{e.attributedClaims}</Badge>}
                          {e.cutClaims > 0 && (
                            <Badge tone="crit">
                              <IconX className="ic" />
                              {e.cutClaims}
                            </Badge>
                          )}
                        </span>
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
            </DataTable>
          </Panel>
        );
      })}
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
      <StatGrid>
        <StatTile label="Avg % viewed" value={perf.avgViewPct != null ? `${Math.round(perf.avgViewPct)}%` : "—"} />
        <StatTile label="Median views" value={fmtNum(perf.medianViews)} />
        <StatTile label="Published" value={perf.publishedCount} />
        <StatTile label="Avg duration" value={perf.avgViewDurationSec != null ? `${Math.round(perf.avgViewDurationSec)}s` : "—"} />
      </StatGrid>

      <Panel title="Retention curve">
        {hasData ? (
          // We have an average % viewed but not a per-second curve yet; render a
          // representative decay anchored to the real average.
          <RetentionCurve id="chRet" data={syntheticCurveFromAvg(perf.avgViewPct!)} />
        ) : (
          <EmptyState
            icon={<IconTrend />}
            title="No retention data yet"
            description="Once this channel has published videos and the analytics ingestion runs, the retention curve — with the 0–3s hook zone highlighted — shows here."
          />
        )}
      </Panel>

      <Panel
        title={
          <h3>
            <IconSparkle /> What&apos;s working
          </h3>
        }
        action={<Link href="/market">Market intel →</Link>}
      >
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
          <p className="muted" style={{ margin: "16px 0 0" }}>
            No patterns for this niche yet. Run a <Link href="/market">market scan</Link> to populate
            hook patterns, script structures and rising topic signals — own results merge in
            automatically as videos publish.
          </p>
        )}
      </Panel>
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
          <Badge tone={r.source === "external" ? "neutral" : "accent"}>{r.source}</Badge>
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
}: {
  stageCounts: Map<string, number>;
  inFlight: { production: typeof productions.$inferSelect; idea: typeof ideas.$inferSelect }[];
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
      <Panel title="In flight" flush>
        {inFlight.length === 0 ? (
          <EmptyState
            icon={<IconFilm />}
            title="Nothing in production"
            description="Greenlight an idea to start the pipeline."
            action={
              <ButtonLink href="/ideas" size="sm" variant="secondary">
                Greenlight an idea
              </ButtonLink>
            }
          />
        ) : (
          <DataTable>
            <tbody>
              {inFlight.map(({ production, idea }) => (
                <tr key={production.id} className="clickable">
                  <td>
                    <Link href={`/productions/${production.id}`}>{idea.title}</Link>
                  </td>
                  <td>
                    <Badge tone="accent">{production.status.replace(/_/g, " ")}</Badge>
                  </td>
                  <td className="muted num">rev {production.revisionCount}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Panel>
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
    <Panel title="Videos" action={<span className="muted">{published.length} published</span>} flush>
      {recent.length === 0 ? (
        <EmptyState
          icon={<IconFilm />}
          title="No videos yet"
          description="Videos appear here once productions on this channel reach the publish stage."
        />
      ) : (
        <DataTable>
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
                      <Badge>{production.status.replace(/_/g, " ")}</Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
      )}
    </Panel>
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
      <Panel title="Warm-up ramp" action={<Badge tone="accent">Shorts</Badge>}>
        <p className="muted" style={{ marginTop: 0 }}>
            New channels get throttled if they post like an established one. The scheduler releases auto-tier uploads
            on this ramp — building trust before scaling to full cadence, on the Shorts evening daypart, and never
            deleting/re-uploading (a spam signal).
          </p>
          {warmup ? (
            <>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
                <Badge tone="accent">
                  {warmup.graduated ? "Full cadence" : `Week ${warmup.week} of ${warmup.ramp.length}`}
                </Badge>
                <Badge>
                  {warmup.releasedThisWeek} / {warmup.cap} this week
                </Badge>
                <Badge>launched {warmup.launchedAt.toISOString().slice(0, 10)}</Badge>
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
            <EmptyState
              icon={<IconClock />}
              title="No warm-up data"
              description="Warm-up ramp state appears once this channel launches its first upload."
            />
          )}
      </Panel>

      <Panel
        title="Upcoming scheduled"
        action={warmup && warmup.upcoming.length > 0 ? <span className="muted">{warmup.upcoming.length} queued</span> : undefined}
        flush
      >
        {scheduled.length === 0 ? (
          <EmptyState
            icon={<IconClock />}
            title="Nothing scheduled"
            description="Auto-tier uploads are released on the warm-up ramp above; operators schedule gated uploads at the final review gate."
          />
        ) : (
          <DataTable>
            <tbody>
              {scheduled.map((p) => (
                <tr key={p.id}>
                  <td>{ideaTitle.get(p.productionId) ?? p.productionId}</td>
                  <td className="muted num">{new Date(p.scheduledFor!).toISOString().slice(0, 16).replace("T", " ")}</td>
                  <td>
                    <Badge tone="accent">{p.privacyStatus}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Panel>
    </>
  );
}

function CostsTab({ costByCat, costTotal }: { costByCat: Map<string, number>; costTotal: number }) {
  const categories = ["llm", "voice", "media", "render", "publish", "research"] as const;
  return (
    <Panel title="Unit economics" action={<span className="num muted">${costTotal.toFixed(4)} total</span>}>
      {costTotal === 0 ? (
        <EmptyState
          icon={<IconDollar />}
          title="No cost records yet"
          description="Per-category spend appears here once productions on this channel incur LLM, voice, media, render or research costs."
        />
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
    </Panel>
  );
}

function SettingsTab({
  id,
  channel,
  dna,
  token,
  connected,
  error,
}: {
  id: string;
  channel: typeof channels.$inferSelect;
  dna: typeof channelDna.$inferSelect | undefined;
  token: typeof secrets.$inferSelect | undefined;
  connected?: string;
  error?: string;
}) {
  return (
    <>
      {connected && (
        <Card style={{ borderColor: "var(--good)" }}>
          <Badge tone="good" dot>connected</Badge> {connected}
        </Card>
      )}
      {error && (
        <Card style={{ borderColor: "var(--crit)" }}>
          <Badge tone="crit" dot>error</Badge> {error}
        </Card>
      )}

      <Card>
        <h2 style={{ marginTop: 0 }}>YouTube connection</h2>
        {token ? (
          <p>
            <Badge tone="good" dot>connected</Badge>{" "}
            {channel.youtubeChannelId ? (
              <a href={`https://www.youtube.com/channel/${channel.youtubeChannelId}`}>{channel.youtubeChannelId}</a>
            ) : (
              <span className="muted">channel id unknown</span>
            )}{" "}
            · encrypted refresh token stored <span className="mono muted">····{token.last4}</span>
          </p>
        ) : (
          <p>
            <Badge>not connected</Badge>{" "}
            <span className="muted">
              Uploads for this channel fall back to the global YOUTUBE_REFRESH_TOKEN (or the mock publisher if none).
            </span>
          </p>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {/* Plain anchor: this hits an OAuth API route that 302s to Google — a
              client-side next/link navigation would break the redirect. */}
          <a className="btn" href={`/api/oauth/youtube/start?channelId=${id}`}>
            {token ? "Reconnect" : "Connect"} YouTube
          </a>
          {token && (
            <form className="inline" action={disconnectYouTubeAction.bind(null, id)}>
              <Button variant="danger" type="submit">
                Disconnect
              </Button>
            </form>
          )}
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Requires the YouTube OAuth client ID/secret on the <Link href="/account">Account</Link> page. Add{" "}
          <span className="mono">…/api/oauth/youtube/callback</span> as an authorized redirect URI in the GCP console.
        </p>
      </Card>

      <h2>Channel DNA</h2>
      <ChannelForm action={updateChannelAction.bind(null, id)} channel={channel} dna={dna} submitLabel="Save changes" />
    </>
  );
}
