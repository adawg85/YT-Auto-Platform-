import { desc, eq } from "drizzle-orm";
import { channelCharacters, channelDna, styleTestScenes, visualStyleRefs, visualStyles } from "@ytauto/db";
import { IMAGE_ENGINES, imageEngineForRole, resolveProductionProfile } from "@ytauto/core";
import { CHARACTER_ENGINE_LABELS } from "@/lib/characters";
import { getAppContext } from "@/lib/context";
import { fmtDate } from "@/lib/format";
import {
  activateStyleAction,
  addYoutubeStyleRefAction,
  createChannelCharacterAction,
  deleteChannelCharacterAction,
  deleteStyleRefAction,
  setChannelImageStyleAction,
  setCharacterCastModeAction,
  toggleChannelCharacterAction,
  toggleStyleRefAction,
  updateStyleConditioningAction,
} from "../style-actions";
import { DistillForm } from "./distill-form";
import { StyleUpload } from "./style-upload";
import { CharacterRefine } from "./character-refine";
import { CharacterCastMode } from "./character-cast-mode";
import { StyleTest, type TestSceneRow } from "./style-test";

/**
 * #35.1 visual style DNA (server-rendered, form-posted like the Playbook
 * panel): the example-image pool, the distilled versioned style docs, and the
 * image-to-image conditioning dials.
 */

