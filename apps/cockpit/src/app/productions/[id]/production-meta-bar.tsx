"use client";

import { useState } from "react";
import { Dialog } from "@/components/ui";
import {
  costCategoryLabel,
  fmtDateTime,
  fmtDuration,
  fmtMoney,
  gateDecisionLabel,
  gateKindLabel,
} from "@/lib/format";
import { IconFileText, IconDollar, IconReview } from "@/components/icons";

/**
 * Compact secondary-info bar for the production page (2026-07-16 layout pass):
 * Script, Cost breakdown and Review history are reference material, not the
 * focus — they open in modals from small header buttons instead of eating a
 * whole right-hand column, so the beat-visuals storyboard can run full width.
 */
export type MetaScript = { version: number; beats: { type: string; text: string; estSec?: number | null }[]; wordCount: number };
export type MetaCost = { id: string; category: string; provider: string; model: string | null; costUsd: number };
export type MetaGate = { id: string; kind: string; status: string; decision: string | null; notes: string | null; decidedAt: string | null };

function beatLabel(type: string): string {
  return type === "cta" ? "CTA" : type.charAt(0).toUpperCase() + type.slice(1);
}

export function ProductionMetaBar({
  script,
  costs,
  total,
  gates,
}: {
  script: MetaScript | null;
  costs: MetaCost[];
  total: number;
  gates: MetaGate[];
}) {
  const [open, setOpen] = useState<null | "script" | "costs" | "history">(null);

  return (
    <>
      {script && (
        <button type="button" className="btn ghost sm" onClick={() => setOpen("script")}>
          <IconFileText /> Script v{script.version}
        </button>
      )}
      <button type="button" className="btn ghost sm" onClick={() => setOpen("costs")}>
        <IconDollar /> Costs {fmtMoney(total)}
      </button>
      {gates.length > 0 && (
        <button type="button" className="btn ghost sm" onClick={() => setOpen("history")}>
          <IconReview /> Review history
        </button>
      )}

      <Dialog
        open={open === "script"}
        onClose={() => setOpen(null)}
        title={script ? `Script — v${script.version}` : "Script"}
      >
        {script && (
          <div>
            {script.beats.map((b, i) => (
              <p key={i} style={{ margin: "0 0 10px" }}>
                <span className="chip" style={{ marginRight: 7 }}>
                  {beatLabel(b.type)}
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
              {script.wordCount} words · ~{fmtDuration(Math.round(script.wordCount / 2.5))} of narration (est.)
            </p>
          </div>
        )}
      </Dialog>

      <Dialog open={open === "costs"} onClose={() => setOpen(null)} title="Cost breakdown">
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
                  <td className="r">{fmtMoney(c.costUsd)}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={2}>
                  <strong>Total</strong>
                </td>
                <td className="r">
                  <strong>{fmtMoney(total)}</strong>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Dialog>

      <Dialog open={open === "history"} onClose={() => setOpen(null)} title="Review history">
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
      </Dialog>
    </>
  );
}
