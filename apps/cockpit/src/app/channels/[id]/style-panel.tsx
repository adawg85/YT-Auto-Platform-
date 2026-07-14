import { desc, eq } from "drizzle-orm";
import { channelCharacters, visualStyleRefs, visualStyles } from "@ytauto/db";
import { getAppContext } from "@/lib/context";
import { fmtDate } from "@/lib/format";
import {
  activateStyleAction,
  addYoutubeStyleRefAction,
  createChannelCharacterAction,
  deleteChannelCharacterAction,
  deleteStyleRefAction,
  distillStyleAction,
  toggleChannelCharacterAction,
  toggleStyleRefAction,
  updateStyleConditioningAction,
} from "../style-actions";
import { StyleUpload } from "./style-upload";

/**
 * #35.1 visual style DNA (server-rendered, form-posted like the Playbook
 * panel): the example-image pool, the distilled versioned style docs, and the
 * image-to-image conditioning dials.
 */

const SOURCE_LABEL: Record<string, string> = {
  upload: "Uploaded",
  youtube: "YouTube",
  asset: "Own asset",
};

const SCOPE_LABEL: Record<string, string> = {
  off: "Off — prompts only",
  thumbnails: "Thumbnails",
  thumbs_hero: "Thumbnails + hero shots",
  all_generated: "All generated shots",
};

