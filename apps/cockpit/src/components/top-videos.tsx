"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { TopVideo } from "@/lib/overview";

type SortKey = "views" | "retention" | "ctr" | "impressions" | "subsGained" | "publishedAt";

const COLS: { key: SortKey; label: string; kind: "num" | "pct" | "date" }[] = [
  { key: "views", label: "Views", kind: "num" },
  { key: "retention", label: "Retention", kind: "pct" },
  { key: "ctr", label: "CTR", kind: "pct" },
  { key: "impressions", label: "Impressions", kind: "num" },
  { key: "subsGained", label: "Subs", kind: "num" },
  { key: "publishedAt", label: "Published", kind: "date" },
];

function fmtNum(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}
function fmtPct(n: number | null): string {
  return n == null ? "—" : `${Math.round(n)}%`;
}
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function Caret({ dir }: { dir: "asc" | "desc" }) {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" style={{ marginLeft: 4, verticalAlign: "middle" }} aria-hidden="true">
      <path d={dir === "asc" ? "M4 1 L7 6 L1 6 Z" : "M4 7 L1 2 L7 2 Z"} fill="currentColor" />
    </svg>
  );
}

/**
 * Sortable, channel-filterable strip of published videos by performance.
 * Impressions/CTR/subs are null until the analytics ingest supplies them, so
 * they render "—" — the strip is useful the moment there's view data.
 */
export function TopVideos({ videos }: { videos: TopVideo[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("views");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [channel, setChannel] = useState<string>("all");

  const channels = useMemo(() => {
    const m = new Map<string, string>();
    for (const v of videos) m.set(v.channelId, v.channelName);
    return [...m.entries()];
  }, [videos]);

  const rows = useMemo(() => {
    const filtered = channel === "all" ? videos : videos.filter((v) => v.channelId === channel);
    const val = (v: TopVideo): number => {
      if (sortKey === "publishedAt") return v.publishedAt ? new Date(v.publishedAt).getTime() : 0;
      const raw = v[sortKey];
      return raw == null ? -1 : raw; // nulls sort last on desc
    };
    return [...filtered].sort((a, b) => (dir === "desc" ? val(b) - val(a) : val(a) - val(b)));
  }, [videos, channel, sortKey, dir]);

  function toggle(key: SortKey) {
    if (key === sortKey) setDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortKey(key);
      setDir("desc");
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Top videos by performance</h3>
        {channels.length > 1 ? (
          <select className="mini-select" value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="all">All channels</option>
            {channels.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <div className="panel-body flush">
        {rows.length === 0 ? (
          <p className="muted" style={{ padding: 20, margin: 0, textAlign: "center" }}>
            No published videos yet. Once a video goes live and analytics ingest runs, it ranks here.
          </p>
        ) : (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Video</th>
                  {COLS.map((c) => {
                    const active = c.key === sortKey;
                    return (
                      <th
                        key={c.key}
                        className="r sortable"
                        aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
                        onClick={() => toggle(c.key)}
                      >
                        {c.label}
                        {active ? <Caret dir={dir} /> : null}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((v) => (
                  <tr key={v.publicationId}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 11, minWidth: 0 }}>
                        {v.videoId ? (
                          <a
                            href={`https://www.youtube.com/watch?v=${v.videoId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Watch on YouTube"
                            style={{ flex: "none", display: "block" }}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={`https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`}
                              alt=""
                              width={68}
                              height={38}
                              loading="lazy"
                              style={{
                                width: 68,
                                height: 38,
                                objectFit: "cover",
                                borderRadius: 6,
                                border: "1px solid var(--border)",
                                display: "block",
                              }}
                            />
                          </a>
                        ) : null}
                        <span style={{ minWidth: 0 }}>
                          <Link href={`/productions/${v.productionId}`} style={{ fontWeight: 600, display: "block" }}>
                            {v.title}
                          </Link>
                          <span className="muted" style={{ fontSize: 11.5 }}>
                            {v.channelName}
                          </span>
                        </span>
                      </div>
                    </td>
                    <td className="r">
                      <span className="num">{fmtNum(v.views)}</span>
                    </td>
                    <td className="r">
                      <span className="num">{fmtPct(v.retention)}</span>
                    </td>
                    <td className="r">
                      <span className="num">{v.ctr == null ? "—" : `${v.ctr.toFixed(1)}%`}</span>
                    </td>
                    <td className="r">
                      <span className="num">{fmtNum(v.impressions)}</span>
                    </td>
                    <td className="r">
                      <span className="num">{fmtNum(v.subsGained)}</span>
                    </td>
                    <td className="r">
                      <span className="num">{fmtDate(v.publishedAt)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
