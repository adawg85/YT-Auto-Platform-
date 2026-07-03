import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { channelDna, channels, ideas, productions } from "@ytauto/db";
import { getAppContext } from "@/lib/context";

export const dynamic = "force-dynamic";

export default async function ChannelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { db } = await getAppContext();
  const [channel] = await db.select().from(channels).where(eq(channels.id, id));
  if (!channel) notFound();
  const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, id));
  const recent = await db
    .select({ production: productions, idea: ideas })
    .from(productions)
    .innerJoin(ideas, eq(productions.ideaId, ideas.id))
    .where(eq(productions.channelId, id))
    .orderBy(desc(productions.createdAt))
    .limit(20);

  return (
    <div>
      <h1>{channel.name}</h1>
      <p className="muted">
        {channel.handle} · {channel.niche}
      </p>

      {dna && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Channel DNA</h2>
          <table className="data">
            <tbody>
              <tr>
                <td className="muted">Tone</td>
                <td>{dna.tone}</td>
              </tr>
              <tr>
                <td className="muted">Audience</td>
                <td>{dna.audiencePersona}</td>
              </tr>
              <tr>
                <td className="muted">Hook styles</td>
                <td>{dna.hookStyles.join(", ")}</td>
              </tr>
              <tr>
                <td className="muted">Forbidden topics</td>
                <td>{dna.forbiddenTopics.join(", ") || "none"}</td>
              </tr>
              <tr>
                <td className="muted">Visual style</td>
                <td>
                  {dna.visualStyle.imageStyle}{" "}
                  <span className="badge" style={{ background: dna.visualStyle.primaryColor, color: "#000" }}>
                    {dna.visualStyle.primaryColor}
                  </span>
                </td>
              </tr>
              <tr>
                <td className="muted">Voice / CTA</td>
                <td>
                  {dna.voiceId} · “{dna.ctaTemplate}”
                </td>
              </tr>
              <tr>
                <td className="muted">Target length / cadence</td>
                <td>
                  ~{dna.targetLengthSec}s · {dna.cadencePerWeek}/week
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <h2>Recent productions</h2>
      {recent.length === 0 ? (
        <p className="muted">
          None yet — <Link href="/ideas">greenlight an idea</Link>.
        </p>
      ) : (
        <table className="data">
          <tbody>
            {recent.map(({ production, idea }) => (
              <tr key={production.id}>
                <td>
                  <Link href={`/productions/${production.id}`}>{idea.title}</Link>
                </td>
                <td>
                  <span className="badge">{production.status}</span>
                </td>
                <td className="muted">
                  {production.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
