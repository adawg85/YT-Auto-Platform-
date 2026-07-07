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
import { channelPerformanceSummary, channelTokenName } from "@ytauto/core";
import { getAppContext } from "@/lib/context";
import { disconnectYouTubeAction, updateChannelAction } from "../actions";
import { ChannelForm } from "../channel-form";
import { PageTabs, type Tab } from "@/components/page-tabs";
import { ChannelSwitcher } from "@/components/channel-switcher";
import { RetentionCurve } from "@/components/charts";
import { IconAlertTriangle, IconChevronLeft, IconSparkle, IconCheck } from "@/components/icons";
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
  const { db } = await getAppContext();

  const [channel] = await db.select().from(channels).where(eq(channels.id, id));
  if (!channel) notFound();
  const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, id));
  const [token] = await db.select().from(secrets).where(eq(secrets.name, channelTokenName(id)));
  const perf = await channelPerformanceSummary(db, id);
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
    { key: "analytics", label: "Analytics", panel: <AnalyticsTab perf={perf} /> },
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
      panel: <ScheduleTab scheduled={scheduled} ideaTitle={ideaTitle} />,
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

function Kpi({ lab, val, sub }: { lab: string; val: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="kpi">
      <div className="lab">{lab}</div>
      <div className="val">{val}</div>
      {sub ? <div className="metric-help">{sub}</div> : null}
    </div>
  );
}

function AnalyticsTab({ perf }: { perf: Awaited<ReturnType<typeof channelPerformanceSummary>> }) {
  const hasData = perf.avgViewPct != null;
  return (
    <>
      <div className="kpis">
        <Kpi lab="Avg % viewed" val={perf.avgViewPct != null ? <span className="num">{Math.round(perf.avgViewPct)}%</span> : "—"} />
        <Kpi lab="Median views" val={<span className="num">{fmtNum(perf.medianViews)}</span>} />
        <Kpi lab="Published" val={<span className="num">{perf.publishedCount}</span>} />
        <Kpi lab="Avg duration" val={perf.avgViewDurationSec != null ? <span className="num">{Math.round(perf.avgViewDurationSec)}s</span> : "—"} />
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
        </div>
        <div className="panel-body">
          <div className="aibox">
            <h4>
              <IconSparkle /> AI channel analysis
            </h4>
            <p style={{ margin: 0 }}>
              {perf.publishedCount === 0
                ? "No published videos yet. Once videos publish and accrue analytics, this panel summarises which hook styles and script structures are over-performing on this channel (backlog build #3 + #4)."
                : perf.summaryText}
            </p>
          </div>
        </div>
      </div>
    </>
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
                      <span className="chip acc">{prodStatusLabel(production.status)}</span>
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

// Warm-up ramp — recommended Shorts cadence (backlog build #3). Automated
// enforcement lands with the scheduler; today this is the recommended plan.
const RAMP = [
  { wk: "Week 1", note: "gentle start", done: 3, planned: 0, cad: "3 / wk" },
  { wk: "Week 2", note: "", done: 0, planned: 4, cad: "4 / wk" },
  { wk: "Week 3–4", note: "", done: 0, planned: 5, cad: "5 / wk" },
  { wk: "Week 5–6", note: "full cadence", done: 0, planned: 7, cad: "7 / wk (full)" },
];

function ScheduleTab({
  scheduled,
  ideaTitle,
}: {
  scheduled: (typeof publications.$inferSelect)[];
  ideaTitle: Map<string, string>;
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
            New channels get throttled if they post like an established one. This ramp builds trust before scaling to
            full cadence — and never deletes/re-uploads (a spam signal). Automated enforcement arrives with the
            scheduler; today it&apos;s the recommended plan.
          </p>
          {RAMP.map((r) => (
            <div key={r.wk} className="weekrow">
              <div className="wk">
                {r.wk}
                {r.note ? <small>{r.note}</small> : null}
              </div>
              <div className="dots">
                {Array.from({ length: r.done }).map((_, i) => (
                  <span key={`d${i}`} className="dp">
                    <IconCheck />
                  </span>
                ))}
                {Array.from({ length: r.planned }).map((_, i) => (
                  <span key={`p${i}`} className="dp ghost" />
                ))}
              </div>
              <div className="cad">{r.cad}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Upcoming scheduled</h3>
        </div>
        <div className="panel-body flush">
          {scheduled.length === 0 ? (
            <p className="muted" style={{ padding: 16, margin: 0 }}>
              Nothing scheduled. Scheduled publishing runs against YouTube quota (Phase 3).
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

      <ChannelForm action={updateChannelAction.bind(null, id)} channel={channel} dna={dna} submitLabel="Save changes" />
    </>
  );
}
