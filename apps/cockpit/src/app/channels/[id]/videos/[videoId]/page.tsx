import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { hookAnalyses, scriptAnalyses, thumbnails } from "@ytauto/db";
import { videoPerformance } from "@ytauto/core";
import { getAppContext } from "@/lib/context";
import { RetentionCurve } from "@/components/charts";
import { ThumbnailGallery } from "@/app/productions/[id]/thumbnail-gallery";
import { CorrectedCopyPanel } from "@/app/productions/[id]/corrected-copy-panel";
import {
  IconChevronLeft,
  IconExternal,
  IconEye,
  IconGauge,
  IconSparkle,
  IconTrendDown,
  IconUgc,
} from "@/components/icons";
import { fmtDate, fmtNum, prodStatusLabel } from "@/lib/format";

export const dynamic = "force-dynamic";

const ARCHETYPE_LABEL: Record<string, string> = {
  curiosity_gap: "curiosity gap",
  pattern_interrupt: "pattern interrupt",
  stakes_first: "stakes first",
  contrarian: "contrarian",
};

export default async function VideoPage({
  params,
}: {
  params: Promise<{ id: string; videoId: string }>;
}) {
  const { id, videoId } = await params;
  const { db } = await getAppContext();

  const perf = await videoPerformance(db, videoId);
  if (!perf || perf.channelId !== id) notFound();

  // thumbnails for the post-publish swap gallery (2026-07-15: the operator lands
  // HERE after publishing, not on /productions/[id], so the thumbnail control
  // needs to live on this page too)
  const thumbs = perf.url
    ? await db.select().from(thumbnails).where(eq(thumbnails.productionId, perf.productionId))
    : [];

  const [hook] = await db
    .select()
    .from(hookAnalyses)
    .where(eq(hookAnalyses.publicationId, videoId));
  const [script] = await db
    .select()
    .from(scriptAnalyses)
    .where(eq(scriptAnalyses.publicationId, videoId));

  const pct = (v: number | null | undefined) => (v != null ? `${Math.round(v)}%` : "—");
  const delta = perf.vsChannelAvgPct;

  return (
    <>
      <Link href={`/channels/${id}`} className="backlink">
        <IconChevronLeft /> Channel
      </Link>

      <div className="page-head">
        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
          <span className="thumb" style={{ width: 52, height: 52, background: "linear-gradient(135deg,var(--accent),var(--accent-2))" }}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="#fff">
              <polygon points="8 5 19 12 8 19" />
            </svg>
          </span>
          <div>
            <h1 className="page-title" style={{ margin: 0 }}>
              {perf.title}
            </h1>
            <p className="page-sub">
              {prodStatusLabel(perf.status)} · {perf.niche}
              {perf.publishedAt ? ` · published ${fmtDate(perf.publishedAt)}` : ""}
            </p>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Link className="btn ghost" href={`/productions/${perf.productionId}`}>
            <IconChevronLeft /> Open production
          </Link>
          {perf.url ? (
            <a className="btn ghost" href={perf.url} target="_blank" rel="noreferrer">
              <IconExternal /> Watch on YouTube
            </a>
          ) : null}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
        <span className="chip">{fmtNum(perf.views)} views</span>
        <span className="chip">{pct(perf.avgViewPct)} viewed</span>
        <span className={`chip ${perf.threeSecondHoldPct != null && perf.threeSecondHoldPct >= 70 ? "good" : ""}`}>
          {pct(perf.threeSecondHoldPct)} 3s hold
        </span>
        {delta != null && Math.round(delta) !== 0 && (
          <span className={`chip ${delta >= 0 ? "good" : "warn"}`}>
            {delta >= 0 ? "+" : ""}
            {Math.round(delta)} pts vs channel
          </span>
        )}
        {delta != null && Math.round(delta) === 0 && <span className="chip">On par with channel</span>}
        {perf.subsGained != null && <span className="chip">+{fmtNum(perf.subsGained)} subs</span>}
      </div>

      {/* Fix-a-published-video path (2026-07-19): the operator lands HERE after
          publishing, so the "Make a corrected copy" control lives here too —
          YouTube can't replace a live file, so a fix ships as a new upload. */}
      {["published", "scheduled"].includes(perf.status) && (
        <div style={{ marginBottom: 20 }}>
          <CorrectedCopyPanel productionId={perf.productionId} />
        </div>
      )}

      {thumbs.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <ThumbnailGallery
            productionId={perf.productionId}
            channelId={perf.channelId}
            candidates={thumbs.map((t) => ({
              id: t.id,
              storageKey: t.storageKey,
              predictedCtr: t.predictedCtr,
              selected: t.selected,
              applyError: typeof t.meta?.applyError === "string" ? t.meta.applyError : null,
            }))}
          />
        </div>
      )}

      {!perf.hasAnalytics ? (
        <div className="panel">
          <div className="panel-body">
            <p className="muted" style={{ margin: 0 }}>
              No analytics ingested for this video yet. Once the monitoring loop captures a retention snapshot, the
              curve and AI hook/script analysis appear here.
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="kpis">
            <Kpi lab="Views" ic={<IconEye />} val={<span className="num">{fmtNum(perf.views)}</span>} />
            <Kpi lab="Avg % viewed" ic={<IconGauge />} val={<span className="num">{pct(perf.avgViewPct)}</span>} />
            <Kpi lab="Swipe-away 0–3s" ic={<IconTrendDown />} val={<span className="num">{pct(perf.swipeAwayPct)}</span>} />
            <Kpi lab="Returning viewers" ic={<IconUgc />} val={<span className="num">{pct(perf.returningViewerPct)}</span>} />
          </div>

          <div className="panel">
            <div className="panel-head">
              <h3>Retention curve</h3>
              {perf.channelAvgViewPct != null && (
                <span className="muted num">channel avg {pct(perf.channelAvgViewPct)}</span>
              )}
            </div>
            <div className="panel-body">
              {perf.retentionCurve && perf.retentionCurve.length > 1 ? (
                <RetentionCurve id="vidRet" data={perf.retentionCurve} />
              ) : (
                <p className="muted" style={{ margin: 0 }}>
                  Retention snapshot has no per-point curve yet.
                </p>
              )}
            </div>
          </div>

          <HookPanel hook={hook} vsChannel={delta} />
          <ScriptPanel script={script} />
        </>
      )}
    </>
  );
}

