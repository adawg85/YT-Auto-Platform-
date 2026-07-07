import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { channels, ideas, productions, reviewGates } from "@ytauto/db";
import { getAppContext } from "@/lib/context";
import { Badge, ButtonLink, DataTable, EmptyState } from "@/components/ui";
import { IconPlay, IconReview } from "@/components/icons";
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
        <EmptyState
          icon={<IconReview />}
          title="Queue clear"
          description="Nothing waiting for review. Greenlight an idea to start a production."
          action={<ButtonLink href="/ideas" variant="secondary">Go to ideas</ButtonLink>}
        />
      )}

      {scripts.length > 0 && (
        <>
          <h2>Scripts — batch review ({scripts.length})</h2>
          {scripts.map(({ gate, idea, channel }) => {
            const snap = gate.payloadSnapshot as {
              hookText?: string;
              fullText?: string;
              citations?: {
                claimId: string;
                text: string;
                tier: string;
                sources: { url: string; title: string; domain: string }[];
              }[];
            } | null;
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
                    {idea.fastTrack && <Badge tone="accent">fast lane</Badge>}
                    {snap?.hookText && (
                      <p style={{ margin: "0.4rem 0 0" }}>
                        <Badge tone="warn">hook</Badge> {snap.hookText}
                      </p>
                    )}
                    {snap?.fullText && (
                      <details style={{ marginTop: "0.4rem" }}>
                        <summary className="muted">full script</summary>
                        <p className="muted">{snap.fullText}</p>
                      </details>
                    )}
                    {snap?.citations && snap.citations.length > 0 && (
                      <details style={{ marginTop: "0.4rem" }}>
                        <summary className="muted">
                          sources — {snap.citations.length} verified/attributed claim
                          {snap.citations.length === 1 ? "" : "s"}
                        </summary>
                        <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.1rem" }}>
                          {snap.citations.map((c) => (
                            <li key={c.claimId} style={{ marginBottom: "0.35rem" }}>
                              <Badge tone={c.tier === "established" ? "good" : "warn"}>
                                {c.tier === "established" ? "verified" : "attributed"}
                              </Badge>{" "}
                              {c.text}{" "}
                              <span className="muted">
                                {c.sources.map((s, i) => (
                                  <span key={s.url}>
                                    {i > 0 && " · "}
                                    <a href={s.url} target="_blank" rel="noreferrer">
                                      {s.domain}
                                    </a>
                                  </span>
                                ))}
                              </span>
                            </li>
                          ))}
                        </ul>
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
          <DataTable>
            <tbody>
              {finals.map(({ gate, idea, channel }) => (
                <tr key={gate.id}>
                  <td>
                    <Link href={`/productions/${gate.productionId}`}>{idea.title}</Link>
                  </td>
                  <td>{channel.name}</td>
                  <td className="muted">{gate.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                  <td>
                    <ButtonLink href={`/productions/${gate.productionId}`} size="sm" icon={<IconPlay />}>
                      Review
                    </ButtonLink>
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </>
      )}
    </div>
  );
}
