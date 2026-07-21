import { AGENT_PROMPTS } from "@ytauto/agents";

export const dynamic = "force-dynamic";

/**
 * Agent prompt dashboard (ticket 01KY1X58…) — read-only MVP. Lists every LLM
 * agent the platform runs: purpose, source file, model tier, compliance flag,
 * and whether the authored path bypasses it. Full prompt-text viewing + version
 * history + editing is the follow-up that needs prompts centralised out of each
 * agent's inline `system:` string.
 */
export default function PromptsPage() {
  const compliance = AGENT_PROMPTS.filter((a) => a.complianceRelevant);
  const tierColor: Record<string, string> = {
    flagship: "#a78bfa",
    mid: "#38bdf8",
    cheap: "#34d399",
    vision: "#f59e0b",
    varies: "#94a3b8",
  };

  return (
    <div style={{ padding: "16px 0" }}>
      <h1 style={{ marginBottom: 4 }}>Agent prompts</h1>
      <p style={{ opacity: 0.7, marginTop: 0, marginBottom: 12 }}>
        Every LLM the platform runs. Read-only for now — view the exact prompt in the source file; centralised
        editing + version history is a planned follow-up.
      </p>

      <div className="callout" style={{ marginBottom: 16, fontSize: 13 }}>
        <strong>{compliance.length}</strong> of {AGENT_PROMPTS.length} agents are compliance-relevant (part of what
        protects the channels under YouTube&rsquo;s inauthentic-content policy) — audit these first.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {AGENT_PROMPTS.map((a) => (
          <div key={a.key} className="panel" style={{ padding: 10 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
              <span style={{ fontWeight: 600 }}>{a.name}</span>
              <span className="chip" style={{ background: tierColor[a.tier] ?? "#64748b", color: "#0b1220" }}>{a.tier}</span>
              {a.complianceRelevant ? <span className="chip warn">compliance</span> : null}
              {a.bypassedWhenAuthored ? <span className="chip">bypassed when authored</span> : null}
            </div>
            <div style={{ fontSize: 13.5, opacity: 0.85 }}>{a.purpose}</div>
            <div style={{ fontSize: 12, opacity: 0.55, marginTop: 4 }}>
              <code>packages/agents/src/{a.file}</code>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
