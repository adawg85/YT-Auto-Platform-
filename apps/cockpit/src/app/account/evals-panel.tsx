import { desc, eq } from "drizzle-orm";
import { evalResults, evalRuns, evalVotes } from "@ytauto/db";
import { getAppContext } from "@/lib/context";
import { fmtDateTime } from "@/lib/format";
import { startEvalRunAction, voteEvalPairAction } from "./actions";

/**
 * Golden-set eval harness surface (#21.2.5): start a run over candidate
 * models, read the per-model quality/cost table, and vote blind A/B pairs.
 * Fully server-rendered — every action is a form post.
 */

type ResultRow = typeof evalResults.$inferSelect;

/** The main candidates per vendor (mirrors the Models-tab suggestions). */
const MODEL_OPTIONS: { vendor: string; models: { ref: string; label: string }[] }[] = [
  {
    vendor: "Anthropic",
    models: [
      { ref: "anthropic:claude-opus-4-8", label: "Opus 4.8" },
      { ref: "anthropic:claude-sonnet-5", label: "Sonnet 5" },
      { ref: "anthropic:claude-haiku-4-5", label: "Haiku 4.5" },
    ],
  },
  {
    vendor: "OpenAI",
    models: [
      { ref: "openai:gpt-5", label: "GPT-5" },
      { ref: "openai:gpt-5-mini", label: "GPT-5 mini" },
    ],
  },
  {
    vendor: "Google",
    models: [
      { ref: "google:gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { ref: "google:gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      { ref: "google:gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
    ],
  },
  {
    vendor: "Qwen",
    models: [
      { ref: "qwen:qwen-max", label: "Qwen Max" },
      { ref: "qwen:qwen-plus", label: "Qwen Plus" },
    ],
  },
  {
    vendor: "GLM",
    models: [{ ref: "glm:glm-4.6", label: "GLM 4.6" }],
  },
  {
    vendor: "Kimi",
    models: [{ ref: "kimi:kimi-k2-turbo-preview", label: "Kimi K2 Turbo" }],
  },
];

const runStatusChip: Record<string, string> = {
  running: "chip warn",
  complete: "chip good",
  failed: "chip bad",
};

function aggregate(rows: ResultRow[], voteWinners: Map<string, number>, voteLosers: Map<string, number>) {
  const byModel = new Map<string, ResultRow[]>();
  for (const r of rows) {
    if (r.status !== "ok") continue;
    const list = byModel.get(r.modelRef) ?? [];
    list.push(r);
    byModel.set(r.modelRef, list);
  }
  const avg = (ns: number[]) => (ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 0);
  return [...byModel.entries()]
    .map(([modelRef, list]) => {
      const judged = list.filter((r) => r.judge);
      const metricOf = (k: string) => avg(list.map((r) => Number(r.metrics?.[k] ?? 0)));
      let wins = 0;
      let losses = 0;
      for (const r of list) {
        wins += voteWinners.get(r.id) ?? 0;
        losses += voteLosers.get(r.id) ?? 0;
      }
      return {
        modelRef,
        n: list.length,
        overall: avg(judged.map((r) => r.judge!.overall)),
        factCompliance: avg(judged.map((r) => r.judge!.factCompliance)),
        hookStrength: avg(judged.map((r) => r.judge!.hookStrength)),
        voiceNaturalness: avg(judged.map((r) => r.judge!.voiceNaturalness)),
        aiTells: metricOf("aiTellCount"),
        unsupported: metricOf("unsupportedClaims"),
        adherencePct: metricOf("targetAdherencePct"),
        costUsd: metricOf("costUsd"),
        durationMs: metricOf("durationMs"),
        wins,
        losses,
      };
    })
    .sort((a, b) => b.overall - a.overall);
}

/** First not-yet-voted A/B pair per fixture (order de-biased by id parity). */
function pickPairs(rows: ResultRow[], votedPairs: Set<string>) {
  const byFixture = new Map<string, ResultRow[]>();
  for (const r of rows) {
    if (r.status !== "ok" || !r.script) continue;
    const list = byFixture.get(r.fixtureId) ?? [];
    list.push(r);
    byFixture.set(r.fixtureId, list);
  }
  const pairs: { fixtureId: string; a: ResultRow; b: ResultRow }[] = [];
  for (const [fixtureId, list] of byFixture) {
    const sorted = [...list].sort((x, y) => x.id.localeCompare(y.id));
    outer: for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = [sorted[i]!.id, sorted[j]!.id].sort().join("|");
        if (votedPairs.has(key)) continue;
        const flip = (sorted[i]!.id.charCodeAt(sorted[i]!.id.length - 1) ?? 0) % 2 === 0;
        pairs.push({
          fixtureId,
          a: flip ? sorted[j]! : sorted[i]!,
          b: flip ? sorted[i]! : sorted[j]!,
        });
        break outer;
      }
    }
  }
  return pairs;
}

