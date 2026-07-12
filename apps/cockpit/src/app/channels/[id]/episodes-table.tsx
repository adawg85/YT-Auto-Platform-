"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Dialog } from "@/components/ui/dialog";
import { IconExternal, IconMore } from "@/components/icons";
import { episodeStatusLabel, claimTierLabel, prodStatusLabel } from "@/lib/format";
import {
  cutEpisodeAction,
  forceAcceptResearchAction,
  loadEpisodeFactsAction,
  regreenlightEpisodeAction,
  replaceEpisodeAction,
  type EpisodeFacts,
  type EpisodeFact,
} from "../editorial-actions";
import { scoreIdeaAction, greenlightAction } from "@/app/actions";
import type { EpisodeWithClaims } from "@/lib/plan";

/** Production-status → chip tone for the inline pipeline column. */
const PROD_BADGE: Record<string, string> = {
  published: "green",
  produced: "green",
  scheduled: "accent",
  ready: "accent",
  on_hold: "amber",
  halted: "amber",
  failed: "red",
  rejected: "red",
};

/**
 * "Next step" cell (#19): move an editorial episode through the pipeline without
 * leaving the Plan tab. Shows the live production status once greenlit, or a
 * score + Score/Greenlight actions while the idea is still in the pool.
 */
function NextStep({ e }: { e: EpisodeWithClaims }) {
  if (e.productionId) {
    return (
      <Link className="linklike" href={`/productions/${e.productionId}`}>
        <span className={`badge ${PROD_BADGE[e.productionStatus ?? ""] ?? "accent"}`}>
          {prodStatusLabel(e.productionStatus ?? "in production")}
        </span>
      </Link>
    );
  }
  // a cut episode isn't produceable, even if a stale idea link lingers
  if (e.status === "cut" || !e.ideaId) return <span className="muted">—</span>;
  const ideaId = e.ideaId;
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      {e.score != null ? (
        <span className="badge green" title="rubric score / 10">
          {e.score.toFixed(1)}
        </span>
      ) : (
        <form action={scoreIdeaAction.bind(null, ideaId)}>
          <button type="submit" className="btn sm ghost">Score</button>
        </form>
      )}
      <form action={greenlightAction.bind(null, ideaId)}>
        <button type="submit" className="btn sm">Greenlight</button>
      </form>
    </div>
  );
}

const EPISODE_BADGE: Record<string, string> = {
  planned: "",
  researching: "accent",
  verifying: "accent",
  briefed: "amber",
  queued: "amber",
  produced: "green",
  published: "green",
  cut: "red",
};

/** Fact-check tally pills (✓ verified · ~ attributed · ✗ cut). */
function FactTally({ e }: { e: EpisodeWithClaims }) {
  if (e.verifiedClaims + e.attributedClaims + e.cutClaims === 0) return null;
  return (
    <span style={{ display: "inline-flex", gap: 4 }} title="Facts checked — ✓ verified · ~ attributed · ✗ cut">
      <span className="fpill v">✓{e.verifiedClaims}</span>
      {e.attributedClaims > 0 && <span className="fpill a">~{e.attributedClaims}</span>}
      {e.cutClaims > 0 && <span className="fpill c">✗{e.cutClaims}</span>}
    </span>
  );
}

/** Episode-status → row dot colour (pulses while the engine is working). */
const EPISODE_DOT: Record<string, { color: string; pulse?: boolean }> = {
  planned: { color: "var(--border-strong)" },
  researching: { color: "var(--accent)", pulse: true },
  verifying: { color: "var(--accent)", pulse: true },
  briefed: { color: "var(--warn)" },
  queued: { color: "var(--warn)" },
  produced: { color: "var(--good)" },
  published: { color: "var(--good)" },
  cut: { color: "var(--crit)" },
};

/** Terminal production states from which a fresh from-scratch run makes sense. */
const RESTARTABLE = new Set(["halted", "failed", "rejected", "on_hold"]);

type MenuAction = "cut" | "replace" | "regreenlight" | "accept";

/**
 * Per-episode ⋯ menu (2026-07-12 operator ask): stop & cut, replace with a
 * fresh idea (optional direction), or re-greenlight from the start — all
 * without leaving the Plan tab. Each action opens a small confirm dialog;
 * replace/cut carry an optional comment that lands in the decision log.
 */
