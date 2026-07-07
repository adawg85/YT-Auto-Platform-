import type { ReactNode } from "react";

/** KPI tile (replaces hand-rolled `.kpi`). Numbers render in the mono/tabular face. */
export function StatTile({
  label,
  value,
  unit,
  sub,
  delta,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  sub?: ReactNode;
  delta?: { dir: "up" | "down"; text: ReactNode };
}) {
  return (
    <div className="kpi">
      <div className="lab">{label}</div>
      <div className="val num">
        {value}
        {unit ? <small> {unit}</small> : null}
      </div>
      {(sub || delta) && (
        <div className="metric-help">
          {delta ? <span className={`delta ${delta.dir}`}>{delta.text}</span> : null}
          {delta && sub ? " · " : null}
          {sub}
        </div>
      )}
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="kpis">{children}</div>;
}
