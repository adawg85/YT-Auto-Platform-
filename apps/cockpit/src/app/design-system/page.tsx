import {
  Badge,
  Button,
  ButtonLink,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  Panel,
  Skeleton,
  SkeletonLines,
  StatGrid,
  StatTile,
  Textarea,
} from "@/components/ui";
import { AreaChart, RadarChart, RetentionCurve, Sparkline } from "@/components/charts";
import { IconInbox, IconPlus, IconSparkle } from "@/components/icons";

export const metadata = { title: "Design system · YT Auto" };

// Accent candidates for the Phase 0 sign-off. The live app currently uses A.
// To switch, change --accent / --accent-2 / --accent-soft / --accent-ink in
// globals.css (light + dark blocks) to the chosen set.
const ACCENTS = [
  { key: "A", name: "Indigo (current)", hex: "#4f46e5", soft: "#eef2ff", note: "Refreshed default — AI-native, no clash with status colors" },
  { key: "B", name: "Electric blue", hex: "#2867e5", soft: "#e6edfd", note: "The previous signature blue, retained option" },
  { key: "C", name: "Run green", hex: "#22c55e", soft: "#e6f4ea", note: "Ops-console look — ⚠ collides with semantic ‘good’ green" },
];

function Swatch({ name, varName, hex }: { name: string; varName: string; hex: string }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ height: 44, borderRadius: 8, background: hex, border: "1px solid var(--border)" }} />
      <div style={{ fontSize: 11, fontWeight: 600, marginTop: 6 }}>{name}</div>
      <div className="num muted" style={{ fontSize: 10.5 }}>{varName}</div>
    </div>
  );
}

