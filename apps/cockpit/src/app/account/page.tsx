import { isEncryptionConfigured, listSecretMeta, SECRET_KEYS } from "@ytauto/core";
import { getAppContext } from "@/lib/context";
import { deleteSecretAction, saveSecretAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const { db, providers } = await getAppContext();
  const encryptionReady = isEncryptionConfigured();
  const meta = encryptionReady ? await listSecretMeta(db) : [];
  const metaByName = new Map(meta.map((m) => [m.name, m]));

  const adapterStatus = [
    { label: "LLM", active: providers.llm.name },
    { label: "Voice", active: providers.voice.name },
    { label: "Media", active: providers.media.name },
    { label: "Publish", active: providers.publish.name },
    { label: "Research", active: providers.research.name },
  ];

  const groups = [...new Set(SECRET_KEYS.map((k) => k.group))];

  return (
    <div>
      <h1>Account · Provider keys</h1>
      <p className="muted">
        Keys are encrypted at rest (AES-256-GCM) under the server&apos;s{" "}
        <span className="mono">SECRETS_ENCRYPTION_KEY</span> and are never shown again after
        saving — only the last 4 characters. A saved key switches that provider from mock to
        real within ~15 seconds, no restart needed. <span className="mono">PROVIDERS_FORCE_MOCK=1</span>{" "}
        overrides everything back to mocks.
      </p>

      {!encryptionReady && (
        <div className="card" style={{ borderColor: "var(--red)" }}>
          <strong style={{ color: "var(--red)" }}>Encryption is not configured.</strong> Set{" "}
          <span className="mono">SECRETS_ENCRYPTION_KEY</span> in the server environment
          (generate one with <span className="mono">openssl rand -hex 32</span>) and restart.
          Keys cannot be saved until then.
        </div>
      )}

      <div className="card">
        <strong>Active adapters:</strong>{" "}
        {adapterStatus.map((a) => (
          <span key={a.label} style={{ marginRight: 12 }}>
            {a.label}:{" "}
            <span className={`badge ${a.active.startsWith("mock") ? "amber" : "green"}`}>
              {a.active}
            </span>
          </span>
        ))}
      </div>

      {groups.map((group) => (
        <div key={group}>
          <h2>{group}</h2>
          <table className="data">
            <tbody>
              {SECRET_KEYS.filter((k) => k.group === group).map((k) => {
                const m = metaByName.get(k.name);
                return (
                  <tr key={k.name}>
                    <td style={{ width: "30%" }}>
                      {k.label}
                      <div className="muted mono">{k.name}</div>
                    </td>
                    <td style={{ width: "20%" }}>
                      {m ? (
                        <>
                          <span className="badge green">set</span>{" "}
                          <span className="mono muted">····{m.last4}</span>
                          <div className="muted">
                            {m.updatedAt.toISOString().slice(0, 16).replace("T", " ")}
                          </div>
                        </>
                      ) : (
                        <span className="badge">not set</span>
                      )}
                    </td>
                    <td>
                      <form action={saveSecretAction} style={{ display: "flex", gap: 8 }}>
                        <input type="hidden" name="name" value={k.name} />
                        <input
                          type="password"
                          name="value"
                          placeholder={m ? "Enter new value to replace" : "Enter value"}
                          autoComplete="off"
                          disabled={!encryptionReady}
                        />
                        <button type="submit" disabled={!encryptionReady}>
                          Save
                        </button>
                      </form>
                    </td>
                    <td style={{ width: 90 }}>
                      {m && (
                        <form action={deleteSecretAction.bind(null, k.name)}>
                          <button className="danger" type="submit">
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
      ))}

      <p className="muted" style={{ marginTop: "1rem" }}>
        Note: saving a key immediately routes that provider to the real API — the next
        production will spend real money. Rotating <span className="mono">SECRETS_ENCRYPTION_KEY</span>{" "}
        orphans stored keys; re-enter them here afterwards.
      </p>
    </div>
  );
}
