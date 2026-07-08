import { IconAlertTriangle } from "@/components/icons";
import { claimTierLabel } from "@/lib/format";

/**
 * Compact, positively-framed replacement for the old red "Verification cost"
 * panel. One line of research-health stats; a gentle warning only when a large
 * share of facts is being cut (a signal the corroboration bar may be too high);
 * and the list of cut facts tucked behind a native <details> disclosure.
 */
export function ResearchHealth({
  stats,
  cut,
  bar,
}: {
  stats: Record<string, number>;
  cut: { text: string; tier: string; episodeTitle: string }[];
  bar: number;
}) {
  const verified = stats.verified ?? 0;
  const attributed = stats.attributed ?? 0;
  const cutN = stats.cut ?? 0;
  const decided = verified + attributed + cutN;
  if (decided === 0) return null; // nothing checked yet — no strip

  const cutPct = Math.round((cutN / decided) * 100);
  const barHigh = cutN > verified || cutPct >= 40;

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="panel-body">
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <strong style={{ fontSize: 13 }}>Research health</strong>
          <span className="chip">bar ≥{bar} sources</span>
          <span className="chip good">{verified} verified</span>
          <span className="chip">{attributed} attributed</span>
          <span className="chip">
            {cutN} cut ({cutPct}%)
          </span>
        </div>

        {barHigh && (
          <p
            className="muted"
            style={{ margin: "10px 0 0", fontSize: 12.5, display: "flex", gap: 6, alignItems: "flex-start" }}
          >
            <span style={{ color: "var(--warn, #b45309)", flexShrink: 0, marginTop: 1 }}>
              <IconAlertTriangle />
            </span>
            <span>
              A large share of facts are being cut. The corroboration bar may be too high for this
              niche — lower it or turn on present-the-debate in <strong>Settings &amp; DNA → Charter</strong>.
            </span>
          </p>
        )}

        {cut.length > 0 && (
          <details style={{ marginTop: 10 }}>
            <summary className="muted" style={{ cursor: "pointer", fontSize: 12.5 }}>
              Review {cut.length} cut fact{cut.length === 1 ? "" : "s"}
            </summary>
            <div className="tablewrap" style={{ marginTop: 8 }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>Fact</th>
                    <th>Tier</th>
                    <th>Episode</th>
                  </tr>
                </thead>
                <tbody>
                  {cut.map((c, i) => (
                    <tr key={i}>
                      <td>{c.text}</td>
                      <td className="muted" style={{ whiteSpace: "nowrap" }}>
                        <span className="chip">{claimTierLabel(c.tier)}</span>
                      </td>
                      <td className="muted" style={{ whiteSpace: "nowrap" }}>
                        {c.episodeTitle}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
