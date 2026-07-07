import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { channels, ideas, scores } from "@ytauto/db";
import { getAppContext } from "@/lib/context";
import { generateIdeasFormAction, greenlightAction, scanTrendsAction, scoreIdeaAction } from "../actions";
import { IconSparkle, IconZap, IconPlay, IconInbox } from "@/components/icons";
import { ideaSourceLabel, ideaStatusLabel } from "@/lib/format";

export const dynamic = "force-dynamic";

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

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Ideas</h1>
          <p className="page-sub">Every video starts here — generate, score, then greenlight into production.</p>
        </div>
      </div>

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
                    <td className="r">{score ? <strong>{score.weightedTotal.toFixed(1)}</strong> : <span className="muted">—</span>}</td>
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
