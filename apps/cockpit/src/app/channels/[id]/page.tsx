import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { channelDna, channels, ideas, productions, secrets } from "@ytauto/db";
import { channelPerformanceSummary, channelTokenName } from "@ytauto/core";
import { getAppContext } from "@/lib/context";
import { disconnectYouTubeAction, updateChannelAction } from "../actions";
import { ChannelForm } from "../channel-form";

export const dynamic = "force-dynamic";

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

      {connected && (
        <div className="card" style={{ borderColor: "var(--green)" }}>
          <span className="badge green">connected</span> {connected}
        </div>
      )}
      {error && (
        <div className="card" style={{ borderColor: "var(--red)" }}>
          <span className="badge red">error</span> {error}
        </div>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>YouTube connection</h2>
        {token ? (
          <p>
            <span className="badge green">connected</span>{" "}
            {channel.youtubeChannelId ? (
              <a href={`https://www.youtube.com/channel/${channel.youtubeChannelId}`}>
                {channel.youtubeChannelId}
              </a>
            ) : (
              <span className="muted">channel id unknown</span>
            )}{" "}
            · encrypted refresh token stored{" "}
            <span className="mono muted">····{token.last4}</span>
          </p>
        ) : (
          <p>
            <span className="badge">not connected</span>{" "}
            <span className="muted">
              Uploads for this channel fall back to the global YOUTUBE_REFRESH_TOKEN (or the
              mock publisher if none).
            </span>
          </p>
        )}
        <div>
          <a className="btn" href={`/api/oauth/youtube/start?channelId=${id}`}>
            {token ? "Reconnect" : "Connect"} YouTube
          </a>{" "}
          {token && (
            <form className="inline" action={disconnectYouTubeAction.bind(null, id)}>
              <button className="danger" type="submit">
                Disconnect
              </button>
            </form>
          )}
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Requires the YouTube OAuth client ID/secret on the <Link href="/account">Account</Link>{" "}
          page. Add <span className="mono">…/api/oauth/youtube/callback</span> as an authorized
          redirect URI in the GCP console.
        </p>
      </div>

      {perf.publishedCount > 0 && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Performance</h2>
          <p>
            {perf.summaryText}
            {perf.avgViewPct !== null && (
              <>
                {" "}
                Avg watched duration:{" "}
                <strong>{perf.avgViewDurationSec?.toFixed(0) ?? "?"}s</strong>.
              </>
            )}
          </p>
          {perf.suggestedLengthSec !== null &&
            perf.suggestedLengthSec !== dna?.targetLengthSec && (
              <p className="muted">
                💡 Retention suggests a target length of ~
                <strong>{perf.suggestedLengthSec}s</strong> (currently {dna?.targetLengthSec}s) —
                adjust below if you agree. Length is instrumented, not fixed.
              </p>
            )}
        </div>
      )}

      <h2>Settings & DNA</h2>
      <ChannelForm
        action={updateChannelAction.bind(null, id)}
        channel={channel}
        dna={dna}
        submitLabel="Save changes"
      />

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
