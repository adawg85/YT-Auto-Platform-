import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, desc, eq } from "drizzle-orm";
import {
  analyticsSnapshots,
  assets,
  channels,
  costRecords,
  ideas,
  productions,
  publications,
  reviewGates,
  scriptDrafts,
  thumbnails,
} from "@ytauto/db";
import { getAppContext } from "@/lib/context";
import { releasePublicationAction } from "../../actions";
import { GatePanel } from "./gate-panel";
import { Badge, Button, Card, DataTable, type Tone } from "@/components/ui";
import { IconExternal } from "@/components/icons";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, Tone> = {
  published: "good",
  ready: "good",
  rejected: "crit",
  failed: "crit",
  on_hold: "warn",
  script_review: "warn",
  thumbnail_review: "warn",
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
  const snapshots = pubs.length
    ? await db
        .select()
        .from(analyticsSnapshots)
        .where(eq(analyticsSnapshots.publicationId, pubs[0]!.id))
        .orderBy(desc(analyticsSnapshots.capturedAt))
        .limit(1)
    : [];
  const latestSnap = snapshots[0];
  const costs = await db
    .select()
    .from(costRecords)
    .where(eq(costRecords.productionId, id))
    .orderBy(asc(costRecords.createdAt));

  const thumbs = await db.select().from(thumbnails).where(eq(thumbnails.productionId, id));
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
        <Badge tone={STATUS_TONE[production.status] ?? "neutral"} dot>{production.status}</Badge>{" "}
        <span className="muted">
          {channel?.name} · production <span className="mono">{production.id.slice(-8)}</span> · cost{" "}
          <strong>${totalCost.toFixed(4)}</strong>
        </span>
      </p>
      {production.failureReason && (
        <Card>
          <Badge tone="warn" dot>held</Badge> {production.failureReason}
        </Card>
      )}

      {pendingGate && (
        <GatePanel
          gateId={pendingGate.id}
          kind={pendingGate.kind}
          snapshot={pendingGate.payloadSnapshot ?? {}}
          thumbnailCandidates={thumbs.map((t) => ({
            id: t.id,
            storageKey: t.storageKey,
            predictedCtr: t.predictedCtr,
          }))}
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
                <Card key={p.id}>
                  <a href={p.url}>{p.url}</a>
                  <div className="muted">
                    {p.provider} ·{" "}
                    <Badge tone={p.privacyStatus === "public" ? "good" : "warn"}>
                      {p.privacyStatus}
                    </Badge>{" "}
                    · AI disclosure: {p.aiDisclosure ? "yes" : "no"} ·{" "}
                    {p.publishedAt?.toISOString().slice(0, 16).replace("T", " ")}
                    {p.scheduledFor &&
                      ` · scheduled ${p.scheduledFor.toISOString().slice(0, 16).replace("T", " ")}`}
                  </div>
                  {latestSnap && (
                    <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                      <Badge tone="accent">{latestSnap.views} views</Badge>
                      {latestSnap.avgViewPct !== null && (
                        <Badge>{latestSnap.avgViewPct.toFixed(0)}% retention</Badge>
                      )}
                      {latestSnap.ctr !== null && <Badge>{latestSnap.ctr}% CTR</Badge>}
                      <span className="muted">
                        as of {latestSnap.capturedAt.toISOString().slice(0, 16).replace("T", " ")}
                      </span>
                    </div>
                  )}
                  {p.privacyStatus === "private" && (
                    <form action={releasePublicationAction.bind(null, p.id)} style={{ marginTop: 8 }}>
                      <Button type="submit" icon={<IconExternal />}>
                        Release to public
                      </Button>
                    </form>
                  )}
                </Card>
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
              <Card>
                <p>
                  <strong>Hook:</strong> {latestDraft.hookText}
                </p>
                {latestDraft.beats.map((b, i) => (
                  <p key={i}>
                    <Badge>{b.type}</Badge> {b.text}
                  </p>
                ))}
                <p className="muted">{latestDraft.wordCount} words</p>
              </Card>
            </>
          )}

          <h2>Gate history</h2>
          <DataTable>
            <tbody>
              {gates.map((g) => (
                <tr key={g.id}>
                  <td>
                    <Badge>{g.kind}</Badge>
                  </td>
                  <td>
                    {g.status === "pending" ? (
                      <Badge tone="warn" dot>pending</Badge>
                    ) : (
                      <Badge tone={g.decision === "approved" ? "good" : g.decision === "rejected" ? "crit" : "warn"}>
                        {g.decision}
                      </Badge>
                    )}
                    {g.notes && <div className="muted">“{g.notes}”</div>}
                  </td>
                  <td className="muted">
                    {g.decidedBy ?? ""} {g.decidedAt?.toISOString().slice(0, 16).replace("T", " ") ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>

          <h2>Cost line items</h2>
          <DataTable>
            <tbody>
              {costs.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Badge>{c.category}</Badge>
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
          </DataTable>
        </div>
      </div>
      <p style={{ marginTop: "1rem" }}>
        <Link href="/gates">← back to gates</Link>
      </p>
    </div>
  );
}