const SOURCE_LABEL: Record<string, string> = {
  upload: "Uploaded",
  youtube: "YouTube",
  asset: "Own asset",
  generated: "AI test scene",
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
  // test scenes render against the NEWEST version — the point is trying a
  // fresh distill before activation
  const newestStyle = versions[0] ?? null;
  const sceneRows = await db
    .select()
    .from(styleTestScenes)
    .where(eq(styleTestScenes.channelId, channelId))
    .orderBy(desc(styleTestScenes.createdAt));
  const versionById = new Map(versions.map((v) => [v.id, v.version]));
  const charById = new Map(characters.map((c) => [c.id, c.name]));
  const testScenes: TestSceneRow[] = sceneRows.map((s) => ({
    id: s.id,
    imageKey: s.imageKey,
    prompt: s.prompt,
    lastComments: s.lastComments,
    characterName: s.characterId ? (charById.get(s.characterId) ?? null) : null,
    styleVersion: versionById.get(s.styleId) ?? 0,
  }));
  const active = versions.find((v) => v.id === activeStyleId && v.status === "active");
  const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, channelId));

  const houseStyle = (dna?.visualStyle?.imageStyle ?? "").trim();
  // the channel's declared character model (Production Profile) preselects the picker
  const defaultCharacterEngine = imageEngineForRole(resolveProductionProfile(dna?.productionProfile), "character");

  return (
    <div>
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h3>House style</h3>
          {houseStyle ? (
            <span className="chip good">
              <span className="d" />
              Set
            </span>
          ) : (
            <span className="chip">Not set</span>
          )}
        </div>
        <div className="panel-body">
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            The channel&apos;s look in plain language — it steers <strong>every</strong> generated
            image, characters and scenes alike. This starts <strong>blank</strong> on purpose: while
            it is empty the platform imposes <strong>no</strong> style of its own, so what you write
            here (or set over MCP with <code>set_channel_config</code> → <code>dna.imageStyle</code>)
            is the only look in play. Distilling example images below produces a richer style that
            <strong> takes precedence</strong> over this text once activated.
          </p>
          <form action={setChannelImageStyleAction.bind(null, channelId)}>
            <textarea
              name="imageStyle"
              rows={2}
              defaultValue={houseStyle}
              maxLength={400}
              placeholder="e.g. bold graphic illustration, painted graphic-novel look, dramatic light as bold design — NOT photographic, NOT 3D"
              style={{ width: "100%", resize: "vertical" }}
            />
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
              <button type="submit" className="btn sm">
                Save house style
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                Clear the box and save to remove it — blank means no style at all, never a default.
              </span>
            </div>
          </form>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h3>Example images</h3>
        </div>
        <div className="panel-body">
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            Seed this channel&apos;s look from real pictures. Two ways to add examples:{" "}
            <strong>upload your own images</strong> (PNG/JPG/WebP, up to 8 at once) or{" "}
            <strong>paste a YouTube URL</strong> (its thumbnail is pulled in free). You can also
            promote your own past thumbnails from a production page. Variety matters: aim for at
            least 3 examples that share the look you want, then Distill below.
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
            <StyleUpload channelId={channelId} />
            <span className="muted" style={{ fontSize: 12.5 }}>or</span>
            <form action={addYoutubeStyleRefAction.bind(null, channelId)} style={{ display: "flex", gap: 8, flex: "1 1 320px" }}>
              <input
                name="url"
                placeholder="Paste a YouTube video URL to learn its thumbnail style"
                style={{ flex: 1, height: 36 }}
                autoComplete="off"
              />
              <button type="submit" className="btn ghost sm" style={{ height: 36 }}>
                Add URL
              </button>
            </form>
          </div>
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
            Distilling runs in the background — the new version appears under Style versions in
            about a minute (this page refreshes live).
          </p>
          <DistillForm channelId={channelId} disabled={refs.filter((r) => r.enabled).length === 0} />
        </div>
      </div>

      <StyleTest
        channelId={channelId}
        styleId={newestStyle?.id ?? null}
        styleVersion={newestStyle?.version ?? null}
        characters={characters.filter((c) => c.enabled).map((c) => ({ id: c.id, name: c.name }))}
        scenes={testScenes}
      />

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h3>Characters</h3>
        </div>
        <div className="panel-body">
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            Recurring characters rendered in this channel&apos;s style — e.g. the teacher an
            educational channel keeps across every video. Describe who they are (physical identity
            only — the look comes from the channel style); an agent writes a canonical appearance,
            renders a reference sheet on the model you pick, and casts them into generated shots.
            Set <strong>Appears → Every scene</strong> for a mascot who should be in every shot;{" "}
            <strong>Auto</strong> lets the agent cast a presenter only into talking/demo shots.
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
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className="muted" style={{ fontSize: 12.5 }}>Model</span>
              <select name="imageEngine" defaultValue={defaultCharacterEngine} className="mini-select" style={{ height: 36 }}>
                {IMAGE_ENGINES.map((e) => (
                  <option key={e} value={e}>
                    {CHARACTER_ENGINE_LABELS[e]}
                    {e === defaultCharacterEngine ? " — channel default" : ""}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="btn sm" style={{ height: 36 }}>
              Create character
            </button>
          </form>
          <p className="muted" style={{ fontSize: 12, marginTop: -4, marginBottom: 12 }}>
            The model defaults to this channel&apos;s <strong>characterImageEngine</strong> (Production
            Profile) and can be overridden per character here. Nano Banana holds a face best when you
            later <strong>Refine</strong> (it conditions on the existing sheet), so prefer it for
            characters you expect to revise.
          </p>
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
                  <div style={{ marginTop: 6 }}>
                    <CharacterCastMode
                      channelId={channelId}
                      characterId={c.id}
                      value={c.castMode ?? "auto"}
                      target={c.castTarget ?? 55}
                    />
                  </div>
                  <div style={{ display: "flex", gap: 4, marginTop: 6, flexWrap: "wrap" }}>
                    <CharacterRefine
                      channelId={channelId}
                      characterId={c.id}
                      name={c.name}
                      engines={IMAGE_ENGINES.map((e) => [e, CHARACTER_ENGINE_LABELS[e]] as [string, string])}
                      defaultEngine={defaultCharacterEngine}
                    />
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
            {active === undefined && (() => {
              // newest non-retired version is the one to activate
              const activatable = versions.find((v) => v.status !== "retired");
              return (
                <div className="callout warn" style={{ marginBottom: 12 }}>
                  <span>
                    <strong>No style is active</strong> — your productions ignore the distilled look
                    and characters and fall back to the plain channel image style. Activate a version
                    to make videos use it.
                  </span>
                  {activatable && (
                    <form action={activateStyleAction.bind(null, channelId, activatable.id)} style={{ marginLeft: "auto" }}>
                      <button type="submit" className="btn sm">
                        Activate v{activatable.version}
                      </button>
                    </form>
                  )}
                </div>
              );
            })()}
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
    </div>
  );
}
