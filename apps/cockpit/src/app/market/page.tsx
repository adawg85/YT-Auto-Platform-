import Link from "next/link";
import type { PatternRow } from "@ytauto/core";
import { loadMarketIntel, displayScore, type NicheIntel } from "@/lib/market";
import { fmtNum, fmtWhen } from "@/lib/format";
import { IconTrend, IconSparkle } from "@/components/icons";
import { runMarketScanNowAction, seedIdeaFromPatternAction } from "./actions";

export const dynamic = "force-dynamic";

const SOURCE_LABEL: Record<string, string> = {
  outlier: "outlier",
  breakout: "breakout",
  trending: "trending",
};

export default async function MarketPage() {
  const intel = await loadMarketIntel();

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title" style={{ margin: 0 }}>
            <IconTrend /> Market intel
          </h1>
          <p className="page-sub">
            What&apos;s working across the market — scouted external content analysed into the shared
            pattern store, merged with your own results.
          </p>
        </div>
        <form action={runMarketScanNowAction.bind(null, undefined)} className="inline">
          <button type="submit">⟳ Run market scan</button>
        </form>
      </div>

      <div className="kpis" style={{ marginBottom: 20 }}>
        <Kpi lab="Niches tracked" val={intel.totals.niches} />
        <Kpi lab="Patterns learned" val={intel.totals.patterns} />
        <Kpi lab="External videos scouted" val={intel.totals.external} />
      </div>

      {intel.niches.length === 0 ? (
        <div className="panel">
          <div className="panel-body">
            <p className="muted" style={{ margin: 0 }}>
              No channels yet, so there are no niches to scout. Add a channel, then run a market scan —
              the meta-analysis engine pulls down over-performing competitor content and analyses it
              into hook patterns, script structures and rising topic signals.
            </p>
          </div>
        </div>
      ) : (
        intel.niches.map((n) => <NicheBlock key={n.niche} n={n} />)
      )}
    </>
  );
}

function Kpi({ lab, val }: { lab: string; val: React.ReactNode }) {
  return (
    <div className="kpi">
      <div className="lab">{lab}</div>
      <div className="val">
        <span className="num">{val}</span>
      </div>
    </div>
  );
}

function NicheBlock({ n }: { n: NicheIntel }) {
  const empty = n.topics.length === 0 && n.hooks.length === 0 && n.structures.length === 0;
  return (
    <div style={{ marginBottom: 26 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>{n.niche}</h2>
        <span className="muted">
          {n.externalCount} scouted · {n.analysedCount} analysed
          {n.lastCaptured ? ` · updated ${fmtWhen(n.lastCaptured)} ago` : ""}
        </span>
      </div>

      {empty ? (
        <div className="panel">
          <div className="panel-body">
            <p className="muted" style={{ margin: 0 }}>
              No patterns for this niche yet. Run a market scan to populate it.
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="panel">
            <div className="panel-head">
              <h3>
                <IconTrend /> Rising angles
              </h3>
              <span className="muted">borrow a signal to seed an idea</span>
            </div>
            <div className="panel-body flush">
              {n.topics.length === 0 ? (
                <p className="muted" style={{ padding: 16, margin: 0 }}>
                  No topic signals yet.
                </p>
              ) : (
                <table className="data" style={{ border: "none", borderRadius: 0 }}>
                  <thead>
                    <tr>
                      <th>Angle</th>
                      <th>Momentum</th>
                      <th>Seen in</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {n.topics.map((t) => {
                      const angle = (t.detail?.angle as string) ?? t.label;
                      return (
                        <tr key={t.id}>
                          <td>
                            <b>{t.label}</b>
                            <div className="muted" style={{ fontSize: 12 }}>
                              {angle}
                            </div>
                          </td>
                          <td className="num">{displayScore(t)}</td>
                          <td className="num muted">{t.observations}</td>
                          <td>
                            <form
                              action={seedIdeaFromPatternAction.bind(null, {
                                niche: n.niche,
                                label: t.label,
                                angle,
                              })}
                            >
                              <button className="secondary" type="submit">
                                <IconSparkle /> Seed idea
                              </button>
                            </form>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <div className="grid grid-2" style={{ marginTop: 16 }}>
            <PatternPanel title="Breakout hook patterns" rows={n.hooks} kind="hook" />
            <PatternPanel title="Top script structures" rows={n.structures} kind="structure" />
          </div>

          {n.topExternal.length > 0 && (
            <div className="panel">
              <div className="panel-head">
                <h3>Scouted videos</h3>
                <span className="muted">the external content behind these patterns</span>
              </div>
              <div className="panel-body flush">
                <table className="data" style={{ border: "none", borderRadius: 0 }}>
                  <tbody>
                    {n.topExternal.map((e) => (
                      <tr key={e.id}>
                        <td>
                          {e.url ? (
                            <a href={e.url} target="_blank" rel="noreferrer">
                              {e.title}
                            </a>
                          ) : (
                            e.title
                          )}
                          <div className="muted" style={{ fontSize: 12 }}>
                            {e.channelName}
                          </div>
                        </td>
                        <td>
                          <span className="chip">{SOURCE_LABEL[e.source] ?? e.source}</span>
                        </td>
                        <td className="num muted">{fmtNum(e.views)} views</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PatternPanel({
  title,
  rows,
  kind,
}: {
  title: string;
  rows: PatternRow[];
  kind: "hook" | "structure";
}) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>{title}</h3>
      </div>
      <div className="panel-body flush">
        {rows.length === 0 ? (
          <p className="muted" style={{ padding: 16, margin: 0 }}>
            None yet.
          </p>
        ) : (
          <table className="data" style={{ border: "none", borderRadius: 0 }}>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className="mono">{r.label}</span>
                    {kind === "hook" && r.detail?.opener ? (
                      <div className="muted" style={{ fontSize: 12 }}>
                        {r.detail.opener as string}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <span className={`chip ${r.source === "external" ? "" : "acc"}`}>{r.source}</span>
                  </td>
                  <td className="num muted">score {displayScore(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
