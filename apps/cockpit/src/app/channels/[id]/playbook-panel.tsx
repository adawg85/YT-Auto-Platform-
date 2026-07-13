import { and, desc, eq, inArray } from "drizzle-orm";
import { channelPlaybook, experiments } from "@ytauto/db";
import { getAppContext } from "@/lib/context";
import {
  addPlaybookEntryAction,
  adoptPlaybookEntryAction,
  retirePlaybookEntryAction,
  runRetroNowAction,
} from "./playbook-actions";

/**
 * Channel playbook (#21.5): the standing directives this channel has LEARNED
 * from its own published results (plus operator-authored ones), and the
 * queued experiments the retro agent proposed. Adopted entries are injected
 * into every ideation/script prompt with their WHY.
 */
export async function PlaybookPanel({ channelId }: { channelId: string }) {
  const { db } = await getAppContext();
  const entries = await db
    .select()
    .from(channelPlaybook)
    .where(
      and(
        eq(channelPlaybook.channelId, channelId),
        inArray(channelPlaybook.status, ["trial", "adopted"]),
      ),
    )
    .orderBy(desc(channelPlaybook.confidence));
  const queue = await db
    .select()
    .from(experiments)
    .where(and(eq(experiments.channelId, channelId), eq(experiments.status, "proposed")))
    .orderBy(experiments.priority);

  const statusChip = (s: string) =>
    s === "adopted" ? (
      <span className="chip good">
        <span className="d" />
        Adopted
      </span>
    ) : (
      <span className="chip warn">Trial — approve to apply</span>
    );

  return (
    <div className="panel">
      <div className="panel-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h3>Channel playbook</h3>
        <form action={runRetroNowAction.bind(null, channelId)}>
          <button type="submit" className="btn ghost sm">
            Run retro now
          </button>
        </form>
      </div>
      <div className="panel-body">
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          Standing directives learned from this channel&apos;s own results (matured videos only —
          a hot day-one video can&apos;t change the playbook). Adopted entries steer every future
          script; they outrank market patterns but never the verified facts.
        </p>
        {entries.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>
            Nothing learned yet — the retro runs on the channel&apos;s maturity cadence once enough
            videos have aged past their performance windows.
          </p>
        ) : (
          <table className="data" style={{ marginBottom: 12 }}>
            <thead>
              <tr>
                <th style={{ width: 90 }}>Scope</th>
                <th>Directive</th>
                <th style={{ width: 150 }}>Status</th>
                <th style={{ width: 150 }} />
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>
                    <span className="chip">{e.scope}</span>
                  </td>
                  <td>
                    {e.directive}
                    <div className="muted" style={{ fontSize: 12 }}>
                      {e.why}
                      {e.evidence?.videoIds?.length ? ` · ${e.evidence.videoIds.length} videos` : ""}
                      {` · ${e.origin}`}
                    </div>
                  </td>
                  <td>{statusChip(e.status)}</td>
                  <td style={{ textAlign: "right" }}>
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      {e.status === "trial" && (
                        <form action={adoptPlaybookEntryAction.bind(null, channelId, e.id)}>
                          <button type="submit" className="btn ghost sm">
                            Adopt
                          </button>
                        </form>
                      )}
                      <form action={retirePlaybookEntryAction.bind(null, channelId, e.id)}>
                        <button type="submit" className="btn ghost sm danger-ink">
                          Retire
                        </button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <form action={addPlaybookEntryAction} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input type="hidden" name="channelId" value={channelId} />
          <select name="scope" style={{ height: 36 }}>
            {["hook", "pacing", "structure", "visual", "topic", "title"].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input
            name="directive"
            placeholder="Add your own directive (e.g. 'never open with a date')"
            style={{ flex: 1, minWidth: 240, height: 36 }}
          />
          <button type="submit" className="btn ghost sm" style={{ height: 36 }}>
            Add
          </button>
        </form>

        {queue.length > 0 && (
          <>
            <h4 style={{ margin: "16px 0 6px" }}>Experiment queue</h4>
            <p className="muted" style={{ margin: "0 0 8px", fontSize: 12.5 }}>
              Proposed single-variable trials, run one at a time. The next starts automatically
              when the active one concludes (supervised channels); wins graduate into the playbook.
            </p>
            <table className="data">
              <thead>
                <tr>
                  <th style={{ width: 60 }}>#</th>
                  <th>Variable</th>
                  <th>Variant</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((q, i) => (
                  <tr key={q.id}>
                    <td className="num">{q.priority ?? i + 1}</td>
                    <td>{q.variable}</td>
                    <td className="muted">{q.variant}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