function EpisodeMenu({ e }: { e: EpisodeWithClaims }) {
  const router = useRouter();
  // dialog-based (2026-07-12 mobile fix): the old absolute popover clipped
  // under the panel border on phones — a Dialog (bottom sheet on mobile)
  // can never clip. "menu" shows the action list; picking swaps the view.
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<MenuAction | null>(null);
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (e.status === "cut" || e.status === "published") return null;

  const canRegreenlight =
    !!e.ideaId && (!e.productionId || RESTARTABLE.has(e.productionStatus ?? ""));
  // force-accept: mid-research with at least one checked fact and no idea yet
  const canForceAccept =
    !e.ideaId &&
    ["planned", "researching", "verifying", "briefed"].includes(e.status) &&
    e.verifiedClaims + e.attributedClaims > 0;

  const pick = (a: MenuAction) => {
    setAction(a);
    setNote("");
    setError(null);
    setDone(null);
  };
  const closeAll = () => {
    setOpen(false);
    setAction(null);
  };

  const run = () =>
    startTransition(async () => {
      setError(null);
      const res: { error?: string; replacementTitle?: string; tellable?: number } =
        action === "cut"
          ? await cutEpisodeAction(e.id, note)
          : action === "replace"
            ? await replaceEpisodeAction(e.id, note)
            : action === "accept"
              ? await forceAcceptResearchAction(e.id)
              : await regreenlightEpisodeAction(e.id);
      if (res?.error) {
        setError(res.error);
        return;
      }
      if (action === "replace" && res.replacementTitle) {
        setDone(`Replaced with "${res.replacementTitle}" — research is starting.`);
      } else {
        setOpen(false);
        setAction(null);
      }
      router.refresh();
    });

  const TITLES: Record<MenuAction, string> = {
    cut: `Stop & cut — ${e.title}`,
    replace: `Replace — ${e.title}`,
    regreenlight: `Re-greenlight — ${e.title}`,
    accept: `Accept facts & queue — ${e.title}`,
  };

  return (
    <span style={{ display: "inline-flex" }}>
      <button
        type="button"
        className="btn sm ghost"
        aria-label="Episode actions"
        title="Episode actions"
        onClick={() => {
          setAction(null);
          setOpen(true);
        }}
      >
        <IconMore />
      </button>

      <Dialog
        open={open}
        onClose={() => !pending && closeAll()}
        title={action ? TITLES[action] : e.title}
      >
        {action === null && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button type="button" className="btn ghost" style={{ justifyContent: "flex-start" }} onClick={() => pick("replace")}>
              Replace with a new idea…
            </button>
            {canRegreenlight && (
              <button type="button" className="btn ghost" style={{ justifyContent: "flex-start" }} onClick={() => pick("regreenlight")}>
                Re-greenlight from the start
              </button>
            )}
            {canForceAccept && (
              <button type="button" className="btn ghost" style={{ justifyContent: "flex-start" }} onClick={() => pick("accept")}>
                Accept facts &amp; queue now ({e.verifiedClaims + e.attributedClaims} checked)
              </button>
            )}
            <button type="button" className="btn ghost danger-ink" style={{ justifyContent: "flex-start" }} onClick={() => pick("cut")}>
              Stop &amp; cut episode…
            </button>
          </div>
        )}
        {action === "cut" && (
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            Stops any running production (kept as a resumable draft), retires the idea, and takes
            the episode off the plan and calendar. A scheduled/published video must be handled on
            its production page first.
          </p>
        )}
        {action === "replace" && (
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            Cuts this episode and asks the planner for one materially-different replacement in the
            same series — it inherits this episode&apos;s calendar slot and goes straight to research.
          </p>
        )}
        {action === "accept" && (
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            Stops this episode&apos;s fact-searching, writes the brief from the facts already
            checked, and queues it for production — your call that the research is enough. Other
            episodes&apos; research keeps running.
          </p>
        )}
        {action === "regreenlight" && (
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            Starts a completely fresh production run for this episode&apos;s idea — nothing from the
            previous attempt is reused (it stays available as a draft on its production page).
          </p>
        )}
        {action !== null && action !== "regreenlight" && action !== "accept" && (
          <>
            <label className="field-label" htmlFor={`ep-note-${e.id}`}>
              {action === "replace" ? "Direction for the replacement (optional)" : "Note (optional, kept in the decision log)"}
            </label>
            <textarea
              id={`ep-note-${e.id}`}
              rows={2}
              placeholder={
                action === "replace"
                  ? "e.g. Lean into a human story — a pilot or engineer, not another aircraft type."
                  : "Why this episode is going."
              }
              value={note}
              onChange={(ev) => setNote(ev.target.value)}
            />
          </>
        )}
        {action !== null && (
        <div className="actions" style={{ marginTop: 12 }}>
          {!done && (
            <button
              type="button"
              className={`btn ${action === "cut" ? "ghost danger-ink" : ""}`}
              disabled={pending}
              onClick={run}
            >
              {action === "cut" ? "Stop & cut" : action === "replace" ? "Replace episode" : action === "accept" ? "Accept & queue" : "Re-greenlight"}
            </button>
          )}
          <button
            type="button"
            className="btn ghost"
            disabled={pending}
            onClick={() => (done ? closeAll() : setAction(null))}
          >
            {done ? "Close" : "Back"}
          </button>
          {pending && <span className="muted" style={{ fontSize: 12.5 }}>{action === "replace" ? "Asking the planner…" : "Working…"}</span>}
        </div>
        )}
        {done && <p style={{ margin: "10px 0 0", fontSize: 13 }}>{done}</p>}
        {error && <div className="err">{error}</div>}
      </Dialog>
    </span>
  );
}

