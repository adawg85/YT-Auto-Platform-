import { isEncryptionConfigured, listSecretMeta, SECRET_KEYS } from "@ytauto/core";
import { getAppContext, getMergedEnv } from "@/lib/context";
import { deleteSecretAction, saveSecretAction } from "./actions";
import { ModelPicker, type TierCard } from "./model-picker";
import { PageTabs } from "@/components/page-tabs";
import { IconAlertTriangle } from "@/components/icons";
import { fmtDate } from "@/lib/format";

export const dynamic = "force-dynamic";

/** Model-routing overrides live on the Models tab, not the key table. */
const MODEL_ROUTING_KEYS = ["LLM_MODEL_CHEAP", "LLM_MODEL_AGENTIC", "LLM_MODEL_FRONTIER"];

export default async function AccountPage() {
  const { db, providers } = await getAppContext();
  const encryptionReady = isEncryptionConfigured();
  const meta = encryptionReady ? await listSecretMeta(db) : [];
  const metaByName = new Map(meta.map((m) => [m.name, m]));
  const env = await getMergedEnv();

  const adapterStatus = [
    { label: "LLM", active: providers.llm.name },
    { label: "Voice", active: providers.voice.name },
    { label: "Media", active: providers.media.name },
    { label: "Publish", active: providers.publish.name },
    { label: "Research", active: providers.research.name },
  ];

  const tierCards: TierCard[] = [
    {
      tier: "frontier",
      secretName: "LLM_MODEL_FRONTIER",
      label: "Frontier — scripts, charters, identities",
      description: "The heavyweight tier: charter/identity drafting and scriptwriting.",
      resolved: providers.llm.modelId("frontier"),
      override: env.LLM_MODEL_FRONTIER ?? null,
      encryptionReady,
    },
    {
      tier: "agentic",
      secretName: "LLM_MODEL_AGENTIC",
      label: "Agentic — assistant, analysis, checkers",
      description: "Tool-calling and analysis: the assistant, review board and checkers.",
      resolved: providers.llm.modelId("agentic"),
      override: env.LLM_MODEL_AGENTIC ?? null,
      encryptionReady,
    },
    {
      tier: "cheap",
      secretName: "LLM_MODEL_CHEAP",
      label: "Cheap — bulk ideation & scoring",
      description: "High-volume, low-stakes calls: idea generation and scoring.",
      resolved: providers.llm.modelId("cheap"),
      override: env.LLM_MODEL_CHEAP ?? null,
      encryptionReady,
    },
  ];

  const keyGroups = [...new Set(SECRET_KEYS.map((k) => k.group))];

  const modelsPanel = (
    <>
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h3>Active providers</h3>
        </div>
        <div className="panel-body" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {adapterStatus.map((a) => {
            const isMock = a.active.startsWith("mock");
            return (
              <span key={a.label} className={`chip ${isMock ? "warn" : "good"}`}>
                <span className="d" />
                {a.label}: {isMock ? "Mock" : a.active}
              </span>
            );
          })}
        </div>
      </div>
      <ModelPicker cards={tierCards} />
    </>
  );

  const keysPanel = (
    <>
      {keyGroups.map((group) => {
        const rows = SECRET_KEYS.filter(
          (k) => k.group === group && !MODEL_ROUTING_KEYS.includes(k.name),
        );
        if (rows.length === 0) return null;
        return (
          <div key={group} className="panel" style={{ marginBottom: 16 }}>
            <div className="panel-head">
              <h3>{group}</h3>
            </div>
            <div className="panel-body flush">
              <table className="data" style={{ border: "none", borderRadius: 0 }}>
                <thead>
                  <tr>
                    <th style={{ width: "28%" }}>Key</th>
                    <th style={{ width: "22%" }}>Status</th>
                    <th>Update</th>
                    <th style={{ width: 110 }} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((k) => {
                    const m = metaByName.get(k.name);
                    return (
                      <tr key={k.name}>
                        <td>
                          {k.label}
                          <div className="muted mono" style={{ fontSize: 11.5 }}>{k.name}</div>
                        </td>
                        <td>
                          {m ? (
                            <>
                              <span className="chip good">
                                <span className="d" />
                                Set ····{m.last4}
                              </span>
                              <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
                                Updated {fmtDate(m.updatedAt)}
                              </div>
                            </>
                          ) : (
                            <span className="chip">Not set</span>
                          )}
                        </td>
                        <td>
                          <form action={saveSecretAction} style={{ display: "flex", gap: 8 }}>
                            <input type="hidden" name="name" value={k.name} />
                            <input
                              type="password"
                              name="value"
                              placeholder={m ? "Paste a new value to replace" : "Paste the key"}
                              autoComplete="off"
                              disabled={!encryptionReady}
                            />
                            <button
                              type="submit"
                              className="btn ghost sm"
                              disabled={!encryptionReady}
                              style={{ height: 36 }}
                            >
                              Save
                            </button>
                          </form>
                        </td>
                        <td style={{ textAlign: "right" }}>
                          {m && (
                            <form action={deleteSecretAction.bind(null, k.name)}>
                              <button className="btn ghost sm danger-ink" type="submit">
                                Remove
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

      <div className="callout warn">
        <IconAlertTriangle />
        <span>
          Saving a key routes that provider to the real API immediately — the next production spends real money. Keys
          are stored AES-256-GCM encrypted and only the last 4 characters are ever shown again. Rotating{" "}
          <span className="mono">SECRETS_ENCRYPTION_KEY</span> orphans stored keys; re-enter them here afterwards.{" "}
          <span className="mono">PROVIDERS_FORCE_MOCK=1</span> forces everything back to mocks.
        </span>
      </div>
    </>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Account &amp; keys</h1>
          <p className="page-sub">
            Choose which model runs each process, and store provider API keys (encrypted at rest).
            Saving a key or model switches within ~15 seconds — no redeploy.
          </p>
        </div>
      </div>

      {!encryptionReady && (
        <div className="callout crit" style={{ marginTop: 0 }}>
          <IconAlertTriangle />
          <span>
            <strong>Encryption is not configured, so keys can&apos;t be saved.</strong> Set{" "}
            <span className="mono">SECRETS_ENCRYPTION_KEY</span> in the server environment (generate one with{" "}
            <span className="mono">openssl rand -hex 32</span>) and restart.
          </span>
        </div>
      )}

      <PageTabs
        tabs={[
          { key: "models", label: "Models", panel: modelsPanel },
          { key: "keys", label: "API keys", panel: keysPanel },
        ]}
      />
    </>
  );
}