function Kpi({ lab, val, ic }: { lab: string; val: React.ReactNode; ic?: React.ReactNode }) {
  return (
    <div className="kpi">
      {ic ? <span className="ic">{ic}</span> : null}
      <div className="lab">{lab}</div>
      <div className="val">{val}</div>
    </div>
  );
}

function HookPanel({
  hook,
  vsChannel,
}: {
  hook: typeof hookAnalyses.$inferSelect | undefined;
  vsChannel: number | null;
}) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>
          <IconSparkle /> Hook analysis
        </h3>
      </div>
      <div className="panel-body">
        {!hook ? (
          <p className="muted" style={{ margin: 0 }}>
            Analysis pending — the analysis agent runs after a video crosses the view threshold. Refresh shortly.
          </p>
        ) : (
          <div className="aibox">
            <h4>
              <IconSparkle /> {ARCHETYPE_LABEL[hook.archetype] ?? hook.archetype}
            </h4>
            <p style={{ marginTop: 0, fontStyle: "italic" }}>&ldquo;{hook.hookText}&rdquo;</p>
            <div className="tagrow" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
              {hook.threeSecondHoldPct != null && (
                <span className="chip good">{Math.round(hook.threeSecondHoldPct)}% held at 3s</span>
              )}
              {vsChannel != null && Math.round(vsChannel) !== 0 && (
                <span className={`chip ${vsChannel >= 0 ? "good" : "warn"}`}>
                  {vsChannel >= 0 ? "+" : ""}
                  {Math.round(vsChannel)} pts vs channel
                </span>
              )}
              {hook.tags.map((t) => (
                <span key={t} className="chip">
                  {t}
                </span>
              ))}
            </div>
            <p style={{ margin: 0 }}>{hook.assessment}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function ScriptPanel({ script }: { script: typeof scriptAnalyses.$inferSelect | undefined }) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>
          <IconSparkle /> Script analysis
        </h3>
      </div>
      <div className="panel-body">
        {!script ? (
          <p className="muted" style={{ margin: 0 }}>
            Analysis pending — beat-by-beat structure and a trim suggestion appear here once the agent runs.
          </p>
        ) : (
          <>
            <div className="panel-body flush" style={{ padding: 0, marginBottom: 14 }}>
              <table className="data" style={{ border: "none", borderRadius: 0 }}>
                <thead>
                  <tr>
                    <th>Beat</th>
                    <th>Time</th>
                    <th>Retention</th>
                    <th>Holding?</th>
                  </tr>
                </thead>
                <tbody>
                  {script.structure.map((b, i) => (
                    <tr key={i}>
                      <td>
                        <span className="chip acc">{b.type}</span> {b.summary}
                      </td>
                      <td className="muted num">
                        {b.startSec}–{b.endSec}s
                      </td>
                      <td className="num">
                        {b.retentionAtStartPct != null ? `${Math.round(b.retentionAtStartPct)}%` : "—"}
                      </td>
                      <td>
                        <span className={`chip ${b.working ? "good" : "warn"}`}>
                          {b.working ? "holding" : "leaking"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="aibox">
              <h4>
                <IconSparkle /> What&apos;s working
              </h4>
              <p style={{ marginTop: 0 }}>{script.strengths}</p>
              <h4>
                <IconSparkle /> Suggested trim
              </h4>
              <p style={{ margin: 0 }}>
                {script.trimSuggestion}
                {script.dipAtSec != null ? (
                  <span className="muted"> (retention dips around {Math.round(script.dipAtSec)}s)</span>
                ) : null}
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
