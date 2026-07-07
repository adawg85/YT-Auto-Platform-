import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { hookAnalyses, scriptAnalyses } from "@ytauto/db";
import { videoPerformance } from "@ytauto/core";
import { getAppContext } from "@/lib/context";
import { RetentionCurve } from "@/components/charts";
import {
  Badge,
  ButtonLink,
  DataTable,
  EmptyState,
  Panel,
  StatGrid,
  StatTile,
} from "@/components/ui";
import { IconChevronLeft, IconSparkle, IconExternal, IconTrend } from "@/components/icons";
import { fmtNum } from "@/lib/format";

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
              {perf.status.replace(/_/g, " ")} · {perf.niche}
              {perf.publishedAt ? ` · published ${new Date(perf.publishedAt).toISOString().slice(0, 10)}` : ""}
            </p>
          </div>
        </div>
        {perf.url ? (
          <ButtonLink href={perf.url} target="_blank" rel="noreferrer" variant="secondary" icon={<IconExternal />}>
            Watch on YouTube
          </ButtonLink>
        ) : null}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
        <Badge>{fmtNum(perf.views)} views</Badge>
        <Badge>{pct(perf.avgViewPct)} viewed</Badge>
        <Badge tone={perf.threeSecondHoldPct != null && perf.threeSecondHoldPct >= 70 ? "good" : "neutral"}>
          {pct(perf.threeSecondHoldPct)} 3s hold
        </Badge>
        {delta != null && (
          <Badge tone={delta >= 0 ? "good" : "warn"}>
            {delta >= 0 ? "+" : ""}
            {Math.round(delta)} pts vs channel
          </Badge>
        )}
        {perf.subsGained != null && <Badge>+{fmtNum(perf.subsGained)} subs</Badge>}
      </div>

      {!perf.hasAnalytics ? (
        <Panel>
          <EmptyState
            icon={<IconTrend />}
            title="No analytics yet"
            description="Once the monitoring loop captures a retention snapshot, the curve and AI hook/script analysis appear here."
          />
        </Panel>
      ) : (
        <>
          <StatGrid>
            <StatTile label="Views" value={fmtNum(perf.views)} />
            <StatTile label="Avg % viewed" value={pct(perf.avgViewPct)} />
            <StatTile label="Swipe-away 0–3s" value={pct(perf.swipeAwayPct)} />
            <StatTile label="Returning viewers" value={pct(perf.returningViewerPct)} />
          </StatGrid>

          <Panel
            title="Retention curve"
            action={
              perf.channelAvgViewPct != null ? (
                <span className="muted num">channel avg {pct(perf.channelAvgViewPct)}</span>
              ) : undefined
            }
          >
            {perf.retentionCurve && perf.retentionCurve.length > 1 ? (
              <RetentionCurve id="vidRet" data={perf.retentionCurve} />
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                Retention snapshot has no per-point curve yet.
              </p>
            )}
          </Panel>

          <HookPanel hook={hook} vsChannel={delta} />
          <ScriptPanel script={script} />
        </>
      )}
    </>
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
    <Panel
      title={
        <h3>
          <IconSparkle /> Hook analysis
        </h3>
      }
    >
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
              <Badge tone="good">{Math.round(hook.threeSecondHoldPct)}% held at 3s</Badge>
            )}
            {vsChannel != null && (
              <Badge tone={vsChannel >= 0 ? "good" : "warn"}>
                {vsChannel >= 0 ? "+" : ""}
                {Math.round(vsChannel)} pts vs channel
              </Badge>
            )}
            {hook.tags.map((t) => (
              <Badge key={t}>{t}</Badge>
            ))}
          </div>
          <p style={{ margin: 0 }}>{hook.assessment}</p>
        </div>
      )}
    </Panel>
  );
}

function ScriptPanel({ script }: { script: typeof scriptAnalyses.$inferSelect | undefined }) {
  return (
    <Panel
      title={
        <h3>
          <IconSparkle /> Script analysis
        </h3>
      }
    >
      {!script ? (
        <p className="muted" style={{ margin: 0 }}>
          Analysis pending — beat-by-beat structure and a trim suggestion appear here once the agent runs.
        </p>
      ) : (
        <>
          <div style={{ marginBottom: 14 }}>
            <DataTable>
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
                      <Badge tone="accent">{b.type}</Badge> {b.summary}
                    </td>
                    <td className="muted num">
                      {b.startSec}–{b.endSec}s
                    </td>
                    <td className="num">
                      {b.retentionAtStartPct != null ? `${Math.round(b.retentionAtStartPct)}%` : "—"}
                    </td>
                    <td>
                      <Badge tone={b.working ? "good" : "warn"}>
                        {b.working ? "holding" : "leaking"}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
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
    </Panel>
  );
}