export default function DesignSystemPage() {
  const scoreAxes = [
    { label: "Demand", value: 8 },
    { label: "Low sat.", value: 6 },
    { label: "Ghost", value: 7 },
    { label: "RPM", value: 5 },
    { label: "Feasible", value: 9 },
    { label: "Compliant", value: 8 },
    { label: "DNA fit", value: 7 },
  ];
  return (
    <div className="view">
      <div className="page-head">
        <div>
          <h1 className="page-title">Design system</h1>
          <p className="page-sub">
            Living reference for the cockpit UI. Toggle the theme in the top bar to review light &amp; dark.
          </p>
        </div>
        <Badge tone="accent" dot>reference</Badge>
      </div>

      {/* ACCENT SIGN-OFF */}
      <h2>Accent — pick one</h2>
      <div className="grid grid-2" style={{ marginBottom: 8 }}>
        {ACCENTS.map((a) => (
          <Card key={a.key}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: a.hex, flex: "none" }} />
              <div>
                <div style={{ fontWeight: 650 }}>
                  {a.key} · {a.name}
                </div>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  <span className="num">{a.hex}</span> — {a.note}
                </div>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* TOKENS */}
      <h2>Neutrals &amp; status (slate ramp)</h2>
      <Card>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(90px,1fr))", gap: 14 }}>
          <Swatch name="ground" varName="--ground" hex="var(--ground)" />
          <Swatch name="surface" varName="--surface" hex="var(--surface)" />
          <Swatch name="surface-2" varName="--surface-2" hex="var(--surface-2)" />
          <Swatch name="border" varName="--border" hex="var(--border)" />
          <Swatch name="accent" varName="--accent" hex="var(--accent)" />
          <Swatch name="good" varName="--good" hex="var(--good)" />
          <Swatch name="warn" varName="--warn" hex="var(--warn)" />
          <Swatch name="crit" varName="--crit" hex="var(--crit)" />
          <Swatch name="info" varName="--info" hex="var(--info)" />
        </div>
      </Card>

      {/* TYPE */}
      <h2>Type scale — Inter + JetBrains Mono</h2>
      <Card>
        <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-.03em" }}>Display 32 / 700</div>
        <h1 style={{ margin: "10px 0 0" }}>Heading H1 21 / 650</h1>
        <h2 style={{ margin: "10px 0 0" }}>Heading H2 16 / 650</h2>
        <p style={{ margin: "10px 0 0" }}>Body 14 / 400 — the quick brown fox jumps over the lazy dog.</p>
        <div className="lab" style={{ marginTop: 10 }}>LABEL 11 / 600 UPPERCASE</div>
        <div className="num" style={{ fontSize: 20, marginTop: 10 }}>1,234,567 · $89.40 · 62.5%</div>
      </Card>

      {/* BUTTONS */}
      <h2>Buttons</h2>
      <Card>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <Button icon={<IconPlus />}>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="good">Approve</Button>
          <Button variant="warn">Revise</Button>
          <Button variant="danger">Reject</Button>
          <Button size="sm">Small</Button>
          <Button disabled>Disabled</Button>
          <ButtonLink href="/design-system" variant="secondary">Link button</ButtonLink>
        </div>
      </Card>

      {/* BADGES */}
      <h2>Badges</h2>
      <Card>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Badge>neutral</Badge>
          <Badge tone="good" dot>active</Badge>
          <Badge tone="warn" dot>paused</Badge>
          <Badge tone="crit" dot>error</Badge>
          <Badge tone="accent">tier 2</Badge>
        </div>
      </Card>

      {/* STATS */}
      <h2>Stat tiles</h2>
      <StatGrid>
        <StatTile label="Views 30d" value="1.24M" delta={{ dir: "up", text: "+12%" }} sub="vs prev" />
        <StatTile label="Avg retention" value="58" unit="%" delta={{ dir: "down", text: "-3%" }} />
        <StatTile label="Published 7d" value="9" sub="3 channels" />
        <StatTile label="Spend 30d" value="$89" unit=".40" sub="all channels" />
      </StatGrid>

      {/* PANEL + TABLE */}
      <div className="grid cols-3-1">
        <Panel title="Views &amp; spend (14d)">
          <AreaChart id="ds-area" series={[3, 5, 4, 7, 6, 9, 8, 11, 10, 13, 12, 15, 14, 18]} spend={[1, 2, 1, 3, 2, 3, 2, 4, 3, 4, 3, 5, 4, 5]} />
        </Panel>
        <Panel title="Score rubric">
          <RadarChart id="ds-radar" axes={scoreAxes} max={10} />
        </Panel>
      </div>

      <Panel title="Channels" flush>
        <DataTable>
          <thead>
            <tr><th>Channel</th><th>Niche</th><th>Status</th><th>Spend</th></tr>
          </thead>
          <tbody>
            <tr><td><strong>Deep Dives</strong></td><td>science</td><td><Badge tone="good" dot>active</Badge></td><td className="num">$12.40</td></tr>
            <tr><td><strong>Money Myths</strong></td><td>finance</td><td><Badge tone="warn" dot>paused</Badge></td><td className="num">$8.10</td></tr>
          </tbody>
        </DataTable>
      </Panel>

      {/* RETENTION */}
      <Panel title="Retention curve">
        <RetentionCurve id="ds-ret" data={[100, 82, 71, 65, 60, 58, 56, 55, 54]} floor={55} />
      </Panel>

      {/* FORM */}
      <h2>Form controls</h2>
      <Card>
        <Field label="Channel name" hint="(shown publicly)">
          <Input placeholder="e.g. Deep Dives" />
        </Field>
        <Field label="Editorial notes">
          <Textarea rows={2} placeholder="Logged as compliance evidence…" />
        </Field>
      </Card>

      {/* FEEDBACK STATES */}
      <div className="grid grid-2">
        <Panel title="Loading (skeleton)">
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
            <Skeleton w={40} h={40} style={{ borderRadius: 10 }} />
            <div style={{ flex: 1 }}><SkeletonLines lines={2} /></div>
          </div>
          <Skeleton h={80} />
        </Panel>
        <Panel title="Empty state" flush>
          <EmptyState
            icon={<IconInbox />}
            title="No ideas yet"
            description="Run the ideation agent or add one manually to start the funnel."
            action={<Button size="sm" icon={<IconSparkle />}>Generate ideas</Button>}
          />
        </Panel>
      </div>
    </div>
  );
}
