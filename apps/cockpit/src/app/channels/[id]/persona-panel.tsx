"use client";

import { useState, useTransition } from "react";
import type { PersonaDoc } from "@ytauto/db";
import type { VoiceOption } from "@ytauto/providers";
import {
  activatePersonaAction,
  regeneratePersonaAction,
  updatePersonaPaceAction,
} from "../editorial-actions";
import { updateVoiceToneAction } from "../actions";
import { VoicePicker } from "../voice-picker";
import { useRefreshHold } from "@/lib/refresh-guard";

export type PersonaRow = {
  id: string;
  name: string;
  archetype: string;
  version: number;
  status: string;
  createdBy: string;
  rationale: string | null;
  createdAt: string;
  doc: PersonaDoc;
};

const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  draft: "Draft",
  testing: "Testing",
  retired: "Retired",
};

/**
 * Persona tab (BACKLOG #21.1): the channel's writing voice — view the active
 * document, browse version lineage, activate a version, or ask the AI for a
 * tweaked new version (always lands as a draft; activation is explicit).
 */
export type PersonaVoiceTone = {
  tone: string;
  audiencePersona: string;
  hookStyles: string[];
  ctaTemplate: string;
  voiceId: string;
};

export function PersonaPanel({
  channelId,
  rows,
  activeId,
  voices = [],
  dna = null,
}: {
  channelId: string;
  rows: PersonaRow[];
  activeId: string | null;
  /** TTS voice library for the Voice & tone panel. */
  voices?: VoiceOption[];
  /** Current narrator-adjacent DNA values (voice/tone/audience/hooks/CTA). */
  dna?: PersonaVoiceTone | null;
}) {
  const [pending, startTransition] = useTransition();
  const [tweak, setTweak] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  // Voice & tone: the platform-wide LiveRefresh (SSE / 20s backstop) remounts this
  // panel and re-seeds every form field from server props, silently reverting an
  // in-progress edit before the operator clicks Save — the "voice doesn't save" bug.
  // Hold refresh while the form is focused (covers the uncontrolled text fields) or
  // the voice pick differs from what's saved (a pick persists past blur).
  const [voiceId, setVoiceId] = useState<string>(dna?.voiceId ?? "");
  const [voiceToneFocused, setVoiceToneFocused] = useState(false);
  const voiceToneDirty = voiceId !== (dna?.voiceId ?? "");
  useRefreshHold(voiceToneDirty || voiceToneFocused);

  const active = rows.find((r) => r.id === activeId) ?? rows.find((r) => r.status === "active");
  const shown = openId ? (rows.find((r) => r.id === openId) ?? active) : active;
  // #26: narration pace lives on the ACTIVE persona doc (default natural)
  const [pace, setPace] = useState<"slow" | "natural" | "brisk">(active?.doc.pace ?? "natural");

  const activate = (personaId: string) =>
    startTransition(async () => {
      setError(null);
      await activatePersonaAction(channelId, personaId);
      setNotice("Persona activated — the next script is written in this voice.");
    });

  const regenerate = () =>
    startTransition(async () => {
      setError(null);
      setNotice(null);
      const res = await regeneratePersonaAction(channelId, { tweakNotes: tweak || undefined });
      if ("error" in res) setError(res.error);
      else {
        setTweak("");
        setNotice("New version drafted — review it below, then activate.");
      }
    });

  return (
    <div>
      <h1 className="page-title" style={{ marginBottom: 4 }}>
        Writing persona
      </h1>
      <p className="page-sub" style={{ marginBottom: 18 }}>
        Who the narrator IS — every episode is written in this one voice. Changes are always a
        new version (the AI can propose tweaks as experiments; nothing shifts silently).
      </p>

      {error && <p style={{ color: "var(--crit, #ef4444)", marginBottom: 12 }}>{error}</p>}
      {notice && <p className="muted" style={{ marginBottom: 12 }}>{notice}</p>}

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <div className="panel">
          <div className="panel-head">
            <h3>
              {shown ? `${shown.name} · v${shown.version}` : "No persona yet"}
            </h3>
            {shown && (
              <span className={`chip${shown.status === "active" ? " good" : shown.status === "draft" ? " warn" : ""}`}>
                {STATUS_LABEL[shown.status] ?? shown.status}
              </span>
            )}
          </div>
          {shown ? (
            <div className="panel-body" style={{ display: "grid", gap: 12 }}>
              <div>
                <div className="field-label">Identity</div>
                <p style={{ margin: "4px 0 0" }}>{shown.doc.identity}</p>
              </div>
              <div>
                <div className="field-label">How they talk</div>
                <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                  {shown.doc.voiceRules.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
              <div>
                <div className="field-label">In their voice</div>
                {shown.doc.exemplars.map((e, i) => (
                  <blockquote key={i} className="muted" style={{ margin: "6px 0 0", paddingLeft: 10, borderLeft: "2px solid var(--border)" }}>
                    {e}
                  </blockquote>
                ))}
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <span className="chip">{shown.archetype.replace(/_/g, " ")}</span>
                <span className="chip">delivery: {shown.doc.deliveryDefault}</span>
                <span className="chip">avoids: {shown.doc.lexicon.avoid.slice(0, 3).join(", ")}…</span>
              </div>
              {shown.rationale && (
                <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Why: {shown.rationale}</p>
              )}
              {shown.status !== "active" && (
                <div>
                  <button className="btn sm" disabled={pending} onClick={() => activate(shown.id)}>
                    {pending ? "Working…" : `Activate v${shown.version}`}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="panel-body">
              <p className="muted">
                This channel predates personas — the pipeline auto-seeds a default on its next
                production, or draft one now with the box on the right.
              </p>
            </div>
          )}
        </div>

        <div style={{ display: "grid", gap: 14 }}>
          <div className="panel">
            <div className="panel-head">
              <h3>Propose a new version</h3>
            </div>
            <div className="panel-body">
              <p className="muted" style={{ marginTop: 0, fontSize: 12.5 }}>
                The AI redrafts the persona (same person, applied tweak) as a draft you review.
              </p>
              <textarea
                rows={2}
                placeholder="Optional tweak, e.g. “more dry humour, shorter sentences”"
                value={tweak}
                onChange={(e) => setTweak(e.target.value)}
                style={{ width: "100%" }}
              />
              <div style={{ marginTop: 8 }}>
                <button className="btn sm" disabled={pending} onClick={regenerate}>
                  {pending ? "Drafting…" : "Draft new version"}
                </button>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h3>Voice &amp; tone</h3>
            </div>
            <div className="panel-body">
              <p className="muted" style={{ marginTop: 0, fontSize: 12.5 }}>
                How the persona sounds — narration voice, tone, audience, hooks and CTA.
                (Moved here from Settings &amp; DNA.)
              </p>
              <form
                action={updateVoiceToneAction.bind(null, channelId)}
                onFocusCapture={() => setVoiceToneFocused(true)}
                onBlurCapture={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setVoiceToneFocused(false);
                }}
              >
                {voices.length > 0 ? (
                  <VoicePicker voices={voices} current={dna?.voiceId} onChange={setVoiceId} />
                ) : (
                  <label>
                    Voice ID <span className="muted">— TTS provider voice</span>
                    <input
                      type="text"
                      name="voiceId"
                      defaultValue={dna?.voiceId ?? ""}
                      onChange={(e) => setVoiceId(e.target.value)}
                      placeholder="voice id from your TTS provider"
                    />
                  </label>
                )}
                <label>
                  Tone
                  <input type="text" name="tone" defaultValue={dna?.tone ?? ""} placeholder="curious, punchy, no jargon" />
                </label>
                <label>
                  Audience persona
                  <textarea
                    name="audiencePersona"
                    rows={2}
                    defaultValue={dna?.audiencePersona ?? ""}
                    placeholder="commuters who like 'today I learned' content"
                    style={{ width: "100%", resize: "vertical" }}
                  />
                </label>
                <label>
                  Hook styles <span className="muted">— comma-separated</span>
                  <input
                    type="text"
                    name="hookStyles"
                    defaultValue={dna?.hookStyles.join(", ") ?? ""}
                    placeholder="curiosity_gap, stakes_first, contrarian"
                  />
                </label>
                <label>
                  CTA template
                  <input
                    type="text"
                    name="ctaTemplate"
                    defaultValue={dna?.ctaTemplate ?? ""}
                    placeholder="Follow for the next episode."
                  />
                </label>
                <div style={{ marginTop: 8 }}>
                  <button type="submit" className="btn sm">
                    Save voice &amp; tone
                  </button>
                </div>
              </form>
              {active && (
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
                  <label>
                    Narration pace{" "}
                    <span className="muted">— TTS speed for the active persona</span>
                    <select
                      value={pace}
                      disabled={pending}
                      onChange={(e) => {
                        const next = e.target.value as "slow" | "natural" | "brisk";
                        setPace(next);
                        startTransition(async () => {
                          setError(null);
                          await updatePersonaPaceAction(channelId, next);
                          setNotice("Pace saved — the next voiceover uses it.");
                        });
                      }}
                    >
                      <option value="slow">Slow — unhurried, deliberate</option>
                      <option value="natural">Natural — the voice&apos;s own pace</option>
                      <option value="brisk">Brisk — a touch faster</option>
                    </select>
                  </label>
                </div>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h3>Versions</h3>
            </div>
            <div className="panel-body" style={{ padding: 0 }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>v</th>
                    <th>Name</th>
                    <th>Status</th>
                    <th>By</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>v{r.version}</td>
                      <td>
                        <button className="linklike" onClick={() => setOpenId(r.id)}>
                          {r.name}
                        </button>
                      </td>
                      <td>
                        <span className={`chip${r.status === "active" ? " good" : r.status === "draft" ? " warn" : ""}`}>
                          {STATUS_LABEL[r.status] ?? r.status}
                        </span>
                      </td>
                      <td className="muted">{r.createdBy}</td>
                      <td>
                        {r.status !== "active" && (
                          <button className="btn ghost sm" disabled={pending} onClick={() => activate(r.id)}>
                            Activate
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={5} className="muted">
                        No versions yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
