import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { channels, ideas, scores } from "@ytauto/db";
import { getAppContext } from "@/lib/context";
import { Badge, Button, Card, DataTable, EmptyState } from "@/components/ui";
import { IconLightbulb, IconPlay, IconSparkle, IconTrend } from "@/components/icons";
import { generateIdeasAction, greenlightAction, scanTrendsAction, scoreIdeaAction } from "../actions";

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
      <Card>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {allChannels.map((c) => (
            <form key={c.id} action={generateIdeasAction.bind(null, c.id)}>
              <Button type="submit" size="sm" icon={<IconSparkle />}>
                Generate ideas — {c.name}
              </Button>
            </form>
          ))}
          <form action={scanTrendsAction}>
            <Button type="submit" variant="secondary" size="sm" icon={<IconTrend />}>
              Scan trends (fast lane)
            </Button>
          </form>
        </div>
      </Card>

      {rows.length === 0 ? (
        <EmptyState
          icon={<IconLightbulb />}
          title="No ideas yet"
          description="Generate ideas for a channel or scan trends to start filling the funnel."
        />
      ) : (
        <DataTable>
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
                    <strong>{idea.title}</strong> {idea.fastTrack && <Badge tone="accent">fast lane</Badge>}
                    <div className="muted">{idea.angle}</div>
                  </td>
                  <td>{channel.name}</td>
                  <td>
                    <Badge>{idea.sourceType}</Badge>
                  </td>
                  <td>
                    <Badge
                      tone={idea.status === "greenlit" ? "good" : idea.status === "scored" ? "accent" : "neutral"}
                      dot={idea.status === "greenlit"}
                    >
                      {idea.status}
                    </Badge>
                  </td>
                  <td>
                    {score ? <strong>{score.weightedTotal.toFixed(1)}</strong> : <span className="muted">—</span>}
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {idea.status === "inbox" && (
                        <form action={scoreIdeaAction.bind(null, idea.id)}>
                          <Button type="submit" variant="secondary" size="sm">
                            Score
                          </Button>
                        </form>
                      )}
                      {(idea.status === "scored" || idea.status === "inbox") && (
                        <form action={greenlightAction.bind(null, idea.id)}>
                          <Button type="submit" size="sm" icon={<IconPlay />}>
                            Greenlight
                          </Button>
                        </form>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}
      <p className="muted" style={{ marginTop: "0.75rem" }}>
        Greenlighting creates a production and starts the durable pipeline — watch it on{" "}
        <Link href="/gates">Gates</Link>.
      </p>
    </div>
  );
}
