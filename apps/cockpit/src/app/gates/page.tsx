import Link from "next/link";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { assets, channels, ideas, productions, reviewGates, scriptDrafts } from "@ytauto/db";
import { GATE_DEAD_PRODUCTION_STATUSES } from "@ytauto/core";
import { getAppContext } from "@/lib/context";
import { BatchDecide } from "./batch-row";
import { VisualsReviewCard } from "./visuals-review";
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
    // Only gates whose production is still active — never surface a gate for a
    // retired/failed/halted/superseded/rejected production (ticket 01KY1SWM…).
    .where(
      and(
        eq(reviewGates.status, "pending"),
        notInArray(productions.status, [...GATE_DEAD_PRODUCTION_STATUSES]),
      ),
    )
    .orderBy(desc(reviewGates.createdAt));

  const scripts = pending.filter((p) => p.gate.kind === "script_review");
  const profiles = pending.filter((p) => p.gate.kind === "profile_review");
  const visuals = pending.filter((p) => p.gate.kind === "visuals_review");
  const finals = pending.filter(
    (p) => !["script_review", "profile_review", "visuals_review"].includes(p.gate.kind),
  );

  // §5.3: load each visual set's shots (image + narration) so the whole set can
  // be reviewed and approved inline from the queue, not one production at a time.
  const visualsShots = await Promise.all(
    visuals.map(async ({ gate }) => {
      const [draft] = await db
        .select({ beats: scriptDrafts.beats })
        .from(scriptDrafts)
        .where(eq(scriptDrafts.productionId, gate.productionId))
        .orderBy(desc(scriptDrafts.version))
        .limit(1);
      const beats = (draft?.beats as { text: string }[] | undefined) ?? [];
      const imgs = await db
        .select({ idx: assets.idx, key: assets.storageKey, updatedAt: assets.updatedAt })
        .from(assets)
        .where(and(eq(assets.productionId, gate.productionId), eq(assets.kind, "image")));
      const clips = await db
        .select({ idx: assets.idx })
        .from(assets)
        .where(and(eq(assets.productionId, gate.productionId), eq(assets.kind, "video_clip")));
      const clipIdx = new Set(clips.map((c) => c.idx));
      const shots = imgs
        .sort((a, b) => a.idx - b.idx)
        .map((im) => ({
          idx: im.idx,
          narration: beats[im.idx]?.text ?? "",
          imageUrl: `/api/media/${im.key}?v=${new Date(im.updatedAt).getTime()}`,
          animated: clipIdx.has(im.idx),
        }));
      return [gate.id, shots] as const;
    }),
  );
  const shotsByGate = new Map(visualsShots);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Review</h1>
          <p className="page-sub">
            {pending.length === 0
              ? "Everything you need to approve, in one queue."
              : [
                  scripts.length && `${scripts.length} script${scripts.length === 1 ? "" : "s"}`,
                  profiles.length && `${profiles.length} production profile${profiles.length === 1 ? "" : "s"}`,
                  visuals.length && `${visuals.length} visual set${visuals.length === 1 ? "" : "s"}`,
                  finals.length && `${finals.length} final cut${finals.length === 1 ? "" : "s"}`,
                ]
                  .filter(Boolean)
                  .join(" and ") + " waiting on you."}
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
                    {snap?.citations && snap.citations.length > 0 && (
                      <details style={{ marginTop: "0.4rem" }}>
                        <summary className="muted">
                          sources — {snap.citations.length} verified/attributed claim
                          {snap.citations.length === 1 ? "" : "s"}
                        </summary>
                        <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.1rem" }}>
                          {snap.citations.map((c) => (
                            <li key={c.claimId} style={{ marginBottom: "0.35rem" }}>
                              <span className={`badge ${c.tier === "established" ? "green" : "amber"}`}>
                                {c.tier === "established" ? "verified" : "attributed"}
                              </span>{" "}
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

      {profiles.length > 0 && (
        <>
          <h2>Production profiles — how each video gets made</h2>
          {profiles.map(({ gate, idea, channel }) => {
            const snap = gate.payloadSnapshot as {
              tweaks?: { accept?: boolean; rationale?: string; changes?: { axis: string; to: string; why: string }[] } | null;
            } | null;
            const changes = snap?.tweaks?.changes ?? [];
            return (
              <div className="card" key={gate.id}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
                  <div style={{ flex: 1, minWidth: 300 }}>
                    <Link href={`/productions/${gate.productionId}`} style={{ fontWeight: 650 }}>
                      {idea.title}
                    </Link>
                    <span className="muted" style={{ fontSize: 12.5, marginLeft: 8 }}>{channel.name}</span>
                    <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>
                      {changes.length === 0
                        ? "AI accepted the channel defaults for this script."
                        : `AI proposes: ${changes.map((c) => `${c.axis} → ${c.to}`).join(" · ")}`}
                    </p>
                    {snap?.tweaks?.rationale && (
                      <p className="muted" style={{ margin: "4px 0 0", fontSize: 12.5, fontStyle: "italic" }}>
                        {snap.tweaks.rationale}
                      </p>
                    )}
                  </div>
                  <Link className="btn ghost sm" href={`/productions/${gate.productionId}`}>
                    Review &amp; decide <IconChevronRight />
                  </Link>
                </div>
              </div>
            );
          })}
        </>
      )}

      {visuals.length > 0 && (
        <>
          <h2>Visual sets — review &amp; approve inline (a / r / x)</h2>
          {visuals.map(({ gate, idea, channel }) => (
            <VisualsReviewCard
              key={gate.id}
              gateId={gate.id}
              productionId={gate.productionId}
              title={idea.title}
              channelName={channel.name}
              shots={shotsByGate.get(gate.id) ?? []}
            />
          ))}
        </>
      )}

      {finals.length > 0 && (
        <>
          <h2>Final cuts — watch, then approve</h2>
          <p className="muted" style={{ marginTop: -4, fontSize: 13 }}>
            The last human checkpoint before it goes live — open to watch &amp; pick a thumbnail, or
            approve inline once you have.
          </p>
          {finals.map(({ gate, idea, channel }) => (
            <div className="card" key={gate.id}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
                <div style={{ flex: 1, minWidth: 260 }}>
                  <Link href={`/productions/${gate.productionId}`} style={{ fontWeight: 600 }}>
                    {idea.title}
                  </Link>
                  <span className="muted" style={{ fontSize: 12.5, marginLeft: 8 }}>{channel.name}</span>
                  <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>{fmtDateTime(gate.createdAt)}</span>
                  <div style={{ marginTop: 6 }}>
                    <Link className="btn ghost sm" href={`/productions/${gate.productionId}`}>
                      Open review <IconChevronRight />
                    </Link>
                  </div>
                </div>
                <BatchDecide gateId={gate.id} />
              </div>
            </div>
          ))}
        </>
      )}
    </>
  );
}
