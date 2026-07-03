import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { channels, ideas, productions, reviewGates } from "@ytauto/db";
import { getAppContext } from "@/lib/context";

export const dynamic = "force-dynamic";

export default async function GatesPage() {
  const { db } = getAppContext();
  const pending = await db
    .select({
      gate: reviewGates,
      production: productions,
      idea: ideas,
      channel: channels,
    })
    .from(reviewGates)
    .innerJoin(productions, eq(reviewGates.productionId, productions.id))
    .innerJoin(ideas, eq(productions.ideaId, ideas.id))
    .innerJoin(channels, eq(productions.channelId, channels.id))
    .where(eq(reviewGates.status, "pending"))
    .orderBy(desc(reviewGates.createdAt));

  return (
    <div>
      <h1>Review gates</h1>
      {pending.length === 0 ? (
        <p className="muted">Nothing waiting for review. Greenlight an idea to start a production.</p>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Gate</th>
              <th>Video</th>
              <th>Channel</th>
              <th>Waiting since</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {pending.map(({ gate, idea, channel }) => (
              <tr key={gate.id}>
                <td>
                  <span className={`badge ${gate.kind === "script_review" ? "amber" : "accent"}`}>
                    {gate.kind === "script_review" ? "script" : "final review"}
                  </span>
                </td>
                <td>
                  <Link href={`/productions/${gate.productionId}`}>{idea.title}</Link>
                </td>
                <td>{channel.name}</td>
                <td className="muted">{gate.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                <td>
                  <Link className="btn" href={`/productions/${gate.productionId}`}>
                    Review
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