function ScriptCard({
  label,
  row,
  other,
  runId,
  fixtureId,
}: {
  label: string;
  row: ResultRow;
  other: ResultRow;
  runId: string;
  fixtureId: string;
}) {
  const text = row.script!.fullText;
  return (
    <div className="panel" style={{ flex: "1 1 320px", minWidth: 0 }}>
      <div className="panel-head" style={{ display: "flex", justifyContent: "space-between" }}>
        <h3>Script {label}</h3>
        <form action={voteEvalPairAction}>
          <input type="hidden" name="runId" value={runId} />
          <input type="hidden" name="fixtureId" value={fixtureId} />
          <input type="hidden" name="winnerResultId" value={row.id} />
          <input type="hidden" name="loserResultId" value={other.id} />
          <button className="btn ghost sm" type="submit">
            {label} reads better
          </button>
        </form>
      </div>
      <div className="panel-body">
        <p style={{ marginTop: 0, fontWeight: 600 }}>{row.script!.hookText}</p>
        <p className="muted" style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>
          {text.length > 700 ? `${text.slice(0, 700)}…` : text}
        </p>
        {text.length > 700 && (
          <details>
            <summary className="muted" style={{ cursor: "pointer", fontSize: 12.5 }}>
              Read the full script
            </summary>
            <p className="muted" style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{text}</p>
          </details>
        )}
      </div>
    </div>
  );
}

