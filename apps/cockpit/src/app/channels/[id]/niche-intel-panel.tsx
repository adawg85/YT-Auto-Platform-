"use client";

import { useState, useTransition } from "react";
import { Badge, Button, EmptyState, Input, Segmented } from "@/components/ui";
import { IconSearch, IconSparkle, IconPlus, IconTrend, IconX } from "@/components/icons";
import { fmtDateTime, fmtNum } from "@/lib/format";
import { runMarketScanNowAction } from "../../market/actions";
import {
  addCompetitorAction,
  makeIdeaFromVideoAction,
  removeCompetitorAction,
  seedIdeaFromNichePatternAction,
  setIntelCadenceAction,
  tagCompetitorAction,
} from "./intel-actions";

/**
 * Niche intel tab (BACKLOG #23.3): the per-channel view of the market-scan
 * engine — scan cadence control, the persistent competitor list, what's
 * working in the niche (patterns), and a 90-day trending feed with
 * click-to-act (make an idea / tag a competitor). Data is loaded server-side
 * in page.tsx and passed in serialized.
 */

export type IntelPattern = {
  id: string;
  label: string;
  /** hook opener or topic angle pulled from detail, when present */
  detail: string | null;
  source: string;
  score: number;
  observations: number;
};

export type NicheIntelData = {
  channelId: string;
  niche: string;
  /** "daily" | "weekly" | "off" */
  cadence: string;
  /** max external_videos.updatedAt for the niche (ISO), null = never scanned */
  lastScanAt: string | null;
  competitors: { id: string; name: string; url: string | null; source: string }[];
  /** scouted breakout channel names not yet tagged as competitors */
  untaggedBreakouts: string[];
  topics: IntelPattern[];
  hooks: IntelPattern[];
  structures: IntelPattern[];
  /** external videos for the niche, last 90 days, hottest first */
  feed: {
    id: string;
    title: string;
    channelName: string;
    url: string | null;
    views: number;
    viewsPerHour: number | null;
    outlierFactor: number | null;
    format: string | null;
    publishedAt: string | null;
    source: string;
    tagged: boolean;
  }[];
};

const CADENCE_OPTIONS = [
  { value: "daily" as const, label: "Daily" },
  { value: "weekly" as const, label: "Weekly" },
  { value: "off" as const, label: "Off" },
];

const SOURCE_LABEL: Record<string, string> = {
  outlier: "Outlier",
  breakout: "Breakout",
  trending: "Trending",
};

/** compact "3d"/"5h"/"2w" age from an ISO timestamp. */
function shortAgo(iso: string | null): string | null {
  if (!iso) return null;
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (!Number.isFinite(h) || h < 0) return null;
  if (h < 1) return "just now";
  if (h < 24) return `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 14) return `${Math.round(d)}d`;
  if (d < 60) return `${Math.round(d / 7)}w`;
  return `${Math.round(d / 30)}mo`;
}

/** YouTube video id from a watch/shorts/youtu.be URL — for the keyless thumbnail. */
export function youtubeIdFromUrl(url: string | null): string | null {
  if (!url) return null;
  const m =
    /[?&]v=([\w-]{11})/.exec(url) ||
    /youtu\.be\/([\w-]{11})/.exec(url) ||
    /\/shorts\/([\w-]{11})/.exec(url);
  return m ? m[1]! : null;
}

/** 16:9 thumbnail from a video URL (i.ytimg.com is keyless), else a placeholder. */
function VideoThumb({ url, title }: { url: string | null; title: string }) {
  const id = youtubeIdFromUrl(url);
  const inner = id ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`https://i.ytimg.com/vi/${id}/mqdefault.jpg`}
      alt=""
      loading="lazy"
      style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
    />
  ) : (
    <div style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", color: "var(--muted)" }}>
      <IconTrend />
    </div>
  );
  const box = (
    <div
      className="vthumb"
      style={{
        aspectRatio: "16 / 9",
        flex: "none",
        borderRadius: 8,
        overflow: "hidden",
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
      }}
    >
      {inner}
    </div>
  );
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" title={`Watch: ${title}`} style={{ display: "block" }}>
      {box}
    </a>
  ) : (
    box
  );
}

