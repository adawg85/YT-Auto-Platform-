"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { StatusBadge } from "@/components/ui";
import { IconChevronRight, IconFilm, IconSearch } from "@/components/icons";
import { fmtAud, fmtDateTime } from "@/lib/format";
import { IN_PRODUCTION_STATUSES } from "@/lib/status";

/** One in-production video, flattened for the client table (dates as ISO). */
export type ProductionRow = {
  id: string;
  title: string;
  channelId: string;
  channelName: string;
  status: string;
  revisionCount: number;
  /** total spend so far, AUD — null until any cost is recorded */
  cost: number | null;
  /** selected thumbnail storage key, if one has been chosen */
  thumbKey: string | null;
  createdAt: string;
  updatedAt: string;
};

type SortKey = "title" | "channel" | "status" | "revisionCount" | "cost" | "createdAt" | "updatedAt";

const COLS: { key: SortKey; label: string; kind: "text" | "num" | "date"; align: "l" | "r" }[] = [
  { key: "channel", label: "Channel", kind: "text", align: "l" },
  { key: "status", label: "Stage", kind: "text", align: "l" },
  { key: "revisionCount", label: "Revisions", kind: "num", align: "r" },
  { key: "cost", label: "Cost", kind: "num", align: "r" },
  { key: "createdAt", label: "Started", kind: "date", align: "r" },
  { key: "updatedAt", label: "Last activity", kind: "date", align: "r" },
];

// pipeline order → so sorting by "Stage" walks the funnel, not the alphabet
const STAGE_ORDER = new Map<string, number>(IN_PRODUCTION_STATUSES.map((s, i) => [s, i]));

function Caret({ dir }: { dir: "asc" | "desc" }) {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" style={{ marginLeft: 4, verticalAlign: "middle" }} aria-hidden="true">
      <path d={dir === "asc" ? "M4 1 L7 6 L1 6 Z" : "M4 7 L1 2 L7 2 Z"} fill="currentColor" />
    </svg>
  );
}

/**
 * The consolidated "In production" board: every video currently in the pipeline
 * (greenlit → scheduled), sortable on any column, filterable by channel and
 * title. A row click opens that video's production page.
 */
export function ProductionsTable({ rows }: { rows: ProductionRow[] }) {
  const router = useRouter();
  const [sortKey, setSortKey] = useState<SortKey>("updatedAt");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [channel, setChannel] = useState<string>("all");
  const [q, setQ] = useState<string>("");

  const channels = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) m.set(r.channelId, r.channelName);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const view = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = rows.filter(
      (r) =>
        (channel === "all" || r.channelId === channel) &&
        (needle === "" || r.title.toLowerCase().includes(needle)),
    );
    const cmp = (a: ProductionRow, b: ProductionRow): number => {
      switch (sortKey) {
        case "title":
          return a.title.localeCompare(b.title);
        case "channel":
          return a.channelName.localeCompare(b.channelName) || a.title.localeCompare(b.title);
        case "status":
          return (STAGE_ORDER.get(a.status) ?? 99) - (STAGE_ORDER.get(b.status) ?? 99);
        case "revisionCount":
          return a.revisionCount - b.revisionCount;
        case "cost":
          return (a.cost ?? -1) - (b.cost ?? -1);
        case "createdAt":
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        case "updatedAt":
          return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
      }
    };
    return [...filtered].sort((a, b) => (dir === "desc" ? -cmp(a, b) : cmp(a, b)));
  }, [rows, channel, q, sortKey, dir]);

  function toggle(key: SortKey) {
    if (key === sortKey) setDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortKey(key);
      // text sorts read best A→Z; numbers/dates read best biggest-first
      setDir(key === "title" || key === "channel" || key === "status" ? "asc" : "desc");
    }
  }

  return (
    <div className="panel">
      <div className="panel-head" style={{ gap: 10, flexWrap: "wrap" }}>
        <h3 style={{ marginRight: "auto" }}>
          {view.length} of {rows.length} {rows.length === 1 ? "video" : "videos"}
        </h3>
        <label className="filter-field">
          <IconSearch />
          <input
            className="mini-input"
            type="search"
            placeholder="Filter by title…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ minWidth: 160 }}
          />
        </label>
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
        {view.length === 0 ? (
          <p className="muted" style={{ padding: 20, margin: 0, textAlign: "center" }}>
            {rows.length === 0
              ? "Nothing is in production right now. Greenlight an idea to start a video."
              : "No videos match this filter."}
          </p>
        ) : (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th
                    className="sortable"
                    aria-sort={sortKey === "title" ? (dir === "asc" ? "ascending" : "descending") : "none"}
                    onClick={() => toggle("title")}
                  >
                    Video
                    {sortKey === "title" ? <Caret dir={dir} /> : null}
                  </th>
                  {COLS.map((c) => {
                    const active = c.key === sortKey;
                    return (
                      <th
                        key={c.key}
                        className={`${c.align === "r" ? "r " : ""}sortable`}
                        aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
                        onClick={() => toggle(c.key)}
                      >
                        {c.label}
                        {active ? <Caret dir={dir} /> : null}
                      </th>
                    );
                  })}
                  <th aria-hidden style={{ width: 32 }}></th>
                </tr>
              </thead>
              <tbody>
                {view.map((r) => {
                  const href = `/productions/${r.id}`;
                  return (
                    <tr key={r.id} className="clickable" onClick={() => router.push(href)}>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 11, minWidth: 0 }}>
                          {r.thumbKey ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={`/api/media/${r.thumbKey}`} alt="" className="vthumb" style={{ objectFit: "cover", flex: "none" }} />
                          ) : (
                            <span className="vthumb" style={{ flex: "none", display: "grid", placeItems: "center", color: "var(--muted)" }}>
                              <IconFilm />
                            </span>
                          )}
                          <Link
                            href={href}
                            style={{ fontWeight: 600, minWidth: 0 }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {r.title}
                          </Link>
                        </div>
                      </td>
                      <td>{r.channelName}</td>
                      <td>
                        <StatusBadge status={r.status} />
                      </td>
                      <td className="r">
                        <span className="num">{r.revisionCount > 0 ? r.revisionCount : "—"}</span>
                      </td>
                      <td className="r">
                        <span className="num">{r.cost != null ? fmtAud(r.cost) : "—"}</span>
                      </td>
                      <td className="r">
                        <span className="num muted" title={fmtDateTime(r.createdAt)}>
                          {relTime(r.createdAt)}
                        </span>
                      </td>
                      <td className="r">
                        <span className="num muted" title={fmtDateTime(r.updatedAt)}>
                          {relTime(r.updatedAt)}
                        </span>
                      </td>
                      <td className="r" style={{ color: "var(--muted)" }}>
                        <IconChevronRight />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/** Compact "3h ago" / "2d ago" for the age columns (title carries the exact time). */
function relTime(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
