import Link from "next/link";
import { sql } from "drizzle-orm";
import { channels, costRecords } from "@ytauto/db";
import { getAppContext } from "@/lib/context";
import { loadPortfolio, tierLabel, type AttentionItem, type ChannelCard } from "@/lib/overview";
import { fmtNum, fmtWhen } from "@/lib/format";
import { PageTabs, type Tab } from "@/components/page-tabs";
import { AreaChart, Sparkline } from "@/components/charts";
import { Badge, ButtonLink, EmptyState, StatGrid, StatTile } from "@/components/ui";
import { IconPlus, IconPlay, IconCheck } from "@/components/icons";

export const dynamic = "force-dynamic";

const GRAD = "linear-gradient(135deg,var(--accent),var(--accent-2))";

export default async function OverviewPage() {
  const data = await loadPortfolio();
  const { kpis } = data;

  const tabs: Tab[] = [
    { key: "overview", label: "Overview", panel: <OverviewTab data={data} /> },
    { key: "analytics", label: "Analytics", panel: <AnalyticsTab data={data} /> },
    { key: "costs", label: "Costs", panel: <CostsTab /> },
    { key: "review", label: "Review", badge: kpis.needsReview || null, panel: <ReviewTab items={data.attention} /> },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Portfolio</h1>
          <p className="page-sub">
            {data.cards.length} channel{data.cards.length === 1 ? "" : "s"} · aggregates across everything
          </p>
        </div>
        <ButtonLink href="/channels/new" icon={<IconPlus />}>
          New channel
        </ButtonLink>
      </div>
      <PageTabs tabs={tabs} />
    </>
  );
}

function OverviewTab({ data }: { data: Awaited<ReturnType<typeof loadPortfolio>> }) {
  const { kpis } = data;
  return (
    <>
      <StatGrid>
        <StatTile label="Views 30d" value={fmtNum(kpis.views30)} />
        <StatTile
          label="Avg retention"
          value={kpis.retention != null ? Math.round(kpis.retention) : "—"}
          unit={kpis.retention != null ? "%" : undefined}
        />
        <StatTile label="Published 7d" value={kpis.published7} />
        <StatTile label="Spend 30d" value={`$${kpis.spend30.toFixed(2)}`} sub="across all channels" />
        <StatTile
          label="Needs review"
          value={<span style={{ color: "var(--accent-ink)" }}>{kpis.needsReview}</span>}
          sub={`${kpis.pendingScripts} scripts · ${kpis.pendingFinals} finals`}
        />
      </StatGrid>

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
        <div className="panel">
          <div className="panel-head">
            <h3>Needs your attention</h3>
            <Link href="/gates">View all</Link>
          </div>
          <div className="panel-body flush">
            {data.attention.length === 0 ? (
              <EmptyState
                icon={<IconCheck />}
                title="All clear"
                description="Nothing is waiting on you right now. New review items will show up here."
              />
            ) : (
              data.attention.map((a, i) => <AttentionRow key={i} a={a} />)
            )}
          </div>
        </div>
      </div>

      <div className="page-head" style={{ margin: "22px 0 0" }}>
        <h2 style={{ margin: 0 }}>Channels</h2>
        <Link href="/channels" style={{ fontSize: 13, color: "var(--accent-ink)", fontWeight: 600 }}>
          See all →
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

function ChannelSummaryCard({ c }: { c: ChannelCard }) {
  return (
    <Link href={`/channels/${c.id}`} className="chan">
      <div className="ch-top">
        <span className="thumb" style={{ width: 40, height: 40, background: GRAD }}>
          <IconPlay className="" />
        </span>
        <div>
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
          <div className="ml">pub 7d</div>
        </div>
      </div>
      <div className="ch-foot">
        <Badge tone="accent">{tierLabel(c.tier).split(" ")[0]}</Badge>
        <Badge tone={c.status === "active" ? "good" : "warn"} dot>
          {c.status}
        </Badge>
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
        <span className="num muted">${grand.toFixed(4)} total</span>
      </div>
      <div className="panel-body flush">
        <table className="data" style={{ border: "none", borderRadius: 0 }}>
          <thead>
            <tr>
              <th>Channel</th>
              {categories.map((c) => (
                <th key={c}>{c}</th>
              ))}
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {channelTotals.size === 0 ? (
              <tr>
                <td colSpan={categories.length + 2} className="muted">
                  No cost records yet.
                </td>
              </tr>
            ) : (
              [...channelTotals.entries()].map(([channelId, cats]) => {
                const total = Object.values(cats).reduce((a, b) => a + b, 0);
                return (
                  <tr key={channelId}>
                    <td>{channelName.get(channelId) ?? channelId}</td>
                    {categories.map((c) => (
                      <td key={c} className="num">
                        {cats[c] ? `$${cats[c].toFixed(4)}` : "—"}
                      </td>
                    ))}
                    <td className="num">
                      <strong>${total.toFixed(4)}</strong>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReviewTab({ items }: { items: AttentionItem[] }) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Review queue &amp; alerts</h3>
        <Link href="/gates">Open review surface</Link>
      </div>
      <div className="panel-body flush">
        {items.length === 0 ? (
          <EmptyState
            icon={<IconCheck />}
            title="Nothing waiting for review"
            description="Scripts and finals that need a decision will appear here as they come in."
          />
        ) : (
          items.map((a, i) => <AttentionRow key={i} a={a} />)
        )}
      </div>
    </div>
  );
}