export function NicheIntelPanel({ data }: { data: NicheIntelData }) {
  const [cadence, setCadence] = useState(data.cadence as "daily" | "weekly" | "off");
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <div>
      {/* head row: cadence + scan now + last-scan time */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 16,
        }}
      >
        <span className="muted" style={{ fontSize: 12.5, fontWeight: 600 }}>
          Scan cadence
        </span>
        <Segmented
          value={cadence}
          options={CADENCE_OPTIONS}
          onChange={(v) => {
            setCadence(v);
            startTransition(async () => {
              await setIntelCadenceAction(data.channelId, v);
              setNotice(
                v === "off"
                  ? "Scheduled scans off — Scan now still works."
                  : `Cadence saved — the scan runs ${v === "daily" ? "every day" : "Mondays"}.`,
              );
            });
          }}
        />
        <form action={runMarketScanNowAction.bind(null, data.niche)} className="inline">
          <Button type="submit" size="sm" icon={<IconSearch />}>
            Scan now
          </Button>
        </form>
        <span className="muted" style={{ fontSize: 12.5, marginLeft: "auto" }}>
          {data.lastScanAt ? `Last scan ${fmtDateTime(data.lastScanAt)}` : "Never scanned"}
        </span>
      </div>
      {notice && (
        <p className="muted" style={{ margin: "-8px 0 14px", fontSize: 12.5 }}>
          {notice}
        </p>
      )}

      {/* competitors */}
      <div className="panel">
        <div className="panel-head">
          <h3>Competitors</h3>
          <span className="muted">{data.competitors.length} tagged</span>
        </div>
        <div className="panel-body">
          {data.competitors.length === 0 ? (
            <p className="muted" style={{ marginTop: 0 }}>
              No competitors tagged yet — add one below, or tag a channel straight off the trending
              feed. The scan keeps an eye on tagged channels&apos; niches.
            </p>
          ) : (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
              {data.competitors.map((c) => (
                <span key={c.id} className={`chip ${c.source === "scan" ? "acc" : ""}`}>
                  {c.url ? (
                    <a href={c.url} target="_blank" rel="noreferrer">
                      {c.name}
                    </a>
                  ) : (
                    c.name
                  )}
                  <button
                    type="button"
                    aria-label={`Remove ${c.name}`}
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        await removeCompetitorAction(c.id);
                      })
                    }
                    style={{
                      border: "none",
                      background: "transparent",
                      color: "inherit",
                      padding: 0,
                      display: "inline-flex",
                      cursor: "pointer",
                    }}
                  >
                    <IconX />
                  </button>
                </span>
              ))}
            </div>
          )}

          <form
            action={addCompetitorAction.bind(null, data.channelId)}
            style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
          >
            <Input name="name" placeholder="Channel name" required style={{ maxWidth: 220 }} />
            <Input name="url" placeholder="URL (optional)" style={{ maxWidth: 260 }} />
            <Button type="submit" size="sm" variant="secondary" icon={<IconPlus />}>
              Add competitor
            </Button>
          </form>

          {data.untaggedBreakouts.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div className="metric-help" style={{ marginBottom: 8, fontWeight: 600 }}>
                Breakout channels the scan found — tag the ones you compete with
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {data.untaggedBreakouts.map((name) => (
                  <span key={name} className="chip">
                    {name}
                    <button
                      type="button"
                      className="btn sm ghost"
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () => {
                          await tagCompetitorAction(data.channelId, name);
                        })
                      }
                    >
                      Tag
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* what's working */}
      <div className="panel">
        <div className="panel-head">
          <h3>
            <IconTrend /> What&apos;s working in {data.niche}
          </h3>
          <span className="muted">borrow a signal — the usual gates still apply</span>
        </div>
        <div className="panel-body">
          {data.topics.length + data.hooks.length + data.structures.length === 0 ? (
            <EmptyState
              icon={<IconTrend />}
              title="No patterns for this niche yet"
              description="Run a scan — the meta-analysis engine distils scouted content into rising angles, hook patterns and script structures."
            />
          ) : (
            <>
              {data.topics.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div className="metric-help" style={{ marginBottom: 8, fontWeight: 600 }}>
                    Rising angles
                  </div>
                  {data.topics.map((t) => (
                    <div
                      key={t.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "5px 0",
                        flexWrap: "wrap",
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>{t.label}</span>
                      {t.detail && (
                        <span className="muted" style={{ fontSize: 12 }}>
                          {t.detail}
                        </span>
                      )}
                      <span className="num muted" style={{ marginLeft: "auto", fontSize: 12 }}>
                        score {t.score} · seen in {t.observations}
                      </span>
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={<IconSparkle />}
                        disabled={pending}
                        onClick={() =>
                          startTransition(async () => {
                            await seedIdeaFromNichePatternAction(data.channelId, {
                              label: t.label,
                              angle: t.detail ?? t.label,
                            });
                            setNotice(`Idea seeded from "${t.label}" — it's in the inbox, scoring now.`);
                          })
                        }
                      >
                        Seed idea
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <div className="grid grid-2">
                <PatternChips title="Hook patterns" rows={data.hooks} />
                <PatternChips title="Script structures" rows={data.structures} />
              </div>
            </>
          )}
        </div>
      </div>

      {/* trending feed */}
      <div className="panel">
        <div className="panel-head">
          <h3>Trending in the niche</h3>
          <span className="muted">last 90 days · hottest first</span>
        </div>
        <div className="panel-body flush">
          {data.feed.length === 0 ? (
            <EmptyState
              icon={<IconSearch />}
              title="Nothing scouted in the last 90 days"
              description="Run a scan to pull down what's over-performing in this niche right now."
            />
          ) : (
            <div className="intel-feed">
              {data.feed.map((v) => {
                const age = shortAgo(v.publishedAt);
                const vph = v.viewsPerHour != null && v.viewsPerHour > 0 ? Math.round(v.viewsPerHour) : null;
                const hot = v.outlierFactor != null && v.outlierFactor >= 2;
                return (
                  <div className="intel-card" key={v.id}>
                    <VideoThumb url={v.url} title={v.title} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "flex-start", justifyContent: "space-between" }}>
                        {v.url ? (
                          <a href={v.url} target="_blank" rel="noreferrer" style={{ fontWeight: 600, fontSize: 13.5 }}>
                            {v.title}
                          </a>
                        ) : (
                          <span style={{ fontWeight: 600, fontSize: 13.5 }}>{v.title}</span>
                        )}
                        <Badge tone={v.source === "breakout" ? "accent" : "neutral"}>
                          {SOURCE_LABEL[v.source] ?? v.source}
                        </Badge>
                      </div>
                      <div className="muted" style={{ fontSize: 12, margin: "4px 0 2px" }}>{v.channelName}</div>
                      {/* stat row — wraps on mobile */}
                      <div className="intel-stats">
                        <span><b className="num">{fmtNum(v.views)}</b> views</span>
                        {vph != null && <span title="views per hour since publish"><b className="num">{fmtNum(vph)}</b>/h</span>}
                        {v.outlierFactor != null && v.outlierFactor > 0 && (
                          <span className={hot ? "hot" : ""} title="views vs the niche median">
                            <b className="num">{v.outlierFactor}×</b> median
                          </span>
                        )}
                        {age && <span>{age} ago</span>}
                        {v.format && <span className="chip">{v.format === "long" ? "long" : "short"}</span>}
                        {v.tagged && <span className="chip acc">competitor</span>}
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={<IconSparkle />}
                          disabled={pending}
                          onClick={() =>
                            startTransition(async () => {
                              await makeIdeaFromVideoAction(data.channelId, v.id);
                              setNotice(`Idea created: our take on "${v.title.slice(0, 60)}" — scoring now.`);
                            })
                          }
                        >
                          Make an idea
                        </Button>
                        {!v.tagged && (
                          <button
                            type="button"
                            className="btn sm ghost"
                            disabled={pending}
                            onClick={() => startTransition(async () => { await tagCompetitorAction(data.channelId, v.channelName); })}
                          >
                            Tag competitor
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PatternChips({ title, rows }: { title: string; rows: IntelPattern[] }) {
  if (rows.length === 0) return null;
  return (
    <div>
      <div className="metric-help" style={{ marginBottom: 8, fontWeight: 600 }}>
        {title}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {rows.map((r) => (
          <span key={r.id} className={`chip ${r.source === "own" ? "acc" : ""}`} title={r.detail ?? undefined}>
            <span className="mono">{r.label}</span>
            <span className="num muted" style={{ fontSize: 11 }}>
              {r.score}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
