import { IconAlertTriangle } from "@/components/icons";
import { Disclosure } from "@/components/ui";
import { claimTierLabel } from "@/lib/format";

/**
 * Research health (#20 polish): three stat tiles + a proportion bar instead of
 * a chip line, with the cut facts behind a disclosure. A gentle warning shows
 * only when a large share of facts is being cut (the corroboration bar may be
 * too high for the niche).
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

  const pct = (n: number) => Math.round((n / decided) * 100);
  const cutPct = pct(cutN);
  const barHigh = cutN > verified || cutPct >= 40;

  return (
    <div style={{ margin: "16px 0" }}>
      <div className="kpis" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
        <div className="kpi">
          <div className="lab">Verified</div>
          <div className="val num" style={{ color: "var(--good)" }}>
            {verified}
          </div>
          <div className="metric-help">asserted with citations</div>
        </div>
        <div className="kpi">
          <div className="lab">Attributed</div>
          <div className="val num" style={{ color: "var(--info)" }}>
            {attributed}
          </div>
          <div className="metric-help">framed as &ldquo;reported&rdquo;</div>
        </div>
        <div className="kpi">
          <div className="lab">Cut</div>
          <div className="val num" style={{ color: cutN ? "var(--crit)" : undefined }}>
            {cutN}
          </div>
          <div className="metric-help">didn&apos;t meet the ≥{bar}-source bar</div>
        </div>
      </div>
      <div className="propbar">
        {verified > 0 && <i style={{ width: `${pct(verified)}%`, background: "var(--good)" }} />}
        {attributed > 0 && <i style={{ width: `${pct(attributed)}%`, background: "var(--info)" }} />}
        {cutN > 0 && <i style={{ width: `${cutPct}%`, background: "var(--crit)" }} />}
      </div>
      <div className="propleg">
        <span>
          <i style={{ background: "var(--good)" }} />
          {pct(verified)}% verified
        </span>
        <span>
          <i style={{ background: "var(--info)" }} />
          {pct(attributed)}% attributed
        </span>
        <span>
          <i style={{ background: "var(--crit)" }} />
          {cutPct}% cut
        </span>
      </div>

      {barHigh && (
        <p
          className="muted"
          style={{ margin: "10px 0 0", fontSize: 12.5, display: "flex", gap: 6, alignItems: "flex-start" }}
        >
          <span style={{ color: "var(--warn)", flexShrink: 0, marginTop: 1 }}>
            <IconAlertTriangle />
          </span>
          <span>
            A large share of facts are being cut — the corroboration bar may be too high for this
            niche. Lower it (the <strong>bar chip</strong> above, or Settings &amp; DNA → Charter) or
            turn on present-the-debate.
          </span>
        </p>
      )}

      {cut.length > 0 && (
        <Disclosure summary={`See the ${cut.length} cut fact${cut.length === 1 ? "" : "s"}`}>
          <div className="tablewrap">
            <table className="data">
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
        </Disclosure>
      )}
    </div>
  );
}
