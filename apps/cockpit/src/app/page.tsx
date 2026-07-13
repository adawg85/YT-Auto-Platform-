import Link from "next/link";
import { sql, eq } from "drizzle-orm";
import { channels, costRecords, publications, productions, ideas } from "@ytauto/db";
import { getAppContext } from "@/lib/context";
import { loadPortfolio, loadTopVideos, tierLabel, type AttentionItem, type ChannelCard } from "@/lib/overview";
import { loadTentativeSlots } from "@/lib/plan";
import { channelStatusLabel, costCategoryLabel, fmtMoney } from "@/lib/format";
import { PageTabs, type Tab } from "@/components/page-tabs";
import { ScheduleCalendar, type CalItem } from "@/components/schedule-calendar";
import { TopVideos } from "@/components/top-videos";
import { AreaChart, Sparkline } from "@/components/charts";
import {
  IconPlus,
  IconPlay,
  IconChevronRight,
  IconEye,
  IconGauge,
  IconUpload,
  IconDollar,
  IconReview,
  IconTrend,
} from "@/components/icons";

export const dynamic = "force-dynamic";

const GRAD = "linear-gradient(135deg,var(--accent),var(--accent-2))";

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2).replace(/\.0+$/, "") + "M";
  if (n >= 1_000) return Math.round(n / 100) / 10 + "K";
  return String(n);
}
function fmtWhen(d: Date): string {
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export default async function OverviewPage() {
  const data = await loadPortfolio();
  const { kpis } = data;

  // cross-channel schedule (#8): every publication with a date, across channels.
  const { db } = await getAppContext();
  const schedRows = await db
    .select({
      publicationId: publications.id,
      productionId: publications.productionId,
      privacyStatus: publications.privacyStatus,
      providerVideoId: publications.providerVideoId,
      scheduledFor: publications.scheduledFor,
      publishedAt: publications.publishedAt,
      title: ideas.title,
      channelId: channels.id,
      channelName: channels.name,
      contentFormat: channels.contentFormat,
    })
    .from(publications)
    .innerJoin(productions, eq(publications.productionId, productions.id))
    .innerJoin(ideas, eq(productions.ideaId, ideas.id))
    .innerJoin(channels, eq(productions.channelId, channels.id));
  const calItems: CalItem[] = schedRows
    .map((r): CalItem | null => {
      const at = r.scheduledFor ?? r.publishedAt;
      if (!at) return null;
      return {
        at: new Date(at).toISOString(),
        title: r.title,
        channelId: r.channelId,
        channelName: r.channelName,
        format: r.contentFormat === "long" ? "long" : "short",
        status: r.publishedAt ? "published" : "scheduled",
        productionId: r.productionId,
        publicationId: r.publicationId,
        // #20: uploaded + natively scheduled → in-calendar publish/move/cancel
        controllable: r.privacyStatus === "scheduled" && !!r.providerVideoId,
      };
    })
    .filter((x): x is CalItem => x !== null);
  // #23.1: projected series slots across every channel — dimmed "tentative"
  // entries with no publish controls, gone once a real publication locks in.
  const tentativeSlots = await loadTentativeSlots(db);
  calItems.push(
    ...tentativeSlots.map(
      (t): CalItem => ({
        at: t.at.toISOString(),
        title: t.title,
        channelId: t.channelId,
        channelName: t.channelName,
        format: t.contentFormat === "long" ? "long" : "short",
        status: "scheduled",
        tentative: true,
        episodeId: t.episodeId,
      }),
    ),
  );
  const calChannels = Array.from(
    new Map(calItems.map((i) => [i.channelId, { id: i.channelId, name: i.channelName, format: i.format }])).values(),
  );

  const topVideos = await loadTopVideos();
  const nowMs = Date.now();
  const upcoming = calItems
    .filter((c) => new Date(c.at).getTime() >= nowMs && c.status !== "published")
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
    .slice(0, 6);

  const tabs: Tab[] = [
    { key: "overview", label: "Overview", panel: <OverviewTab data={data} upcoming={upcoming} topVideos={topVideos} /> },
    { key: "analytics", label: "Analytics", panel: <AnalyticsTab data={data} /> },
    {
      key: "schedule",
      label: "Schedule",
      panel: (
        <div>
          <p className="page-sub" style={{ marginBottom: 16 }}>
            Every channel&apos;s scheduled and published videos on one calendar. Filter by channel; click a day for detail.
          </p>
          <ScheduleCalendar items={calItems} channels={calChannels} />
        </div>
      ),
    },
    { key: "costs", label: "Costs", panel: <CostsTab /> },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Portfolio</h1>
          <p className="page-sub">
            Portfolio-wide performance across {data.cards.length} channel{data.cards.length === 1 ? "" : "s"}.
          </p>
        </div>
        <Link className="btn" href="/channels/new">
          <IconPlus /> New channel
        </Link>
      </div>
      <PageTabs tabs={tabs} />
    </>
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

function OverviewTab({
  data,
  upcoming,
  topVideos,
}: {
  data: Awaited<ReturnType<typeof loadPortfolio>>;
  upcoming: CalItem[];
  topVideos: Awaited<ReturnType<typeof loadTopVideos>>;
}) {
  const { kpis } = data;
  const net = kpis.estNet30;
  return (
    <>
      <div className="kpis">
        <Kpi lab="Views 30d" ic={<IconEye />} val={<span className="num">{fmtNum(kpis.views30)}</span>} />
        <Kpi
          lab="Subs 30d"
          ic={<IconTrend />}
          val={<span className="num">{kpis.subs30 >= 0 ? "+" : ""}{fmtNum(kpis.subs30)}</span>}
          sub={<span className="muted">gained across channels</span>}
        />
        <Kpi
          lab="Avg retention"
          ic={<IconGauge />}
          val={kpis.retention != null ? <span className="num">{Math.round(kpis.retention)}%</span> : "—"}
        />
        <Kpi lab="Published 7d" ic={<IconUpload />} val={<span className="num">{kpis.published7}</span>} />
        <Kpi
          lab="Spend 30d"
          ic={<IconDollar />}
          val={<span className="num">${kpis.spend30.toFixed(2)}</span>}
          sub={<span className="muted">across all channels</span>}
        />
        <Kpi
          lab="Est. net 30d"
          ic={<IconDollar />}
          val={
            <span className="num" style={{ color: net >= 0 ? "var(--good)" : "var(--crit)" }}>
              {net < 0 ? "−" : ""}${Math.abs(net).toFixed(2)}
            </span>
          }
          sub={<span className="muted">est. rev @ ${kpis.estRpm}/1k − spend</span>}
        />
        <Kpi
          lab="Needs review"
          ic={<IconReview />}
          val={<span className="num" style={{ color: "var(--accent-ink)" }}>{kpis.needsReview}</span>}
          sub={<span className="muted">{kpis.pendingScripts} scripts · {kpis.pendingFinals} finals</span>}
        />
      </div>

      <div className="grid cols-3-1">
        <div className="panel">
          <div className="panel-head">
            <h3>Views &amp; spend — 14 days</h3>
          </div>
          <div className="panel-body">
            {data.hasTrend ? (
              <AreaChart id="ovTrend" series={data.viewsSeries} spend={data.spendSeries} />
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                No analytics yet. Connect a channel and publish to see views and spend trend here.
              </p>
            )}
          </div>
        </div>
        <div className="panel attn-panel">
          <div className="panel-head">
            <h3>Needs your attention</h3>
            <Link href="/gates">View all</Link>
          </div>
          <div className="panel-body flush">
            {data.attention.length === 0 ? (
              <p className="muted" style={{ padding: 16, margin: 0 }}>
                Nothing needs you right now.
              </p>
            ) : (
              data.attention.map((a, i) => <AttentionRow key={i} a={a} />)
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <PipelineHealth pipeline={data.pipeline} />
        <UpcomingPublishes items={upcoming} />
      </div>

      <div style={{ marginTop: 16 }}>
        <TopVideos videos={topVideos} />
      </div>

      <div className="page-head" style={{ margin: "22px 0 0" }}>
        <h2 style={{ margin: 0 }}>Channels</h2>
        <Link href="/channels" className="link-more">
          See all <IconChevronRight />
        </Link>
      </div>
      <div className="chan-grid" style={{ marginTop: 14 }}>
        {data.cards.map((c) => (
          <ChannelSummaryCard key={c.id} c={c} />
        ))}
      </div>
    </>
  );
}

function AttentionRow({ a }: { a: AttentionItem }) {
  const color = a.severity === "crit" ? "var(--crit)" : a.severity === "warn" ? "var(--warn)" : "var(--accent)";
  return (
    <Link href={a.href} className="att">
      <span className="stripe" style={{ background: color }} />
      <span className="t">
        <b>{a.title}</b>
        <small>{a.sub}</small>
      </span>
      <span className="when">{fmtWhen(a.when)}</span>
    </Link>
  );
}

function PipelineHealth({ pipeline }: { pipeline: { stage: string; waiting: boolean; count: number }[] }) {
  const total = pipeline.reduce((a, p) => a + p.count, 0);
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Pipeline health</h3>
        <span className="num muted">{total} in flight</span>
      </div>
      <div className="panel-body flush">
        {pipeline.length === 0 ? (
          <p className="muted" style={{ padding: 16, margin: 0 }}>
            Nothing in production right now.
          </p>
        ) : (
          pipeline.map((p) => (
            <div key={p.stage} className="pl-row">
              <span className="pl-stage">
                <span className="pl-dot" style={{ background: p.waiting ? "var(--warn)" : "var(--accent)" }} />
                {p.stage}
                {p.waiting ? <span className="muted" style={{ fontSize: 11 }}>waiting on you</span> : null}
              </span>
              <span className="num">{p.count}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function fmtUpcoming(d: Date): string {
  const mins = Math.round((d.getTime() - Date.now()) / 60000);
  if (mins < 60) return `in ${Math.max(1, mins)}m`;
  const h = Math.round(mins / 60);
  if (h < 24) return `in ${h}h`;
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function UpcomingPublishes({ items }: { items: CalItem[] }) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Upcoming publishes</h3>
        <Link href="/?tab=schedule">Calendar</Link>
      </div>
      <div className="panel-body flush">
        {items.length === 0 ? (
          <p className="muted" style={{ padding: 16, margin: 0 }}>
            Nothing scheduled. Greenlight and schedule videos to fill the calendar.
          </p>
        ) : (
          items.map((it, i) => {
            const body = (
              <>
                <span className="stripe" style={{ background: it.tentative ? "var(--muted)" : "var(--accent)" }} />
                <span className="t">
                  <b>{it.title}</b>
                  <small>
                    {it.channelName} · {it.format === "long" ? "Long-form" : "Short"}
                    {it.tentative ? " · tentative" : ""}
                  </small>
                </span>
                <span className="when">{fmtUpcoming(new Date(it.at))}</span>
              </>
            );
            return it.productionId ? (
              <Link key={i} href={`/productions/${it.productionId}`} className="att">
                {body}
              </Link>
            ) : (
              <div key={i} className="att" style={{ cursor: "default" }}>
                {body}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function ChannelSummaryCard({ c }: { c: ChannelCard }) {
  return (
    <Link href={`/channels/${c.id}`} className="chan">
      <div className="ch-top">
        <span
          className="thumb"
          style={{ width: 40, height: 40, background: c.avatarKey ? "var(--surface-2)" : GRAD, overflow: "hidden" }}
        >
          {c.avatarKey ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/media/${c.avatarKey}`}
              alt=""
              width={40}
              height={40}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : (
            <IconPlay className="" />
          )}
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="ch-name">{c.name}</div>
          <div className="ch-niche">{c.niche}</div>
        </div>
      </div>
      <div style={{ padding: "0 15px 6px" }}>
        <Sparkline id={`sp-${c.id}`} data={c.spark} w={250} h={34} />
      </div>
      <div className="ch-meta">
        <div className="m">
          <div className="mv">{fmtNum(c.views30)}</div>
          <div className="ml">views 30d</div>
        </div>
        <div className="m">
          <div className="mv">{c.retention != null ? `${Math.round(c.retention)}%` : "—"}</div>
          <div className="ml">retention</div>
        </div>
        <div className="m">
          <div className="mv">{c.published7}</div>
          <div className="ml">posted 7d</div>
        </div>
      </div>
      <div className="ch-substats">
        <span>
          <b>{c.totalPublished}</b> published
        </span>
        <span>
          <b>{c.scheduled}</b> scheduled
        </span>
        <span>
          <b>{c.inPipeline}</b> in pipeline
        </span>
      </div>
      <div className="ch-foot">
        <span className="chip">{tierLabel(c.tier).split(" ")[0]}</span>
        <span className={`chip ${c.status === "active" ? "good" : "warn"}`}>
          <span className="d" />
          {channelStatusLabel(c.status)}
        </span>
        <span className="num" style={{ fontSize: 12, color: "var(--muted)", marginLeft: "auto" }}>
          ${c.costWeek.toFixed(2)}/wk
        </span>
      </div>
    </Link>
  );
}

function AnalyticsTab({ data }: { data: Awaited<ReturnType<typeof loadPortfolio>> }) {
  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h3>Portfolio views — 14 days</h3>
        </div>
        <div className="panel-body">
          {data.hasTrend ? (
            <AreaChart id="anTrend" series={data.viewsSeries} />
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              No analytics snapshots yet. Once channels are connected and the analytics ingestion runs, per-channel
              retention and views land here.
            </p>
          )}
        </div>
      </div>
      <div className="panel">
        <div className="panel-head">
          <h3>Retention by channel</h3>
        </div>
        <div className="panel-body">
          {data.cards.filter((c) => c.retention != null).length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              No retention data yet.
            </p>
          ) : (
            data.cards
              .filter((c) => c.retention != null)
              .map((c) => (
                <div key={c.id} className="tbar">
                  <span className="tn">{c.name}</span>
                  <span className="track">
                    <span className="fill" style={{ width: `${Math.min(100, c.retention ?? 0)}%` }} />
                  </span>
                  <span className="tv">{Math.round(c.retention ?? 0)}%</span>
                </div>
              ))
          )}
        </div>
      </div>
    </>
  );
}

async function CostsTab() {
  const { db } = await getAppContext();
  const byChannel = await db
    .select({
      channelId: costRecords.channelId,
      category: costRecords.category,
      total: sql<string>`sum(${costRecords.costUsd})`,
    })
    .from(costRecords)
    .groupBy(costRecords.channelId, costRecords.category);
  const allChannels = await db.select().from(channels);
  const channelName = new Map(allChannels.map((c) => [c.id, c.name]));

  const categories = ["llm", "voice", "media", "render", "publish", "research"] as const;
  const channelTotals = new Map<string, Record<string, number>>();
  for (const row of byChannel) {
    const rec = channelTotals.get(row.channelId) ?? {};
    rec[row.category] = Number(row.total);
    channelTotals.set(row.channelId, rec);
  }
  const grand = [...channelTotals.values()].reduce((a, cats) => a + Object.values(cats).reduce((x, y) => x + y, 0), 0);

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Spend by channel &amp; category</h3>
        <span className="num muted">{fmtMoney(grand)} total</span>
      </div>
      <div className="panel-body flush">
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Channel</th>
                {categories.map((c) => (
                  <th key={c} className="r">
                    {costCategoryLabel(c)}
                  </th>
                ))}
                <th className="r">Total</th>
              </tr>
            </thead>
            <tbody>
              {channelTotals.size === 0 ? (
                <tr>
                  <td colSpan={categories.length + 2} className="muted" style={{ textAlign: "center", padding: 20 }}>
                    No spend recorded yet.
                  </td>
                </tr>
              ) : (
                [...channelTotals.entries()].map(([channelId, cats]) => {
                  const total = Object.values(cats).reduce((a, b) => a + b, 0);
                  return (
                    <tr key={channelId}>
                      <td>{channelName.get(channelId) ?? channelId}</td>
                      {categories.map((c) => (
                        <td key={c} className="r">
                          {cats[c] ? <span className="num">{fmtMoney(cats[c])}</span> : <span className="muted">—</span>}
                        </td>
                      ))}
                      <td className="r">
                        <span className="num" style={{ fontWeight: 650 }}>
                          {fmtMoney(total)}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

