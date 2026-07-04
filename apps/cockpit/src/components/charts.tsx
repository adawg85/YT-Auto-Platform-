// Pure SVG charts rendered from data. No hooks, so they work in Server
// Components. Each takes a unique `id` for its gradient defs.

export function Sparkline({
  data,
  id,
  w = 250,
  h = 34,
  color = "var(--accent)",
}: {
  data: number[];
  id: string;
  w?: number;
  h?: number;
  color?: string;
}) {
  if (data.length < 2) data = [0, 0];
  const max = Math.max(...data);
  const min = Math.min(...data);
  const rng = max - min || 1;
  const step = w / (data.length - 1);
  const pts: [number, number][] = data.map((v, i) => [i * step, h - 2 - ((v - min) / rng) * (h - 6)]);
  const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const last = pts.at(-1) ?? [0, 0];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" style={{ display: "block" }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity=".18" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L ${w} ${h} L 0 ${h} Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0].toFixed(1)} cy={last[1].toFixed(1)} r="2.4" fill={color} />
    </svg>
  );
}

export function AreaChart({
  series,
  id,
  spend,
}: {
  series: number[];
  id: string;
  spend?: number[];
}) {
  const w = 560;
  const h = 200;
  const pad = 28;
  if (series.length < 2) series = [0, 0];
  const max = Math.max(...series) || 1;
  const step = (w - pad * 2) / (series.length - 1);
  const pts: [number, number][] = series.map((v, i) => [pad + i * step, h - pad - (v / max) * (h - pad * 2)]);
  const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const spendMax = spend && spend.length ? Math.max(...spend) || 1 : 1;
  const grid = [0.25, 0.5, 0.75, 1].map((f, i) => {
    const y = (h - pad - (h - pad * 2) * f).toFixed(1);
    return <line key={i} x1={pad} y1={y} x2={w - pad} y2={y} stroke="var(--border)" strokeWidth="1" strokeDasharray="2 4" />;
  });
  const bars = (spend ?? []).map((v, i) => {
    const bx = pad + i * step - 6;
    const bh = (v / spendMax) * 44;
    return <rect key={i} x={bx.toFixed(1)} y={(h - pad - bh).toFixed(1)} width="12" height={bh.toFixed(1)} rx="2" fill="var(--info)" opacity=".22" />;
  });
  const last = pts.at(-1) ?? [0, 0];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: "block" }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity=".22" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {grid}
      {bars}
      <path d={`${line} L ${w - pad} ${h - pad} L ${pad} ${h - pad} Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0].toFixed(1)} cy={last[1].toFixed(1)} r="3.5" fill="var(--accent)" stroke="var(--surface)" strokeWidth="2" />
    </svg>
  );
}

// data = retention percentages (0..100), first point = 100 at t0.
export function RetentionCurve({ data, id, floor = 55 }: { data: number[]; id: string; floor?: number }) {
  const w = 560;
  const h = 200;
  const pad = 30;
  if (data.length < 2) data = [100, 100];
  const step = (w - pad * 2) / (data.length - 1);
  const pts: [number, number][] = data.map((v, i) => [pad + i * step, h - pad - (v / 100) * (h - pad * 2)]);
  const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const grid = [25, 50, 75, 100].map((f, i) => {
    const y = (h - pad - ((h - pad * 2) * f) / 100).toFixed(1);
    return <line key={i} x1={pad} y1={y} x2={w - pad} y2={y} stroke="var(--border)" strokeWidth="1" strokeDasharray="2 4" />;
  });
  const hookX = pad + step * 0.6;
  const floorY = (h - pad - (h - pad * 2) * (floor / 100)).toFixed(1);
  const last = pts.at(-1) ?? [0, 0];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: "block" }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity=".2" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x={pad} y={pad} width={(hookX - pad).toFixed(1)} height={h - pad * 2} fill="var(--crit)" opacity=".07" />
      <text x={(pad + 3).toFixed(1)} y={pad + 12} fontSize="9.5" fill="var(--crit)" fontWeight="700">HOOK 0–3s</text>
      {grid}
      <path d={`${line} L ${w - pad} ${h - pad} L ${pad} ${h - pad} Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <line x1={pad} y1={floorY} x2={w - pad} y2={floorY} stroke="var(--good)" strokeWidth="1.2" strokeDasharray="4 3" />
      <text x={w - pad} y={(Number(floorY) - 4).toFixed(1)} textAnchor="end" fontSize="9" fill="var(--good)" fontWeight="700">
        {floor}% floor
      </text>
      <circle cx={last[0].toFixed(1)} cy={last[1].toFixed(1)} r="3" fill="var(--accent)" stroke="var(--surface)" strokeWidth="2" />
    </svg>
  );
}
