"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Dialog } from "@/components/ui";
import { fmtDateTime, tzAbbr, zonedInputToIso, zonedParts } from "@/lib/format";
import {
  cancelScheduledReleaseAction,
  releasePublicationAction,
  reschedulePublicationAction,
} from "@/app/actions";
import {
  moveTentativeSlotAction,
  reprojectTentativeSlotsAction,
} from "@/app/channels/editorial-actions";

/**
 * Plan & Schedule calendar (BACKLOG #8). Renders scheduled + published videos on
 * a month grid so the warm-up cadence and what fills it are visible on real
 * dates — the schedule that used to be invisible (no queryable publication row).
 * Shared by the per-channel Schedule tab and the cross-channel Overview.
 * #20: clicking a video opens a control popup — publish now / move schedule /
 * cancel — so the operator drives everything from the platform and the change
 * propagates to YouTube (one videos.update), never the other way round.
 */

export type CalItem = {
  /** ISO date-time of the publish (scheduledFor, or publishedAt for live videos) */
  at: string;
  title: string;
  channelId: string;
  channelName: string;
  format: "long" | "short";
  status: "published" | "scheduled";
  /** deep link to the production page (omit to render a plain row) */
  productionId?: string;
  /** the publications row backing this entry */
  publicationId?: string;
  /** uploaded + natively scheduled → the popup offers publish-now/move/cancel */
  controllable?: boolean;
  /** #23.1: a projected series slot (episodes.tentativeFor) — not a real
   * publication yet. Rendered dimmed/dashed and offers NO publish controls;
   * it locks into a real scheduled release when the video is approved. */
  tentative?: boolean;
  /** the episode behind a tentative slot — drag-and-drop moves its tentativeFor */
  episodeId?: string;
};

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WD_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const S = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
const key = (y: number, m: number, d: number) => `${y}-${m}-${d}`;
// Melbourne wall time (#20): items bucket onto the day they publish in
// Australia/Melbourne, not the server's or browser's zone.
const hhmm = (iso: string) => {
  const p = zonedParts(iso);
  return `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
};

export function ScheduleCalendar({
  items,
  initialYear,
  initialMonth,
  channels = [],
  reprojectChannelId,
}: {
  items: CalItem[];
  /** month to open on (defaults to today) */
  initialYear?: number;
  initialMonth?: number; // 0-11
  /** channel filter chips (id+name+format); omit/empty to hide the filter */
  channels?: { id: string; name: string; format: "long" | "short" }[];
  /** channel Schedule tab only: show the "Respread tentative slots" button */
  reprojectChannelId?: string;
}) {
  // "today" and month default follow the Melbourne calendar, wherever rendered
  const today = zonedParts(new Date());
  const router = useRouter();
  const [year, setYear] = useState(initialYear ?? today.y);
  const [month, setMonth] = useState(initialMonth ?? today.m);
  const [chan, setChan] = useState<string>("all");
  const [sel, setSel] = useState<string | null>(key(today.y, today.m, today.d));
  const [openItem, setOpenItem] = useState<CalItem | null>(null);
  // drag-and-drop rescheduling: tentative slots move the episode projection,
  // uploaded scheduled videos move the native YouTube schedule
  const [dragItem, setDragItem] = useState<CalItem | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [moving, startMoving] = useTransition();
  const [moveError, setMoveError] = useState<string | null>(null);

  const draggable = (it: CalItem) =>
    (it.tentative && !!it.episodeId) || (!!it.controllable && it.status === "scheduled" && !!it.publicationId);

  const dropOn = (y: number, m: number, d: number) => {
    const it = dragItem;
    setDragItem(null);
    setDragOver(null);
    if (!it) return;
    // keep the item's Melbourne wall-clock time on the new day
    const p = zonedParts(it.at);
    const naive = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
    const iso = zonedInputToIso(naive);
    setMoveError(null);
    startMoving(async () => {
      const res = it.tentative
        ? await moveTentativeSlotAction(it.episodeId!, iso)
        : await reschedulePublicationAction(it.publicationId!, iso);
      if (res?.error) setMoveError(res.error);
      else router.refresh();
    });
  };

  const shown = items.filter((i) => chan === "all" || i.channelId === chan);
  // bucket items by their Melbourne y-m-d
  const byDay = new Map<string, CalItem[]>();
  for (const it of shown) {
    const p = zonedParts(it.at);
    const k = key(p.y, p.m, p.d);
    (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(it);
  }
  for (const arr of byDay.values()) arr.sort((a, b) => +new Date(a.at) - +new Date(b.at));

  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayK = key(today.y, today.m, today.d);

  // which formats to hint daypart slots for, given the active filter
  const activeFormats = new Set(
    (chan === "all" ? channels : channels.filter((c) => c.id === chan)).map((c) => c.format),
  );
  const slotLabel = (dow: number): string => {
    if (activeFormats.has("short") && [4, 5, 6].includes(dow)) return "shorts slot";
    if (activeFormats.has("long") && [0, 1, 2].includes(dow)) return "long slot";
    return "";
  };

  const step = (delta: number) => {
    const m = month + delta;
    setMonth(((m % 12) + 12) % 12);
    setYear(year + Math.floor(m / 12));
    setSel(null);
  };

  const cells: React.ReactNode[] = [];
  const prevDays = new Date(year, month, 0).getDate();
  for (let i = firstDow - 1; i >= 0; i--) {
    cells.push(<div key={`p${i}`} className="sc-day out"><div className="sc-dn">{prevDays - i}</div></div>);
  }
  // Equal-cell grid (#28 calendar rebuild): every cell is the same fixed size,
  // so the pill list is CAPPED — extra items collapse into a "+N more" line and
  // the cell click (existing behaviour) opens the day detail below. On mobile
  // the pills swap for status dots + a count (CSS decides which is visible).
  const MAX_PILLS = 2;
  const MAX_DOTS = 3;
  for (let d = 1; d <= daysInMonth; d++) {
    const k = key(year, month, d);
    const dow = new Date(year, month, d).getDay();
    const its = byDay.get(k) ?? [];
    const slot = its.length === 0 ? slotLabel(dow) : "";
    const kind = (it: CalItem) => (it.status === "published" ? "pub" : it.tentative ? "tent" : "sched");
    // droppable while a drag is live and the day is in the future
    const isFuture =
      new Date(year, month, d).getTime() > new Date(today.y, today.m, today.d).getTime();
    const canDrop = !!dragItem && isFuture;
    cells.push(
      <button
        type="button"
        key={k}
        className={`sc-day${k === todayK ? " today" : ""}${k === sel ? " sel" : ""}${canDrop && dragOver === k ? " sc-dropover" : ""}`}
        onClick={() => setSel(k)}
        onDragOver={(e) => {
          if (!canDrop) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (dragOver !== k) setDragOver(k);
        }}
        onDragLeave={() => dragOver === k && setDragOver(null)}
        onDrop={(e) => {
          if (!canDrop) return;
          e.preventDefault();
          dropOn(year, month, d);
        }}
      >
        <div className="sc-dn"><span>{d}</span></div>
        {slot && <div className="sc-slot">{slot}</div>}
        <div className="sc-pills">
          {its.slice(0, MAX_PILLS).map((it, i) => (
            <div
              key={i}
              className={`sc-pill ${kind(it)} sc-${it.format}${draggable(it) ? " sc-drag" : ""}`}
              draggable={draggable(it)}
              onDragStart={(e) => {
                if (!draggable(it)) return;
                e.dataTransfer.effectAllowed = "move";
                setDragItem(it);
              }}
              onDragEnd={() => {
                setDragItem(null);
                setDragOver(null);
              }}
              title={draggable(it) ? "Drag to another day to reschedule" : undefined}
            >
              {it.status === "published" && (
                <svg {...S} strokeWidth={3}><path d="M20 6 9 17l-5-5" /></svg>
              )}
              <span className="pt">{hhmm(it.at)}</span>
              <span className="px">{it.title}</span>
            </div>
          ))}
          {its.length > MAX_PILLS && <div className="sc-more">+{its.length - MAX_PILLS} more</div>}
        </div>
        {its.length > 0 && (
          <div className="sc-dots" aria-hidden>
            {its.slice(0, MAX_DOTS).map((it, i) => (
              <span key={i} className={`sc-dot ${kind(it)} sc-${it.format}`} />
            ))}
            {its.length > MAX_DOTS && <span className="sc-dcount">+{its.length - MAX_DOTS}</span>}
          </div>
        )}
      </button>,
    );
  }
  const tail = (7 - ((firstDow + daysInMonth) % 7)) % 7;
  for (let j = 1; j <= tail; j++) {
    cells.push(<div key={`n${j}`} className="sc-day out"><div className="sc-dn">{j}</div></div>);
  }

  const selItems = sel ? byDay.get(sel) ?? [] : [];
  const selDate = sel ? sel.split("-").map(Number) : null;

  return (
    <div>
      <div className="sc-controls">
        {channels.length > 1 ? (
          <div className="seg">
            <button type="button" className={chan === "all" ? "on" : ""} onClick={() => setChan("all")}>All channels</button>
            {channels.map((c) => (
              <button type="button" key={c.id} className={chan === c.id ? "on" : ""} onClick={() => setChan(c.id)}>
                <span style={{ width: 8, height: 8, borderRadius: 3, background: c.format === "long" ? "var(--accent)" : "var(--info)" }} />
                {c.name}
              </button>
            ))}
          </div>
        ) : <div />}
        <div className="sc-nav">
          {reprojectChannelId && (
            <button
              type="button"
              className="btn ghost"
              disabled={moving}
              title="Recompute every tentative slot under the current cadence — evenly spread, weekdays first. Locked (uploaded) schedules don't move."
              onClick={() => {
                setMoveError(null);
                startMoving(async () => {
                  const res = await reprojectTentativeSlotsAction(reprojectChannelId);
                  if (res?.error) setMoveError(res.error);
                  else router.refresh();
                });
              }}
            >
              Respread tentative slots
            </button>
          )}
          <button type="button" className="sc-navbtn" onClick={() => step(-1)} aria-label="Previous month">
            <svg {...S}><path d="m15 18-6-6 6-6" /></svg>
          </button>
          <b>{MONTHS[month]} {year}</b>
          <button type="button" className="sc-navbtn" onClick={() => step(1)} aria-label="Next month">
            <svg {...S}><path d="m9 18 6-6-6-6" /></svg>
          </button>
        </div>
      </div>

      {(moving || moveError) && (
        <div style={{ margin: "0 0 8px" }}>
          {moving && <span className="muted" style={{ fontSize: 12.5 }}>Moving…</span>}
          {moveError && <div className="err">{moveError}</div>}
        </div>
      )}

      <div className="sc-cal">
        <div className="sc-head">{WD.map((w) => <div key={w}>{w}</div>)}</div>
        <div className="sc-grid">{cells}</div>
      </div>

      <div className="sc-legend">
        <span><span className="sc-lg" style={{ background: "var(--good)" }} />Published</span>
        <span><span className="sc-lg" style={{ background: "var(--accent)" }} />Scheduled · long-form</span>
        <span><span className="sc-lg" style={{ background: "var(--info)" }} />Scheduled · shorts</span>
        <span><span className="sc-lg sc-lg-tent" />Tentative · series slot</span>
        <span className="muted">Drag a slot onto another day to reschedule it</span>
      </div>

      {sel && selDate && (
        <div className="sc-detail">
          <div className="sc-detail-h">
            {WD_LONG[new Date(selDate[0]!, selDate[1]!, selDate[2]!).getDay()]}, {MONTHS[selDate[1]!]} {selDate[2]}
            <span className="cnt">{selItems.length} item{selItems.length === 1 ? "" : "s"}</span>
          </div>
          <div>
            {selItems.length === 0 ? (
              <div className="sc-drow"><span className="muted">Nothing scheduled on this day.</span></div>
            ) : (
              selItems.map((it, i) => {
                const row = (
                  <>
                    <div className="stripe" />
                    <div className="dt">{hhmm(it.at)}</div>
                    <div className="dtitle">{it.title}<small>{it.channelName} · {it.format === "long" ? "long-form" : "shorts"}</small></div>
                    <span className={`chip ${it.status === "published" ? "good" : it.tentative ? "" : "acc"}`}><span className="d" />{it.status === "published" ? "Published" : it.tentative ? "Tentative" : "Scheduled"}</span>
                  </>
                );
                const dragProps = draggable(it)
                  ? {
                      draggable: true,
                      onDragStart: (e: React.DragEvent) => {
                        e.dataTransfer.effectAllowed = "move";
                        setDragItem(it);
                      },
                      onDragEnd: () => {
                        setDragItem(null);
                        setDragOver(null);
                      },
                      title: "Drag onto a calendar day to reschedule",
                    }
                  : {};
                // tentative slots are projections, not uploads — no publish controls
                return it.productionId && !it.tentative ? (
                  <button
                    type="button"
                    key={i}
                    className={`sc-drow sc-${it.format} sc-click${draggable(it) ? " sc-drag" : ""}`}
                    onClick={() => setOpenItem(it)}
                    {...dragProps}
                  >
                    {row}
                  </button>
                ) : (
                  <div
                    key={i}
                    className={`sc-drow sc-${it.format}${it.tentative ? " sc-tent" : ""}${draggable(it) ? " sc-drag" : ""}`}
                    {...dragProps}
                  >
                    {row}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {openItem && <CalItemDialog item={openItem} onClose={() => setOpenItem(null)} />}
    </div>
  );
}

/**
 * The click-a-video control popup (#20): reschedule / publish now / cancel a
 * natively-scheduled release without leaving the platform — each action is one
 * server call that updates YouTube (videos.update / release) and the calendar.
 */
function CalItemDialog({ item, onClose }: { item: CalItem; onClose: () => void }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [newTime, setNewTime] = useState("");
  const canControl = !!(item.controllable && item.publicationId && item.status === "scheduled");

  const run = (fn: () => Promise<{ error?: string } | void>) =>
    startTransition(async () => {
      setError(null);
      const res = await fn();
      if (res && "error" in res && res.error) setError(res.error);
      else onClose();
    });

  return (
    <Dialog open onClose={onClose} title={item.title}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <span className={`chip ${item.status === "published" ? "good" : "acc"}`}>
          <span className="d" />
          {item.status === "published" ? "Published" : "Scheduled"}
        </span>
        <span className="chip">{fmtDateTime(item.at)} {tzAbbr(item.at)}</span>
        <span className="chip">{item.channelName}</span>
      </div>

      {canControl ? (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button
              type="button"
              className="btn"
              disabled={pending}
              onClick={() => run(() => releasePublicationAction(item.publicationId!))}
            >
              Publish now
            </button>
            <button
              type="button"
              className="btn ghost danger-ink"
              disabled={pending}
              onClick={() => run(() => cancelScheduledReleaseAction(item.publicationId!))}
            >
              Cancel schedule
            </button>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 12 }}>
            <input
              type="datetime-local"
              value={newTime}
              onChange={(e) => setNewTime(e.target.value)}
              aria-label={`New release time (${tzAbbr()})`}
            />
            <button
              type="button"
              className="btn ghost"
              disabled={pending}
              onClick={() =>
                newTime
                  ? run(() => reschedulePublicationAction(item.publicationId!, zonedInputToIso(newTime)))
                  : setError("Pick the new date and time first.")
              }
            >
              Move schedule
            </button>
            <span className="muted" style={{ fontSize: 12 }}>Melbourne time ({tzAbbr()})</span>
          </div>
          <p className="muted" style={{ margin: "10px 0 0", fontSize: 12 }}>
            Changes propagate straight to YouTube — publish-now overrides the slot, moving updates
            the native schedule, cancelling keeps the video private until you release it.
          </p>
          {pending && <p className="muted" style={{ margin: "8px 0 0", fontSize: 12.5 }}>Working…</p>}
          {error && <div className="err">{error}</div>}
        </>
      ) : item.status === "scheduled" ? (
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
          This video hasn&apos;t uploaded yet — controls appear once it&apos;s on YouTube&apos;s
          scheduler. Manage it from the production page.
        </p>
      ) : null}

      {item.productionId && (
        <p style={{ margin: "14px 0 0" }}>
          <Link href={`/productions/${item.productionId}`} style={{ color: "var(--accent-ink)", fontWeight: 600 }}>
            Open production →
          </Link>
        </p>
      )}
    </Dialog>
  );
}
