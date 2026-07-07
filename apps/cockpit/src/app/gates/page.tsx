import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { channels, ideas, productions, reviewGates } from "@ytauto/db";
import { getAppContext } from "@/lib/context";
import { BatchDecide } from "./batch-row";
import { IconCheck, IconChevronRight, IconZap } from "@/components/icons";
import { fmtDateTime } from "@/lib/format";

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
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Review</h1>
          <p className="page-sub">
            {pending.length === 0
              ? "Everything you need to approve, in one queue."
              : `${scripts.length} script${scripts.length === 1 ? "" : "s"} and ${finals.length} final cut${finals.length === 1 ? "" : "s"} waiting on you.`}
          </p>
        </div>
      </div>

      {pending.length === 0 && (
        <div className="panel">
          <div className="placeholder">
            <div className="pic">
              <IconCheck />
            </div>
            <h2>All clear</h2>
            <p>
              Nothing is waiting for review. Greenlight an idea on the{" "}
              <Link href="/ideas" style={{ color: "var(--accent-ink)", fontWeight: 600 }}>
                Ideas
              </Link>{" "}
              page to start a new production.
            </p>
          </div>
        </div>
      )}

      {scripts.length > 0 && (
        <>
          <h2>Scripts</h2>
          {scripts.map(({ gate, idea, channel }) => {
            const snap = gate.payloadSnapshot as { hookText?: string; fullText?: string } | null;
            return (
              <div className="card" key={gate.id}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 300 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <Link href={`/productions/${gate.productionId}`} style={{ fontWeight: 650 }}>
                        {idea.title}
                      </Link>
                      <span className="muted" style={{ fontSize: 12.5 }}>
                        {channel.name}
                      </span>
                      {idea.fastTrack && (
                        <span className="chip acc">
                          <IconZap /> Fast lane
                        </span>
                      )}
                    </div>
                    {snap?.hookText && (
                      <p style={{ margin: "8px 0 0", fontSize: 13.5 }}>
                        <span className="chip warn" style={{ marginRight: 7 }}>
                          Hook
                        </span>
                        {snap.hookText}
                      </p>
                    )}
                    {snap?.fullText && (
                      <details style={{ marginTop: 8 }}>
                        <summary className="muted" style={{ cursor: "pointer", fontSize: 12.5 }}>
                          Read the full script
                        </summary>
                        <p className="muted" style={{ marginBottom: 0 }}>{snap.fullText}</p>
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
          <h2>Final cuts — watch &amp; pick a thumbnail</h2>
          <table className="data">
            <thead>
              <tr>
                <th>Video</th>
                <th>Channel</th>
                <th>Waiting since</th>
                <th style={{ width: 150 }} />
              </tr>
            </thead>
            <tbody>
              {finals.map(({ gate, idea, channel }) => (
                <tr key={gate.id}>
                  <td>
                    <Link href={`/productions/${gate.productionId}`} style={{ fontWeight: 600 }}>
                      {idea.title}
                    </Link>
                  </td>
                  <td>{channel.name}</td>
                  <td className="muted">{fmtDateTime(gate.createdAt)}</td>
                  <td style={{ textAlign: "right" }}>
                    <Link className="btn ghost sm" href={`/productions/${gate.productionId}`}>
                      Open review <IconChevronRight />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
