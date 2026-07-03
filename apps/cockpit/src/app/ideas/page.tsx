import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { channels, ideas, scores } from "@ytauto/db";
import { getAppContext } from "@/lib/context";
import { generateIdeasAction, greenlightAction, scoreIdeaAction } from "../actions";

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
    <div>
      <h1>Idea backlog</h1>
      <div className="card">
        {allChannels.map((c) => (
          <form key={c.id} className="inline" action={generateIdeasAction.bind(null, c.id)}>
            <button type="submit">✨ Generate ideas — {c.name}</button>
          </form>
        ))}
      </div>
      <table className="data">
        <thead>
          <tr>
            <th>Idea</th>
            <th>Channel</th>
            <th>Source</th>
            <th>Status</th>
            <th>Score</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ idea, channel }) => {
            const score = scoreByIdea.get(idea.id);
            return (
              <tr key={idea.id}>
                <td>
                  <strong>{idea.title}</strong>
                  <div className="muted">{idea.angle}</div>
                </td>
                <td>{channel.name}</td>
                <td>
                  <span className="badge">{idea.sourceType}</span>
                </td>
                <td>
                  <span
                    className={`badge ${idea.status === "greenlit" ? "green" : idea.status === "scored" ? "accent" : ""}`}
                  >
                    {idea.status}
                  </span>
                </td>
                <td>{score ? <strong>{score.weightedTotal.toFixed(1)}</strong> : <span className="muted">—</span>}</td>
                <td>
                  {idea.status === "inbox" && (
                    <form className="inline" action={scoreIdeaAction.bind(null, idea.id)}>
                      <button className="secondary" type="submit">
                        Score
                      </button>
                    </form>
                  )}
                  {(idea.status === "scored" || idea.status === "inbox") && (
                    <form className="inline" action={greenlightAction.bind(null, idea.id)}>
                      <button type="submit">Greenlight ▶</button>
                    </form>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted" style={{ marginTop: "0.75rem" }}>
        Greenlighting creates a production and starts the durable pipeline — watch it on{" "}
        <Link href="/gates">Gates</Link>.
      </p>
    </div>
  );
}
