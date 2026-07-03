import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, desc, eq } from "drizzle-orm";
import {
  assets,
  channels,
  costRecords,
  ideas,
  productions,
  publications,
  reviewGates,
  scriptDrafts,
} from "@ytauto/db";
import { getAppContext } from "@/lib/context";
import { releasePublicationAction } from "../../actions";
import { GatePanel } from "./gate-panel";

export const dynamic = "force-dynamic";

const STATUS_COLOR: Record<string, string> = {
  published: "green",
  ready: "green",
  rejected: "red",
  failed: "red",
  on_hold: "amber",
  script_review: "amber",
  thumbnail_review: "amber",
};

export default async function ProductionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { db } = await getAppContext();

  const [production] = await db.select().from(productions).where(eq(productions.id, id));
  if (!production) notFound();
  const [idea] = await db.select().from(ideas).where(eq(ideas.id, production.ideaId));
  const [channel] = await db.select().from(channels).where(eq(channels.id, production.channelId));
  const drafts = await db
    .select()
    .from(scriptDrafts)
    .where(eq(scriptDrafts.productionId, id))
    .orderBy(desc(scriptDrafts.version));
  const productionAssets = await db
    .select()
    .from(assets)
    .where(eq(assets.productionId, id))
    .orderBy(asc(assets.kind), asc(assets.idx));
  const gates = await db
    .select()
    .from(reviewGates)
    .where(eq(reviewGates.productionId, id))
    .orderBy(desc(reviewGates.createdAt));
  const pubs = await db.select().from(publications).where(eq(publications.productionId, id));
  const costs = await db
    .select()
    .from(costRecords)
    .where(eq(costRecords.productionId, id))
    .orderBy(asc(costRecords.createdAt));

  const totalCost = costs.reduce((sum, c) => sum + Number(c.costUsd), 0);
  const pendingGate = gates.find((g) => g.status === "pending");
  const render = productionAssets.find((a) => a.kind === "render");
  const voiceover = productionAssets.find((a) => a.kind === "voiceover");
  const images = productionAssets.filter((a) => a.kind === "image");
  const latestDraft = drafts[0];

  return (
    <div>
      <h1>{idea?.title ?? "Production"}</h1>
      <p>
        <span className={`badge ${STATUS_COLOR[production.status] ?? ""}`}>{production.status}</span>{" "}
        <span className="muted">
          {channel?.name} · production <span className="mono">{production.id.slice(-8)}</span> · cost{" "}
          <strong>${totalCost.toFixed(4)}</strong>
        </span>
      </p>
      {production.failureReason && (
        <div className="card">
          <span className="badge amber">held</span> {production.failureReason}
        </div>
      )}

      {pendingGate && (
        <GatePanel
          gateId={pendingGate.id}
          kind={pendingGate.kind}
          snapshot={pendingGate.payloadSnapshot ?? {}}
        />
      )}

      <div className="grid-2">
        <div>
          {render && (
            <>
              <h2>Rendered short</h2>
              <video className="preview" controls src={`/api/media/${render.storageKey}`} />
            </>
          )}
          {voiceover && (
            <>
              <h2>Voiceover</h2>
              <audio controls src={`/api/media/${voiceover.storageKey}`} />
            </>
          )}
          {images.length > 0 && (
            <>
              <h2>Beat visuals</h2>
              <div>
                {images.map((img) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={img.id}
                    className="thumb"
                    style={{ marginRight: 8 }}
                    src={`/api/media/${img.storageKey}`}
                    alt={`beat ${img.idx}`}
                  />
                ))}
              </div>
            </>
          )}
          {pubs.length > 0 && (
            <>
              <h2>Publication</h2>
              {pubs.map((p) => (
                <div className="card" key={p.id}>
                  <a href={p.url}>{p.url}</a>
                  <div className="muted">
                    {p.provider} ·{" "}
                    <span className={`badge ${p.privacyStatus === "public" ? "green" : "amber"}`}>
                      {p.privacyStatus}
                    </span>{" "}
                    · AI disclosure: {p.aiDisclosure ? "yes" : "no"} ·{" "}
                    {p.publishedAt?.toISOString().slice(0, 16).replace("T", " ")}
                    {p.scheduledFor &&
                      ` · scheduled ${p.scheduledFor.toISOString().slice(0, 16).replace("T", " ")}`}
                  </div>
                  {p.privacyStatus === "private" && (
                    <form action={releasePublicationAction.bind(null, p.id)} style={{ marginTop: 8 }}>
                      <button type="submit">🚀 Release to public</button>
                    </form>
                  )}
                </div>
              ))}
            </>
          )}
        </div>

        <div>
          {latestDraft && (
            <>
              <h2>
                Script <span className="muted">v{latestDraft.version}</span>
              </h2>
              <div className="card">
                <p>
                  <strong>Hook:</strong> {latestDraft.hookText}
                </p>
                {latestDraft.beats.map((b, i) => (
                  <p key={i}>
                    <span className="badge">{b.type}</span> {b.text}
                  </p>
                ))}
                <p className="muted">{latestDraft.wordCount} words</p>
              </div>
            </>
          )}

          <h2>Gate history</h2>
          <table className="data">
            <tbody>
              {gates.map((g) => (
                <tr key={g.id}>
                  <td>
                    <span className="badge">{g.kind}</span>
                  </td>
                  <td>
                    {g.status === "pending" ? (
                      <span className="badge amber">pending</span>
                    ) : (
                      <span
                        className={`badge ${g.decision === "approved" ? "green" : g.decision === "rejected" ? "red" : "amber"}`}
                      >
                        {g.decision}
                      </span>
                    )}
                    {g.notes && <div className="muted">“{g.notes}”</div>}
                  </td>
                  <td className="muted">
                    {g.decidedBy ?? ""} {g.decidedAt?.toISOString().slice(0, 16).replace("T", " ") ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>Cost line items</h2>
          <table className="data">
            <tbody>
              {costs.map((c) => (
                <tr key={c.id}>
                  <td>
                    <span className="badge">{c.category}</span>
                  </td>
                  <td className="muted">
                    {c.provider}
                    {c.model ? ` · ${c.model}` : ""}
                  </td>
                  <td className="mono">${Number(c.costUsd).toFixed(4)}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={2}>
                  <strong>Total</strong>
                </td>
                <td className="mono">
                  <strong>${totalCost.toFixed(4)}</strong>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <p style={{ marginTop: "1rem" }}>
        <Link href="/gates">← back to gates</Link>
      </p>
    </div>
  );
}
