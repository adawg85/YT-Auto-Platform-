import Link from "next/link";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { channels, ideas, marketOpportunities, scores } from "@ytauto/db";
import { getAppContext } from "@/lib/context";
import { generateIdeasFormAction, greenlightAction, scanTrendsAction, scoreIdeaAction } from "../actions";
import { runMarketScanNowAction } from "../market/actions";
import {
  seedOpportunityIdeaAction,
  setOpportunityStatusAction,
  startChannelFromOpportunityAction,
} from "./opportunity-actions";
import { IconSparkle, IconZap, IconPlay, IconInbox, IconTrend } from "@/components/icons";
import { ideaSourceLabel, ideaStatusLabel } from "@/lib/format";

export const dynamic = "force-dynamic";

const OPP_KIND_META: Record<string, { title: string; hint: string }> = {
  niche: { title: "New niches trending", hint: "territories with no channel in the portfolio yet" },
  topic: { title: "Topic waves", hint: "cross-market topics an existing channel could ride" },
  style: { title: "Styles working now", hint: "formats over-performing across niches" },
};

export default async function IdeasPage() {
  const { db } = await getAppContext();
  const allChannels = await db.select().from(channels);
  const rows = await db
    .select({ idea: ideas, channel: channels })
    .from(ideas)
    .innerJoin(channels, eq(ideas.channelId, channels.id))
    .orderBy(desc(ideas.createdAt))
    .limit(100);
  const allScores = await db.select().from(scores).orderBy(desc(scores.createdAt));
  const scoreByIdea = new Map<string, (typeof allScores)[number]>();
  for (const s of allScores) if (!scoreByIdea.has(s.ideaId)) scoreByIdea.set(s.ideaId, s);
  // BACKLOG #22: portfolio-level opportunities lead the page
  const opportunities = await db
    .select()
    .from(marketOpportunities)
    .where(inArray(marketOpportunities.status, ["new", "shortlisted"]))
    .orderBy(desc(marketOpportunities.momentum), asc(marketOpportunities.label))
    .limit(24);
  const oppsByKind = { niche: [] as typeof opportunities, topic: [] as typeof opportunities, style: [] as typeof opportunities };
  for (const o of opportunities) oppsByKind[o.kind]?.push(o);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Ideas &amp; opportunities</h1>
          <p className="page-sub">
            What the market is telling us — new niches, topic waves, working styles — then every channel&apos;s
            story ideas below.
          </p>
        </div>
        <form action={runMarketScanNowAction.bind(null, undefined)}>
          <button type="submit" className="btn ghost">
            <IconTrend /> Run market scan
          </button>
        </form>
      </div>

      {opportunities.length === 0 ? (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-body">
            <p className="muted" style={{ margin: 0 }}>
              No open market opportunities yet — the daily market scan discovers trending new niches, topic waves and
              working styles (or run it now, above).
            </p>
          </div>
        </div>
      ) : (
        <div className="grid grid-3" style={{ alignItems: "start", marginBottom: 16 }}>
          {(Object.keys(OPP_KIND_META) as Array<keyof typeof oppsByKind>).map((kind) => (
            <div className="panel" key={kind} style={{ marginBottom: 0 }}>
              <div className="panel-head">
                <h3>{OPP_KIND_META[kind]!.title}</h3>
                <span className="chip">{oppsByKind[kind].length}</span>
              </div>
              <div className="panel-body" style={{ display: "grid", gap: 12 }}>
                <p className="muted" style={{ margin: 0, fontSize: 12 }}>{OPP_KIND_META[kind]!.hint}</p>
                {oppsByKind[kind].length === 0 && <p className="muted" style={{ margin: 0 }}>None open.</p>}
                {oppsByKind[kind].map((o) => (
                  <div key={o.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                      <strong style={{ textTransform: "capitalize" }}>{o.label}</strong>
                      <span className={`chip ${o.momentum >= 75 ? "good" : ""}`} title="momentum">
                        {o.momentum}
                      </span>
                    </div>
                    <p className="muted" style={{ margin: "4px 0 8px", fontSize: 12.5 }}>{o.summary}</p>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {kind === "niche" && (
                        <form action={startChannelFromOpportunityAction.bind(null, o.id)}>
                          <button className="btn sm" type="submit">Start a channel →</button>
                        </form>
                      )}
                      {kind === "topic" && allChannels.length > 0 && (
                        <form action={seedOpportunityIdeaAction.bind(null, o.id)} style={{ display: "flex", gap: 6 }}>
                          <select name="channelId" className="field" style={{ height: 32, maxWidth: 150 }}>
                            {allChannels.map((c) => (
                              <option key={c.id} value={c.id}>{c.name}</option>
                            ))}
                          </select>
                          <button className="btn sm" type="submit">Seed idea</button>
                        </form>
                      )}
                      {o.status === "new" && (
                        <form action={setOpportunityStatusAction.bind(null, o.id, "shortlisted")}>
                          <button className="btn ghost sm" type="submit">Shortlist</button>
                        </form>
                      )}
                      <form action={setOpportunityStatusAction.bind(null, o.id, "dismissed")}>
                        <button className="btn ghost sm danger-ink" type="submit">Dismiss</button>
                      </form>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <h2 style={{ margin: "18px 0 10px" }}>Story ideas</h2>
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-body">
          <div className="toolbar">
            <form action={generateIdeasFormAction} className="toolbar" style={{ gap: 8 }}>
              <select name="channelId" className="field" style={{ flex: "1 1 170px", maxWidth: 260, height: 36 }}>
                {allChannels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button type="submit" className="btn">
                <IconSparkle /> Generate ideas
              </button>
            </form>
            <form action={scanTrendsAction}>
              <button type="submit" className="btn ghost">
                <IconZap /> Scan trends
              </button>
            </form>
            <span className="hint">
              Generation uses the channel&apos;s DNA and research feed. Trend scans fast-track topical ideas while the
              window is open.
            </span>
          </div>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="panel">
          <div className="placeholder">
            <div className="pic">
              <IconInbox />
            </div>
            <h2>No ideas yet</h2>
            <p>Generate a first batch for a channel above, or add ideas by scanning trends.</p>
          </div>
        </div>
      ) : (
        <div className="tablewrap">
          <table className="data">
            <thead>
              <tr>
                <th>Idea</th>
                <th>Channel</th>
                <th>Source</th>
                <th>Status</th>
                <th className="r">Score</th>
                <th style={{ width: 220 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ idea, channel }) => {
                const score = scoreByIdea.get(idea.id);
                return (
                  <tr key={idea.id}>
                    <td>
                      <strong>{idea.title}</strong>
                      {idea.fastTrack && (
                        <span className="chip acc" style={{ marginLeft: 8 }}>
                          <IconZap /> Fast lane
                        </span>
                      )}
                      <div className="muted">{idea.angle}</div>
                    </td>
                    <td>{channel.name}</td>
                    <td className="muted">{ideaSourceLabel(idea.sourceType)}</td>
                    <td>
                      <span
                        className={`chip ${idea.status === "greenlit" ? "good" : idea.status === "scored" ? "acc" : ""}`}
                      >
                        {ideaStatusLabel(idea.status)}
                      </span>
                    </td>
                    <td className="r">
                      {score ? (
                        <strong
                          style={{ cursor: "help", borderBottom: "1px dotted var(--muted)" }}
                          title={Object.entries(score.rubric as Record<string, { score: number; rationale: string }>)
                            .map(([axis, v]) => `${axis}: ${v.score.toFixed(1)} — ${v.rationale}`)
                            .join("\n")}
                        >
                          {score.weightedTotal.toFixed(1)}
                        </strong>
                      ) : (
                        <span className="muted" title="Scoring runs automatically — this idea is queued.">scoring…</span>
                      )}
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        {idea.status === "inbox" && (
                          <form action={scoreIdeaAction.bind(null, idea.id)}>
                            <button className="btn ghost sm" type="submit">
                              Score
                            </button>
                          </form>
                        )}
                        {(idea.status === "scored" || idea.status === "inbox") && (
                          <form action={greenlightAction.bind(null, idea.id)}>
                            <button className="btn sm" type="submit">
                              <IconPlay className="" /> Greenlight
                            </button>
                          </form>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted" style={{ marginTop: 12, fontSize: 12.5 }}>
        Greenlighting starts the production pipeline for that idea — follow its progress in{" "}
        <Link href="/gates" style={{ color: "var(--accent-ink)", fontWeight: 600 }}>
          Review
        </Link>
        .
      </p>
    </>
  );
}
