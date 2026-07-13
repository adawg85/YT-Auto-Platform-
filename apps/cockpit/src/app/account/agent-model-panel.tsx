import { AGENT_REGISTRY, type AgentTier } from "@ytauto/core";
import { clearAgentModelAction, saveAgentModelAction } from "./actions";

/**
 * Per-agent model overrides (#21, 2026-07-13): pin any single agent to any
 * model, leaving everything else on its default tier — e.g. Opus for the
 * scriptwriter only, Gemini for the review board, without paying frontier
 * prices platform-wide. Stored as one JSON secret (LLM_AGENT_MODELS); the
 * router falls back to the tier when a ref can't be resolved.
 */

const TIER_ORDER: { tier: AgentTier; title: string; blurb: string }[] = [
  {
    tier: "frontier",
    title: "Frontier agents",
    blurb: "Default to the frontier model — the quality-critical drafting.",
  },
  {
    tier: "agentic",
    title: "Agentic agents",
    blurb: "Default to the agentic model — checkers, analysis, editorial reasoning.",
  },
  {
    tier: "cheap",
    title: "Cheap agents",
    blurb: "Default to the cheap model — bulk and low-stakes calls.",
  },
];

const REF_SUGGESTIONS = [
  "anthropic:claude-opus-4-8",
  "anthropic:claude-sonnet-5",
  "anthropic:claude-haiku-4-5",
  "openai:gpt-5",
  "openai:gpt-5-mini",
  "google:gemini-2.5-flash-lite",
  "qwen:qwen-max",
  "glm:glm-4.6",
  "kimi:kimi-k2-turbo-preview",
];

export function AgentModelPanel({
  overrides,
  tierResolved,
  encryptionReady,
}: {
  overrides: Record<string, string>;
  tierResolved: Record<AgentTier, string>;
  encryptionReady: boolean;
}) {
  return (
    <div>
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-body">
          <strong>Per-agent overrides.</strong>{" "}
          <span className="muted" style={{ fontSize: 13 }}>
            Pin any single agent to any model; everything you leave blank stays on its tier above.
            Refs are vendor-prefixed (e.g. <span className="mono">anthropic:claude-opus-4-8</span>,{" "}
            <span className="mono">openai:gpt-5-mini</span>). An override whose vendor key is
            missing falls back to OpenRouter, then to the tier. Escalation retries always use the
            Escalation slot, never these overrides.
          </span>
        </div>
      </div>
      <datalist id="agent-model-refs">
        {REF_SUGGESTIONS.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
      {TIER_ORDER.map(({ tier, title, blurb }) => {
        const agents = AGENT_REGISTRY.filter((a) => a.tier === tier);
        return (
          <div key={tier} className="panel" style={{ marginBottom: 16 }}>
            <div className="panel-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <h3>{title}</h3>
              <span className="chip">
                Tier default: <span className="mono" style={{ marginLeft: 4 }}>{tierResolved[tier]}</span>
              </span>
            </div>
            <div className="panel-body flush">
              <table className="data" style={{ border: "none", borderRadius: 0 }}>
                <thead>
                  <tr>
                    <th style={{ width: "38%" }}>Agent</th>
                    <th style={{ width: "20%" }}>Runs on</th>
                    <th>Override</th>
                    <th style={{ width: 90 }} />
                  </tr>
                </thead>
                <tbody>
                  {agents.map((a) => {
                    const override = overrides[a.name];
                    return (
                      <tr key={a.name}>
                        <td>
                          {a.label}
                          <div className="muted mono" style={{ fontSize: 11.5 }}>{a.name}</div>
                        </td>
                        <td>
                          {override ? (
                            <span className="chip good">
                              <span className="d" />
                              <span className="mono" style={{ fontSize: 11.5 }}>{override}</span>
                            </span>
                          ) : (
                            <span className="chip">Tier default</span>
                          )}
                        </td>
                        <td>
                          <form action={saveAgentModelAction} style={{ display: "flex", gap: 8 }}>
                            <input type="hidden" name="agent" value={a.name} />
                            <input
                              name="value"
                              list="agent-model-refs"
                              defaultValue={override ?? ""}
                              placeholder="vendor:model-id"
                              autoComplete="off"
                              disabled={!encryptionReady}
                              className="mono"
                              style={{ fontSize: 12.5, minWidth: 200, height: 34 }}
                            />
                            <button type="submit" className="btn ghost sm" disabled={!encryptionReady} style={{ height: 34 }}>
                              Save
                            </button>
                          </form>
                        </td>
                        <td style={{ textAlign: "right" }}>
                          {override && (
                            <form action={clearAgentModelAction.bind(null, a.name)}>
                              <button type="submit" className="btn ghost sm" disabled={!encryptionReady}>
                                Clear
                              </button>
                            </form>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}
