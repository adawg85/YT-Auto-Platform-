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
import { forceForwardAction, releasePublicationAction, resumeProductionAction } from "../../actions";
import { GatePanel } from "./gate-panel";
import { HaltPanel } from "./halt-panel";
import type { HaltDiscard } from "../../actions";
import { IconAlertTriangle, IconChevronLeft, IconRefresh, IconUpload, IconZap } from "@/components/icons";
import {
  costCategoryLabel,
  fmtDateTime,
  fmtDuration,
  fmtMoney,
  gateDecisionLabel,
  gateKindLabel,
  prodStatusLabel,
} from "@/lib/format";

export const dynamic = "force-dynamic";

const STATUS_CHIP: Record<string, string> = {
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

  // Halt is available from any stage that isn't already terminal. `failed` and
  // `on_hold` stay haltable on purpose — that's how you recover them.
  const HALT_HIDDEN = new Set(["published", "halted", "rejected"]);
  const canHalt = !HALT_HIDDEN.has(production.status);
  const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? "" : "s"}`;
  const haltArtifacts: { key: HaltDiscard; label: string; detail: string }[] = [];
  if (latestDraft) haltArtifacts.push({ key: "script", label: "script", detail: plural(drafts.length, "draft") });
  if (voiceover) haltArtifacts.push({ key: "voiceover", label: "voiceover", detail: "generated narration audio" });
  if (images.length) haltArtifacts.push({ key: "images", label: "beat visuals", detail: plural(images.length, "image") });
  if (render) haltArtifacts.push({ key: "render", label: "rendered video", detail: "the assembled short" });
  if (thumbs.length) haltArtifacts.push({ key: "thumbnails", label: "thumbnails", detail: plural(thumbs.length, "candidate") });

  return (
    <div>
      <Link href="/gates" className="backlink">
        <IconChevronLeft /> Review
      </Link>
      <div className="page-head" style={{ marginBottom: 14 }}>
        <div>
          <h1 className="page-title">{idea?.title ?? "Production"}</h1>
          <p className="page-sub">{channel?.name}</p>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 18 }}>
        <span className={`chip ${STATUS_CHIP[production.status] ?? ""}`}>
          <span className="d" />
          {prodStatusLabel(production.status)}
        </span>
        <span className="chip">Cost so far {fmtMoney(totalCost)}</span>
        {production.revisionCount > 0 && <span className="chip">Revision {production.revisionCount}</span>}
        {canHalt && (
          <span style={{ marginLeft: "auto" }}>
            <HaltPanel productionId={production.id} artifacts={haltArtifacts} />
          </span>
        )}
      </div>

      {production.failureReason && (
        <div className="callout warn" style={{ marginTop: 0 }}>
          <IconAlertTriangle />
          <span>{production.failureReason}</span>
        </div>
      )}

      {production.status === "halted" && latestDraft && (
        <div className="callout" style={{ marginTop: 0 }}>
          <IconRefresh />
          <div>
            <strong>Resume this production</strong>
            <p className="muted" style={{ margin: "4px 0 10px", fontSize: 12.5 }}>
              Reuses the kept script and regenerates voiceover, images and render on a fresh
              production. The script review is skipped.
            </p>
            <form action={resumeProductionAction.bind(null, production.id)}>
              <button type="submit" className="btn">
                <IconRefresh /> Resume — reuse script
              </button>
            </form>
          </div>
        </div>
      )}

      {["on_hold", "failed", "rejected"].includes(production.status) && latestDraft && (
        <div className="callout warn" style={{ marginTop: 0 }}>
          <IconZap />
          <div>
            <strong>Force this forward</strong>
            <p className="muted" style={{ margin: "4px 0 10px", fontSize: 12.5 }}>
              This production is blocked. Force-forward re-runs from the current script with the
              soft safety checks (variation + review board) bypassed and regenerates media — use
              only after you&apos;ve reviewed the flag yourself. The override is logged for the
              compliance trail.
            </p>
            <form action={forceForwardAction.bind(null, production.id)}>
              <button type="submit" className="btn warn">
                <IconZap /> Force forward — override checks
              </button>
            </form>
          </div>
        </div>
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

      <div
        className={render || voiceover || images.length > 0 || pubs.length > 0 ? "grid-2 grid" : undefined}
      >
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
              <div className="beats">
                {images.map((img) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={img.id} src={`/api/media/${img.storageKey}`} alt={`Beat ${img.idx + 1} visual`} />
                ))}
              </div>
            </>
          )}
          {pubs.length > 0 && (
            <>
              <h2>Publication</h2>
              {pubs.map((p) => (
                <div className="card" key={p.id}>
                  <a href={p.url} style={{ color: "var(--accent-ink)", fontWeight: 600 }}>
                    {p.url}
                  </a>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
                    <span className={`chip ${p.privacyStatus === "public" ? "good" : "warn"}`}>
                      <span className="d" />
                      {p.privacyStatus === "public" ? "Public" : "Private"}
                    </span>
                    {p.aiDisclosure && <span className="chip">AI disclosure on</span>}
                    {p.publishedAt && <span className="chip">Published {fmtDateTime(p.publishedAt)}</span>}
                    {p.scheduledFor && <span className="chip acc">Scheduled {fmtDateTime(p.scheduledFor)}</span>}
                  </div>
                  {latestSnap && (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
                      <span className="chip acc">{latestSnap.views} views</span>
                      {latestSnap.avgViewPct !== null && (
                        <span className="chip">{latestSnap.avgViewPct.toFixed(0)}% retention</span>
                      )}
                      {latestSnap.ctr !== null && <span className="chip">{latestSnap.ctr}% CTR</span>}
                      <span className="muted" style={{ fontSize: 12 }}>
                        as of {fmtDateTime(latestSnap.capturedAt)}
                      </span>
                    </div>
                  )}
                  {p.privacyStatus === "private" && (
                    <form action={releasePublicationAction.bind(null, p.id)} style={{ marginTop: 12 }}>
                      <button type="submit" className="btn">
                        <IconUpload /> Release to public
                      </button>
                      <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
                        Flips the YouTube video from private to public immediately.
                      </p>
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
                {latestDraft.beats.map((b, i) => (
                  <p key={i} style={{ margin: "0 0 10px" }}>
                    <span className="chip" style={{ marginRight: 7 }}>
                      {b.type === "cta" ? "CTA" : b.type.charAt(0).toUpperCase() + b.type.slice(1)}
                    </span>
                    {b.text}
                    {typeof b.estSec === "number" && (
                      <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>
                        ~{b.estSec}s
                      </span>
                    )}
                  </p>
                ))}
                <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                  {latestDraft.wordCount} words · ~{fmtDuration(Math.round(latestDraft.wordCount / 2.5))} of narration (est.)
                </p>
              </div>
            </>
          )}

          <h2>Review history</h2>
          <div className="tablewrap">
            <table className="data">
              <tbody>
                {gates.map((g) => (
                  <tr key={g.id}>
                    <td>{gateKindLabel(g.kind)}</td>
                    <td>
                      {g.status === "pending" ? (
                        <span className="chip warn">Pending</span>
                      ) : (
                        <span
                          className={`chip ${g.decision === "approved" ? "good" : g.decision === "rejected" ? "crit" : "warn"}`}
                        >
                          {g.decision ? gateDecisionLabel(g.decision) : "—"}
                        </span>
                      )}
                      {g.notes && <div className="muted" style={{ marginTop: 4 }}>“{g.notes}”</div>}
                    </td>
                    <td className="muted" style={{ whiteSpace: "nowrap" }}>
                      {g.decidedAt ? fmtDateTime(g.decidedAt) : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2>Cost breakdown</h2>
          <div className="tablewrap">
            <table className="data">
              <tbody>
                {costs.map((c) => (
                  <tr key={c.id}>
                    <td>{costCategoryLabel(c.category)}</td>
                    <td className="muted">
                      {c.provider}
                      {c.model ? ` · ${c.model}` : ""}
                    </td>
                    <td className="r">{fmtMoney(Number(c.costUsd))}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={2}>
                    <strong>Total</strong>
                  </td>
                  <td className="r">
                    <strong>{fmtMoney(totalCost)}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
