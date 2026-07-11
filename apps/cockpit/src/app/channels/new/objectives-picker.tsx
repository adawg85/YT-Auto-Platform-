"use client";

import { useEffect, useMemo, useState } from "react";
import { IconCheck } from "@/components/icons";

/**
 * Objectives builder: a set of preset objective templates the operator ticks,
 * each with a +/- counter, plus a freeform area for anything custom. Compiles
 * to the newline-separated `objectives` string the wizard already persists, and
 * parses an existing/AI-drafted list back onto the presets on mount.
 */
type Preset = {
  id: string;
  desc: string;
  render: (n: number) => string;
  parse: RegExp; // capture group 1 = the number (commas allowed)
  default: number;
  min: number;
  max?: number;
  step: number;
  unit?: string;
};

const PRESETS: Preset[] = [
  {
    id: "subs",
    desc: "Reach a subscriber milestone",
    render: (n) => `Reach ${n.toLocaleString()} subscribers`,
    parse: /reach\s+([\d,]+)\s+subscribers/i,
    default: 1000,
    min: 100,
    step: 500,
  },
  // NOTE: "Publish N videos in the first month" and "Sustain N videos/week"
  // presets were removed — the Blueprint step's release plan owns publishing
  // cadence (the wizard shows a read-only publishing-plan line instead).
  {
    id: "retention",
    desc: "Average view retention",
    render: (n) => `Hit ${n}% average view retention`,
    parse: /([\d,]+)%\s+average view retention/i,
    default: 50,
    min: 10,
    max: 95,
    step: 5,
    unit: "%",
  },
  {
    id: "views",
    desc: "Total views milestone",
    render: (n) => `Reach ${n.toLocaleString()} total views`,
    parse: /reach\s+([\d,]+)\s+total views/i,
    default: 100_000,
    min: 1000,
    step: 50_000,
  },
];

const num = (s: string) => Number(s.replace(/,/g, ""));

type PresetState = { on: boolean; value: number };

export function ObjectivesPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (objectives: string) => void;
}) {
  // Initialise once from the incoming objectives: tick presets whose line is
  // present (with their number), route everything else to the custom area.
  const initial = useMemo(() => {
    const lines = value.split("\n").map((l) => l.trim()).filter(Boolean);
    const state: Record<string, PresetState> = {};
    const leftover: string[] = [];
    for (const p of PRESETS) state[p.id] = { on: false, value: p.default };
    for (const line of lines) {
      const hit = PRESETS.find((p) => p.parse.test(line));
      if (hit) {
        const m = hit.parse.exec(line);
        state[hit.id] = { on: true, value: m ? num(m[1]!) : hit.default };
      } else {
        leftover.push(line);
      }
    }
    return { state, custom: leftover.join("\n") };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [presets, setPresets] = useState<Record<string, PresetState>>(initial.state);
  const [custom, setCustom] = useState(initial.custom);

  // Recompile to the parent whenever a toggle, counter or custom line changes.
  useEffect(() => {
    const lines = [
      ...PRESETS.filter((p) => presets[p.id]?.on).map((p) => p.render(presets[p.id]!.value)),
      ...custom.split("\n").map((l) => l.trim()).filter(Boolean),
    ];
    onChange(lines.join("\n"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presets, custom]);

  const toggle = (id: string) =>
    setPresets((s) => ({ ...s, [id]: { ...s[id]!, on: !s[id]!.on } }));
  const bump = (p: Preset, dir: 1 | -1) =>
    setPresets((s) => {
      const cur = s[p.id]!;
      let v = cur.value + dir * p.step;
      v = Math.max(p.min, p.max ? Math.min(p.max, v) : v);
      return { ...s, [p.id]: { on: true, value: v } };
    });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {PRESETS.map((p) => {
        const st = presets[p.id]!;
        return (
          <div
            key={p.id}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              padding: "8px 10px",
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: st.on ? "var(--accent-soft)" : "var(--surface)",
            }}
          >
            <button
              type="button"
              onClick={() => toggle(p.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                background: "transparent",
                border: "none",
                boxShadow: "none",
                color: "var(--text)",
                height: "auto",
                padding: 0,
                cursor: "pointer",
                fontWeight: 500,
                fontSize: 13.5,
                textAlign: "left",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 5,
                  border: `1px solid ${st.on ? "var(--accent)" : "var(--border-strong)"}`,
                  background: st.on ? "var(--accent)" : "transparent",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#fff",
                  flex: "none",
                }}
              >
                {st.on && <IconCheck />}
              </span>
              {p.desc}
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => bump(p, -1)}
                aria-label={`decrease ${p.desc}`}
                style={{ width: 30, padding: 0 }}
              >
                −
              </button>
              <span
                className="mono"
                style={{ minWidth: 74, textAlign: "center", fontSize: 13, fontWeight: 600 }}
              >
                {st.value.toLocaleString()}
                {p.unit ?? ""}
              </span>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => bump(p, 1)}
                aria-label={`increase ${p.desc}`}
                style={{ width: 30, padding: 0 }}
              >
                +
              </button>
            </div>
          </div>
        );
      })}
      <label style={{ marginBottom: 0 }}>
        Custom objectives <span className="muted">(one per line)</span>
        <textarea
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          rows={2}
          placeholder="anything not covered above"
        />
      </label>
    </div>
  );
}
