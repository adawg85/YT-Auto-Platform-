import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { channels, ideas, productions, reviewGates } from "@ytauto/db";
import { getAppContext } from "@/lib/context";
import { BatchDecide } from "./batch-row";

export const dynamic = "force-dynamic";

export default async function GatesPage() {
  const { db } = await getAppContext();
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

  const scripts = pending.filter((p) => p.gate.kind === "script_review");
  const finals = pending.filter((p) => p.gate.kind !== "script_review");

  return (
    <div>
      <h1>Review gates</h1>
      {pending.length === 0 && (
        <p className="muted">Nothing waiting for review. Greenlight an idea to start a production.</p>
      )}

      {scripts.length > 0 && (
        <>
          <h2>Scripts — batch review ({scripts.length})</h2>
          {scripts.map(({ gate, idea, channel }) => {
            const snap = gate.payloadSnapshot as { hookText?: string; fullText?: string } | null;
            return (
              <div className="card" key={gate.id}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 300 }}>
                    <strong>
                      <Link href={`/productions/${gate.productionId}`}>{idea.title}</Link>
                    </strong>{" "}
                    <span className="muted">
                      {channel.name}
                      {idea.fastTrack ? " · " : ""}
                    </span>
                    {idea.fastTrack && <span className="badge accent">⚡ fast lane</span>}
                    {snap?.hookText && (
                      <p style={{ margin: "0.4rem 0 0" }}>
                        <span className="badge amber">hook</span> {snap.hookText}
                      </p>
                    )}
                    {snap?.fullText && (
                      <details style={{ marginTop: "0.4rem" }}>
                        <summary className="muted">full script</summary>
                        <p className="muted">{snap.fullText}</p>
                      </details>
                    )}
                  </div>
                  <BatchDecide gateId={gate.id} />
                </div>
              </div>
            );
          })}
        </>
      )}

      {finals.length > 0 && (
        <>
          <h2>Final review — watch &amp; pick thumbnail ({finals.length})</h2>
          <table className="data">
            <tbody>
              {finals.map(({ gate, idea, channel }) => (
                <tr key={gate.id}>
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
        </>
      )}
    </div>
  );
}