const FACT_GROUPS: { status: string; label: string; badge: string }[] = [
  { status: "verified", label: "Verified", badge: "green" },
  { status: "attributed", label: "Attributed — framed as reported", badge: "amber" },
  { status: "cut", label: "Cut — didn't reach the bar", badge: "red" },
];

function FactRow({ f }: { f: EpisodeFact }) {
  return (
    <div style={{ padding: "8px 0", borderTop: "1px solid var(--border)" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <span className={`badge ${FACT_GROUPS.find((g) => g.status === f.status)?.badge ?? ""}`}>
          {claimTierLabel(f.tier)}
        </span>
        <span>{f.text}</span>
      </div>
      {f.citations.length > 0 && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 4 }}>
          {f.citations.map((c, i) => (
            <a
              key={i}
              href={c.url}
              target="_blank"
              rel="noopener noreferrer"
              className="muted"
              title={c.title}
              style={{ fontSize: 12, display: "inline-flex", gap: 3, alignItems: "center" }}
            >
              {c.domain}
              <IconExternal />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export function EpisodesTable({ episodes }: { episodes: EpisodeWithClaims[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [data, setData] = useState<EpisodeFacts | null>(null);
  const [loading, setLoading] = useState(false);

  async function open(id: string) {
    setOpenId(id);
    setData(null);
    setLoading(true);
    try {
      setData(await loadEpisodeFactsAction(id));
    } finally {
      setLoading(false);
    }
  }
  const close = () => setOpenId(null);

  const openEpisode = episodes.find((e) => e.id === openId);

  return (
    <>
      <div className="eplist">
        {episodes.map((e) => {
          const dot = EPISODE_DOT[e.status] ?? EPISODE_DOT.planned!;
          return (
            <div className="eprow" key={e.id}>
              <span
                className={`dot${dot.pulse ? " pulse" : ""}`}
                style={{ background: dot.color }}
                aria-hidden
              />
              <button type="button" className="linklike t" onClick={() => open(e.id)} title={e.angle}>
                <span className="num muted" style={{ marginRight: 6 }}>{e.position + 1}</span>
                {e.title}
              </button>
              <FactTally e={e} />
              <span className={`badge ${EPISODE_BADGE[e.status] ?? ""}`}>
                {episodeStatusLabel(e.status)}
              </span>
              <NextStep e={e} />
              <EpisodeMenu e={e} />
            </div>
          );
        })}
      </div>

      <Dialog
        open={!!openId}
        onClose={close}
        title={openEpisode ? openEpisode.title : "Episode"}
      >
        {loading && <p className="muted">Loading facts…</p>}
        {!loading && data && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span className={`badge ${EPISODE_BADGE[data.episode.status] ?? ""}`}>
                {episodeStatusLabel(data.episode.status)}
              </span>
              <span className="muted" style={{ fontSize: 13 }}>
                {data.episode.angle}
              </span>
            </div>

            {data.episode.brief && (data.episode.brief.summary || data.episode.brief.hookAngle) && (
              <div>
                <h4 style={{ margin: "0 0 6px" }}>Brief</h4>
                {data.episode.brief.summary && <p style={{ margin: "0 0 6px" }}>{data.episode.brief.summary}</p>}
                {data.episode.brief.hookAngle && (
                  <p className="muted" style={{ margin: "0 0 6px", fontSize: 13 }}>
                    <strong>Hook.</strong> {data.episode.brief.hookAngle}
                  </p>
                )}
                {data.episode.brief.outline && data.episode.brief.outline.length > 0 && (
                  <ul className="muted" style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 13 }}>
                    {data.episode.brief.outline.map((o, i) => (
                      <li key={i}>{o.point}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div>
              <h4 style={{ margin: "0 0 2px" }}>Facts checked</h4>
              {data.facts.length === 0 ? (
                <p className="muted" style={{ fontSize: 13 }}>
                  {["planned", "researching", "verifying"].includes(data.episode.status)
                    ? "Still researching — facts appear here as sources are checked."
                    : "No facts recorded for this episode."}
                </p>
              ) : (
                FACT_GROUPS.map((g) => {
                  const rows = data.facts.filter((f) => f.status === g.status);
                  if (rows.length === 0) return null;
                  return (
                    <div key={g.status} style={{ marginTop: 10 }}>
                      <div className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.4 }}>
                        {g.label} · {rows.length}
                      </div>
                      {rows.map((f) => (
                        <FactRow key={f.id} f={f} />
                      ))}
                    </div>
                  );
                })
              )}
            </div>

            {data.episode.coverageSummary && (
              <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
                {data.episode.coverageSummary}
              </p>
            )}
          </div>
        )}
        {!loading && !data && <p className="muted">Couldn&apos;t load this episode.</p>}
      </Dialog>
    </>
  );
}