export async function EvalsPanel({ defaultModels }: { defaultModels: string[] }) {
  const { db } = await getAppContext();
  const runs = await db.select().from(evalRuns).orderBy(desc(evalRuns.createdAt)).limit(5);
  const latest = runs[0];
  const rows = latest
    ? await db.select().from(evalResults).where(eq(evalResults.runId, latest.id))
    : [];
  const votes = latest
    ? await db.select().from(evalVotes).where(eq(evalVotes.runId, latest.id))
    : [];

  const voteWinners = new Map<string, number>();
  const voteLosers = new Map<string, number>();
  const votedPairs = new Set<string>();
  for (const v of votes) {
    voteWinners.set(v.winnerResultId, (voteWinners.get(v.winnerResultId) ?? 0) + 1);
    voteLosers.set(v.loserResultId, (voteLosers.get(v.loserResultId) ?? 0) + 1);
    votedPairs.add([v.winnerResultId, v.loserResultId].sort().join("|"));
  }
  const table = aggregate(rows, voteWinners, voteLosers);
  const pairs = latest ? pickPairs(rows, votedPairs).slice(0, 3) : [];
  const modelByResult = new Map(rows.map((r) => [r.id, r.modelRef]));

  return (
    <>
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h3>Run an evaluation</h3>
        </div>
        <div className="panel-body">
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            Runs the 6-fixture golden set (Shorts + long-form, strict/balanced/entertainment)
            through the real script chain once per model, then scores each script with a fixed
            judge. Real API spend: roughly one long-form script per fixture per model.
          </p>
          <form action={startEvalRunAction} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
              {MODEL_OPTIONS.map((group) => (
                <fieldset key={group.vendor} style={{ border: "none", margin: 0, padding: 0, minWidth: 150 }}>
                  <legend className="muted" style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, padding: 0 }}>
                    {group.vendor}
                  </legend>
                  {group.models.map((m) => (
                    <label
                      key={m.ref}
                      style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, padding: "3px 0", cursor: "pointer" }}
                    >
                      <input
                        type="checkbox"
                        name="models"
                        value={m.ref}
                        defaultChecked={defaultModels.includes(m.ref)}
                      />
                      {m.label}
                    </label>
                  ))}
                </fieldset>
              ))}
            </div>
            <input
              name="customModels"
              placeholder="Anything else, comma-separated (e.g. openrouter:meta-llama/llama-4-maverick)"
              autoComplete="off"
              className="mono"
              style={{ fontSize: 12.5, height: 36 }}
            />
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input name="note" placeholder="Optional note (e.g. 'new Opus drop')" style={{ flex: 1, height: 36 }} />
              <button className="btn sm" type="submit">
                Start eval run
              </button>
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              Capped at 8 models per run (8 × 6 fixtures = 48 script chains). A vendor with no key
              saved routes via OpenRouter when possible, else falls back to your default model —
              add the key on the API keys tab first for a true direct-API result.
            </p>
          </form>
        </div>
      </div>

      {runs.length > 0 && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-head">
            <h3>Recent runs</h3>
          </div>
          <div className="panel-body flush">
            <table className="data" style={{ border: "none", borderRadius: 0 }}>
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Models</th>
                  <th>Status</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>{fmtDateTime(r.createdAt)}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{r.models.join(", ")}</td>
                    <td>
                      <span className={runStatusChip[r.status] ?? "chip"}>
                        <span className="d" />
                        {r.status === "complete" ? "Complete" : r.status === "failed" ? "Failed" : "Running"}
                      </span>
                      {r.error && (
                        <div className="muted" style={{ fontSize: 11.5 }}>{r.error}</div>
                      )}
                    </td>
                    <td className="muted">{r.note ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {table.length > 0 && latest && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-head">
            <h3>Latest run — quality &amp; cost by model</h3>
          </div>
          <div className="panel-body flush" style={{ overflowX: "auto" }}>
            <table className="data" style={{ border: "none", borderRadius: 0 }}>
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Overall</th>
                  <th>Facts</th>
                  <th>Hook</th>
                  <th>Voice</th>
                  <th>AI tells</th>
                  <th>Unsupported</th>
                  <th>Length</th>
                  <th>Cost/script</th>
                  <th>Latency</th>
                  <th>Your picks</th>
                </tr>
              </thead>
              <tbody>
                {table.map((m) => (
                  <tr key={m.modelRef}>
                    <td className="mono" style={{ fontSize: 12 }}>{m.modelRef}</td>
                    <td>
                      <strong>{m.overall.toFixed(1)}</strong>
                      <span className="muted"> /10</span>
                    </td>
                    <td>{m.factCompliance.toFixed(1)}</td>
                    <td>{m.hookStrength.toFixed(1)}</td>
                    <td>{m.voiceNaturalness.toFixed(1)}</td>
                    <td>{m.aiTells.toFixed(1)}</td>
                    <td>{m.unsupported.toFixed(1)}</td>
                    <td>{Math.round(m.adherencePct)}%</td>
                    <td>${m.costUsd.toFixed(3)}</td>
                    <td>{(m.durationMs / 1000).toFixed(0)}s</td>
                    <td>
                      {m.wins + m.losses > 0 ? `${m.wins}W / ${m.losses}L` : <span className="muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {pairs.length > 0 && latest && (
        <div style={{ marginBottom: 16 }}>
          <div className="panel" style={{ marginBottom: 12 }}>
            <div className="panel-body">
              <strong>Blind A/B.</strong>{" "}
              <span className="muted" style={{ fontSize: 13 }}>
                Read both scripts aloud and pick the one you would publish — model names are hidden
                until you vote. Your picks feed the &quot;Your picks&quot; column above.
              </span>
            </div>
          </div>
          {pairs.map((p) => (
            <div key={p.fixtureId} style={{ marginBottom: 12 }}>
              <p className="muted" style={{ margin: "0 0 8px", fontSize: 12.5 }}>
                Fixture: <span className="mono">{p.fixtureId}</span>
              </p>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <ScriptCard label="A" row={p.a} other={p.b} runId={latest.id} fixtureId={p.fixtureId} />
                <ScriptCard label="B" row={p.b} other={p.a} runId={latest.id} fixtureId={p.fixtureId} />
              </div>
            </div>
          ))}
        </div>
      )}

      {votes.length > 0 && (
        <div className="panel">
          <div className="panel-head">
            <h3>Revealed picks</h3>
          </div>
          <div className="panel-body flush">
            <table className="data" style={{ border: "none", borderRadius: 0 }}>
              <thead>
                <tr>
                  <th>Fixture</th>
                  <th>You picked</th>
                  <th>Over</th>
                </tr>
              </thead>
              <tbody>
                {votes.map((v) => (
                  <tr key={v.id}>
                    <td className="mono" style={{ fontSize: 12 }}>{v.fixtureId}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{modelByResult.get(v.winnerResultId) ?? "?"}</td>
                    <td className="mono muted" style={{ fontSize: 12 }}>{modelByResult.get(v.loserResultId) ?? "?"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