export async function StylePanel({
  channelId,
  activeStyleId,
  presignAvailable,
}: {
  channelId: string;
  activeStyleId: string | null;
  presignAvailable: boolean;
}) {
  const { db } = await getAppContext();
  const refs = await db
    .select()
    .from(visualStyleRefs)
    .where(eq(visualStyleRefs.channelId, channelId))
    .orderBy(desc(visualStyleRefs.createdAt));
  const versions = await db
    .select()
    .from(visualStyles)
    .where(eq(visualStyles.channelId, channelId))
    .orderBy(desc(visualStyles.version));
  const characters = await db
    .select()
    .from(channelCharacters)
    .where(eq(channelCharacters.channelId, channelId))
    .orderBy(desc(channelCharacters.createdAt));
  const active = versions.find((v) => v.id === activeStyleId && v.status === "active");

  return (
    <div>
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <h3>Example images</h3>
          <StyleUpload channelId={channelId} />
        </div>
        <div className="panel-body">
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            Seed this channel&apos;s look from real pictures — upload thumbnails/frames you like,
            paste other YouTube videos&apos; URLs (their thumbnail is pulled free), or promote your
            own past thumbnails from a production page. Variety matters: aim for at least 3
            examples that share the look you want.
          </p>
          <form action={addYoutubeStyleRefAction.bind(null, channelId)} style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input
              name="url"
              placeholder="Paste a YouTube video URL whose thumbnail style you want to learn from"
              style={{ flex: 1, height: 36 }}
              autoComplete="off"
            />
            <button type="submit" className="btn ghost sm" style={{ height: 36 }}>
              Add
            </button>
          </form>
          {refs.length === 0 ? (
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>
              No examples yet.
            </p>
          ) : (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {refs.map((r) => (
                <div key={r.id} style={{ width: 168, opacity: r.enabled ? 1 : 0.45 }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/media/${r.storageKey}`}
                    alt="Style reference"
                    style={{ width: "100%", aspectRatio: "16/9", objectFit: "cover", borderRadius: 8 }}
                  />
                  <div style={{ display: "flex", gap: 4, alignItems: "center", marginTop: 4, flexWrap: "wrap" }}>
                    <span className="chip" style={{ fontSize: 10.5 }}>
                      {SOURCE_LABEL[r.source?.type ?? ""] ?? "Ref"}
                    </span>
                    <form action={toggleStyleRefAction.bind(null, channelId, r.id)}>
                      <button type="submit" className="btn ghost sm" style={{ padding: "2px 8px", fontSize: 11 }}>
                        {r.enabled ? "Disable" : "Enable"}
                      </button>
                    </form>
                    <form action={deleteStyleRefAction.bind(null, channelId, r.id)}>
                      <button type="submit" className="btn ghost sm danger-ink" style={{ padding: "2px 8px", fontSize: 11 }}>
                        Remove
                      </button>
                    </form>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h3>Distill the style</h3>
        </div>
        <div className="panel-body">
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            One vision pass over the enabled examples (newest 8) writes a structured style doc —
            palette, lighting, composition, typography, energy — that flows into EVERY image and
            thumbnail prompt. Each distillation is a new draft version; activation is explicit.
          </p>
          <form action={distillStyleAction.bind(null, channelId)} style={{ display: "flex", gap: 8 }}>
            <input
              name="notes"
              placeholder="Optional steer (e.g. 'lean darker and more cinematic')"
              style={{ flex: 1, height: 36 }}
            />
            <button type="submit" className="btn sm" style={{ height: 36 }} disabled={refs.filter((r) => r.enabled).length === 0}>
              Distill from examples
            </button>
          </form>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h3>Characters</h3>
        </div>
        <div className="panel-body">
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            Recurring characters rendered with Nano Banana in this channel&apos;s style — e.g. the
            teacher an educational channel keeps across every video. Describe who they are; the
            engine writes a canonical look, generates a reference sheet, and from then on the
            image agent casts them into generated shots whose scene calls for them (and skips
            them where it doesn&apos;t).
          </p>
          <form
            action={createChannelCharacterAction.bind(null, channelId)}
            style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}
          >
            <input name="name" placeholder="Name — e.g. Ms. Park" style={{ width: 180, height: 36 }} required />
            <input
              name="brief"
              placeholder='Who are they? e.g. "a warm, no-nonsense physics teacher in her 40s, chalk in hand"'
              style={{ flex: 1, minWidth: 260, height: 36 }}
              required
            />
            <button type="submit" className="btn sm" style={{ height: 36 }}>
              Create with Nano Banana
            </button>
          </form>
          {characters.length === 0 ? (
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>
              No characters yet — faceless channels don&apos;t need one.
            </p>
          ) : (
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              {characters.map((c) => (
                <div key={c.id} style={{ width: 200, opacity: c.enabled ? 1 : 0.45 }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/media/${c.imageKey}`}
                    alt={`Character: ${c.name}`}
                    style={{ width: "100%", aspectRatio: "1/1", objectFit: "cover", borderRadius: 10, border: "1px solid var(--border)" }}
                  />
                  <div style={{ display: "flex", gap: 6, alignItems: "baseline", marginTop: 6, flexWrap: "wrap" }}>
                    <strong style={{ fontSize: 13 }}>{c.name}</strong>
                    <span className={`chip${c.enabled ? " good" : ""}`} style={{ fontSize: 10.5 }}>
                      {c.enabled ? "In use" : "Off"}
                    </span>
                  </div>
                  <details style={{ marginTop: 2 }}>
                    <summary className="muted" style={{ cursor: "pointer", fontSize: 12 }}>
                      Canonical look
                    </summary>
                    <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>{c.description}</p>
                  </details>
                  <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
                    <form action={toggleChannelCharacterAction.bind(null, channelId, c.id)}>
                      <button type="submit" className="btn ghost sm" style={{ padding: "2px 8px", fontSize: 11 }}>
                        {c.enabled ? "Disable" : "Enable"}
                      </button>
                    </form>
                    <form action={deleteChannelCharacterAction.bind(null, channelId, c.id)}>
                      <button type="submit" className="btn ghost sm danger-ink" style={{ padding: "2px 8px", fontSize: 11 }}>
                        Remove
                      </button>
                    </form>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {versions.length > 0 && (
        <div className="panel">
          <div className="panel-head">
            <h3>Style versions</h3>
          </div>
          <div className="panel-body">
            {!presignAvailable && (
              <div className="callout warn" style={{ marginBottom: 12 }}>
                <span>
                  This store can&apos;t presign URLs (local fs), so image-to-image conditioning is
                  skipped — the distilled doc still flows into every prompt.
                </span>
              </div>
            )}
            {versions.map((v) => {
              const isActive = v.status === "active";
              const cond = v.doc.conditioning ?? { scope: "thumbs_hero", strength: 0.45 };
              return (
                <div key={v.id} className="panel" style={{ marginBottom: 10, borderLeft: isActive ? "3px solid var(--good, #22c55e)" : undefined }}>
                  <div className="panel-body">
                    <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                      <strong>v{v.version}</strong>
                      {isActive ? (
                        <span className="chip good">
                          <span className="d" />
                          Active
                        </span>
                      ) : (
                        <span className="chip">{v.status}</span>
                      )}
                      <span className="muted" style={{ fontSize: 12 }}>
                        {fmtDate(v.createdAt)} · {v.doc.refIds?.length ?? 0} examples
                      </span>
                      {!isActive && v.status !== "retired" && (
                        <form action={activateStyleAction.bind(null, channelId, v.id)} style={{ marginLeft: "auto" }}>
                          <button type="submit" className="btn ghost sm">
                            Activate
                          </button>
                        </form>
                      )}
                    </div>
                    {v.rationale && (
                      <p className="muted" style={{ margin: "6px 0 0", fontSize: 12.5, fontStyle: "italic" }}>{v.rationale}</p>
                    )}
                    <details style={{ marginTop: 8 }}>
                      <summary className="muted" style={{ cursor: "pointer", fontSize: 12.5 }}>
                        Style doc
                      </summary>
                      <table className="data" style={{ marginTop: 8 }}>
                        <tbody>
                          {(
                            [
                              ["Palette", v.doc.palette],
                              ["Lighting", v.doc.lighting],
                              ["Composition", v.doc.composition],
                              ["Subject", v.doc.subjectTreatment],
                              ["Texture", v.doc.texture],
                              ["Typography", v.doc.typography],
                              ["Energy", v.doc.energy],
                              ["Prompt suffix", v.doc.promptSuffix],
                            ] as const
                          ).map(([k, val]) => (
                            <tr key={k}>
                              <td style={{ width: 120, fontWeight: 600 }}>{k}</td>
                              <td className="muted">{val}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </details>
                    {isActive && (
                      <form
                        action={updateStyleConditioningAction.bind(null, channelId, v.id)}
                        style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}
                      >
                        <span className="field-label" style={{ margin: 0 }}>
                          Image conditioning
                        </span>
                        <select name="scope" defaultValue={cond.scope} style={{ height: 34 }}>
                          {Object.entries(SCOPE_LABEL).map(([k, label]) => (
                            <option key={k} value={k}>
                              {label}
                            </option>
                          ))}
                        </select>
                        <input
                          name="strength"
                          type="number"
                          min={0.1}
                          max={0.9}
                          step={0.05}
                          defaultValue={cond.strength}
                          style={{ width: 80, height: 34 }}
                          title="flux image-to-image strength (nano /edit ignores it)"
                        />
                        <button type="submit" className="btn ghost sm" style={{ height: 34 }}>
                          Save
                        </button>
                        <span className="muted" style={{ fontSize: 11.5 }}>
                          Hero/nano conditioned images ≈ $0.15 each; &quot;all generated&quot; conditions every AI shot.
                        </span>
                      </form>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {active === undefined && versions.length > 0 && (
        <p className="muted" style={{ fontSize: 12.5 }}>
          No active style — productions use the plain channel image style until you activate a version.
        </p>
      )}
    </div>
  );
}
