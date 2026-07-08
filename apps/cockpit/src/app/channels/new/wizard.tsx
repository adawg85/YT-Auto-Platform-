"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import type { CharterProposal, IdentityProposals } from "@ytauto/core";
import type { WizardPatch } from "@ytauto/agents";
import { IconSparkle, IconChevronLeft, IconRefresh } from "@/components/icons";
import {
  createChannelWithCharterAction,
  generateChannelAvatarAction,
  proposeCharterWizardAction,
  proposeIdentityWizardAction,
} from "../editorial-actions";
import { WizardAssistant } from "./wizard-assistant";
import { ObjectivesPicker } from "./objectives-picker";

const TIERS = [
  { value: 0, label: "T0 — Manual: every gate requires approval" },
  { value: 1, label: "T1 — Assisted: script + final review gated" },
  { value: 2, label: "T2 — Supervised: auto-publishes private; you click Release" },
  { value: 3, label: "T3 — Exception-only: fully automated unless flagged" },
];

const FORMATS = [
  { value: "short", label: "Short-form" },
  { value: "long", label: "Long-form" },
  { value: "both", label: "Both" },
] as const;

const STEPS = ["Niche & intent", "Identity", "Review charter", "Provision"] as const;

/** Quick-pick tone presets for Channel DNA (still free-editable below). */
const TONE_PRESETS = [
  "Authoritative",
  "Cinematic",
  "Playful",
  "Contrarian",
  "Warm",
  "Energetic",
  "Deadpan",
  "Investigative",
  "Conversational",
  "Inspirational",
] as const;

/** Every editable field the wizard tracks — one object so the co-pilot can patch it. */
type Fields = {
  niche: string;
  intent: string;
  format: "short" | "long" | "both";
  researchDepth: "standard" | "deep";
  cadencePerWeek: number;
  targetLengthSec: number;
  warmupWeeks: number;
  warmupVideos: number;
  firstMonthTarget: number;
  monthlySteady: number;
  autonomyTier: number;
  monetisationSafe: boolean;
  name: string;
  handle: string;
  mission: string;
  objectives: string;
  domains: string;
  minSources: number;
  presentDebate: boolean;
  tone: string;
  persona: string;
  hookStyles: string;
  forbidden: string;
  imageStyle: string;
  cta: string;
};

const DEFAULT_FIELDS: Fields = {
  niche: "",
  intent: "",
  format: "short",
  researchDepth: "deep",
  cadencePerWeek: 12,
  targetLengthSec: 45,
  warmupWeeks: 2,
  warmupVideos: 14,
  firstMonthTarget: 40,
  monthlySteady: 50,
  autonomyTier: 1,
  monetisationSafe: true,
  name: "",
  handle: "",
  mission: "",
  objectives: "",
  domains: "",
  minSources: 2,
  presentDebate: true,
  tone: "",
  persona: "",
  hookStyles: "",
  forbidden: "",
  imageStyle: "",
  cta: "",
};

/** Wizard progress autosaved to localStorage so an error/refresh doesn't reset. */
const DRAFT_KEY = "ytauto:new-channel-draft:v1";
type PersistedDraft = {
  fields: Fields;
  step: number;
  maxStep: number;
  charter: CharterProposal | null;
  identity: IdentityProposals | null;
  picked: number | null;
  avatarUrl: string | null;
};

/**
 * Channel-setup wizard (build #5): pre-filled channel defaults → co-create the
 * charter with the AI → pick/re-roll an identity → review/edit → generate an
 * avatar and create. A persistent co-pilot dock rides along the whole flow and
 * can edit any field. YouTube provisioning stays a manual checklist (no API).
 */
export function ChannelWizard() {
  const [step, setStep] = useState(0);
  const [maxStep, setMaxStep] = useState(0);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [fields, setFields] = useState<Fields>(DEFAULT_FIELDS);
  const set = <K extends keyof Fields>(key: K, value: Fields[K]) =>
    setFields((f) => ({ ...f, [key]: value }));
  const applyPatch = (patch: WizardPatch) =>
    setFields((f) => ({ ...f, ...(patch as Partial<Fields>) }));

  const [charter, setCharter] = useState<CharterProposal | null>(null);
  const [identity, setIdentity] = useState<IdentityProposals | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [regenInstructions, setRegenInstructions] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);

  // ── Draft persistence ─────────────────────────────────────────────────────
  // An error, refresh or accidental close used to lose all wizard progress.
  // Autosave to localStorage and restore on mount (client-only, so it runs in
  // an effect to avoid a hydration mismatch); cleared on a successful create.
  const [draftRestored, setDraftRestored] = useState(false);
  const hydrated = useRef(false);

  const clearDraft = () => {
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* storage unavailable — nothing to clear */
    }
  };

  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const d = JSON.parse(raw) as Partial<PersistedDraft>;
        if (d.fields) setFields((f) => ({ ...f, ...d.fields }));
        if (typeof d.step === "number") setStep(d.step);
        if (typeof d.maxStep === "number") setMaxStep(d.maxStep);
        if (d.charter !== undefined) setCharter(d.charter);
        if (d.identity !== undefined) setIdentity(d.identity);
        if (d.picked !== undefined) setPicked(d.picked);
        if (d.avatarUrl !== undefined) setAvatarUrl(d.avatarUrl);
        setDraftRestored(true);
      }
    } catch {
      /* corrupt/absent draft — start fresh */
    }
    hydrated.current = true;
  }, []);

  useEffect(() => {
    if (!hydrated.current || channelId) return; // don't persist after create
    const draft: PersistedDraft = { fields, step, maxStep, charter, identity, picked, avatarUrl };
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      /* storage full/unavailable — non-fatal */
    }
  }, [fields, step, maxStep, charter, identity, picked, avatarUrl, channelId]);

  const startOver = () => {
    clearDraft();
    setFields(DEFAULT_FIELDS);
    setCharter(null);
    setIdentity(null);
    setPicked(null);
    setRegenInstructions("");
    setAvatarUrl(null);
    setDraftRestored(false);
    setError(null);
    setMaxStep(0);
    setStep(0);
  };

  const goto = (s: number) => {
    if (s <= maxStep) setStep(s);
  };
  const advance = (s: number) => {
    setStep(s);
    setMaxStep((m) => Math.max(m, s));
  };

  const run = (fn: () => Promise<void>) => {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  };

  // Picking a content format applies a research-backed preset (length + release
  // plan) — see docs/research/monetization-targets.md. The operator can still
  // fine-tune every number afterwards.
  const FORMAT_PRESET: Record<
    Fields["format"],
    Pick<Fields, "targetLengthSec" | "cadencePerWeek" | "warmupWeeks" | "warmupVideos" | "firstMonthTarget" | "monthlySteady">
  > = {
    short: { targetLengthSec: 45, cadencePerWeek: 12, warmupWeeks: 2, warmupVideos: 14, firstMonthTarget: 40, monthlySteady: 50 },
    long: { targetLengthSec: 480, cadencePerWeek: 4, warmupWeeks: 3, warmupVideos: 6, firstMonthTarget: 12, monthlySteady: 16 },
    both: { targetLengthSec: 480, cadencePerWeek: 5, warmupWeeks: 3, warmupVideos: 8, firstMonthTarget: 16, monthlySteady: 22 },
  };
  const setFormat = (format: Fields["format"]) =>
    setFields((f) => ({ ...f, format, ...FORMAT_PRESET[format] }));

  // researchDepth is an operator dial on step 1; keep the derived verification
  // bar in sync until the AI draft refines it.
  const setResearchDepth = (depth: "standard" | "deep") =>
    setFields((f) => ({
      ...f,
      researchDepth: depth,
      minSources: depth === "deep" ? 3 : 2,
      presentDebate: depth === "deep",
    }));

  const draftCharter = () =>
    run(async () => {
      const drafted = await proposeCharterWizardAction({
        niche: fields.niche,
        intent: fields.intent,
        format: fields.format,
        researchDepth: fields.researchDepth,
        monetisationSafe: fields.monetisationSafe,
      });
      if ("error" in drafted) throw new Error(drafted.error);
      const proposal = drafted.proposal;
      setCharter(proposal);
      setFields((f) => ({
        ...f,
        mission: proposal.mission,
        objectives: proposal.objectives.join("\n"),
        domains: proposal.sourceStrategy.authoritativeDomains.join(", "),
        minSources: proposal.verificationBar.establishedMinSources,
        presentDebate: proposal.verificationBar.presentDebateMode,
        tone: proposal.dnaDefaults.tone,
        persona: proposal.dnaDefaults.audiencePersona,
        hookStyles: proposal.dnaDefaults.hookStyles.join(", "),
        forbidden: proposal.dnaDefaults.forbiddenTopics.join(", "),
        imageStyle: proposal.dnaDefaults.imageStyle,
        cta: proposal.dnaDefaults.ctaTemplate,
      }));
      const proposed = await proposeIdentityWizardAction({
        niche: fields.niche,
        mission: proposal.mission,
      });
      if ("error" in proposed) throw new Error(proposed.error);
      setIdentity(proposed.proposals);
      advance(1);
    });

  const regenerateIdentities = () =>
    run(async () => {
      const avoid = identity?.options.map((o) => o.name) ?? [];
      const proposed = await proposeIdentityWizardAction({
        niche: fields.niche,
        mission: fields.mission,
        instructions: regenInstructions.trim() || undefined,
        avoid,
      });
      if ("error" in proposed) throw new Error(proposed.error);
      setIdentity(proposed.proposals);
      setPicked(null);
    });

  const pickIdentity = (i: number) => {
    setPicked(i);
    const opt = identity!.options[i]!;
    setFields((f) => ({ ...f, name: opt.name, handle: opt.handle }));
  };

  const generateAvatar = () =>
    run(async () => {
      const promptParts = [
        `Channel avatar / logo for a YouTube channel named "${fields.name}".`,
        fields.mission ? `Mission: ${fields.mission}.` : "",
        fields.imageStyle ? `Visual style: ${fields.imageStyle}.` : "",
        "Clean, iconic, centered, works as a small circular profile picture.",
      ].filter(Boolean);
      const res = await generateChannelAvatarAction({ prompt: promptParts.join(" ") });
      if ("error" in res) throw new Error(res.error);
      setAvatarUrl(res.url);
    });

  const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

  const create = () =>
    run(async () => {
      const res = await createChannelWithCharterAction({
        name: fields.name,
        handle: fields.handle,
        niche: fields.niche,
        contentFormat: fields.format,
        autonomyTier: fields.autonomyTier,
        charter: {
          mission: fields.mission,
          objectives: fields.objectives.split("\n").map((o) => o.trim()).filter(Boolean),
          archetype: charter?.archetype ?? "evergreen_series",
          sourceStrategy: {
            preferredKinds: charter?.sourceStrategy.preferredKinds ?? ["web", "rss"],
            authoritativeDomains: list(fields.domains),
            avoidDomains: charter?.sourceStrategy.avoidDomains ?? [],
          },
          verificationBar: {
            establishedMinSources: fields.minSources,
            presentDebateMode: fields.presentDebate,
          },
          checkinCadence: "weekly",
        },
        dna: {
          tone: fields.tone,
          audiencePersona: fields.persona,
          hookStyles: list(fields.hookStyles),
          forbiddenTopics: list(fields.forbidden),
          imageStyle: fields.imageStyle,
          primaryColor: "#38bdf8",
          font: "Inter",
          voiceId: "default",
          ctaTemplate: fields.cta,
          targetLengthSec: fields.targetLengthSec,
          // scheduler still reads cadence/week — derive it from the steady plan
          cadencePerWeek: Math.max(1, Math.round(fields.monthlySteady / 4.3)),
          releasePlan: {
            warmupWeeks: fields.warmupWeeks,
            warmupVideos: fields.warmupVideos,
            firstMonthTarget: fields.firstMonthTarget,
            monthlySteady: fields.monthlySteady,
          },
        },
        identityProposals: identity
          ? { options: identity.options, pickedIndex: picked }
          : { options: [], pickedIndex: null },
      });
      setChannelId(res.channelId);
      clearDraft();
      setDraftRestored(false);
      advance(3);
    });

  const back = (to: number) => (
    <button className="btn ghost" onClick={() => setStep(to)}>
      <IconChevronLeft /> Back
    </button>
  );

  return (
    <div>
      <div className="wsteps">
        {STEPS.map((label, i) => (
          <button
            key={label}
            className={`chip ${i === step ? "acc" : ""}`}
            style={{ cursor: i <= maxStep ? "pointer" : "not-allowed", opacity: i <= maxStep ? 1 : 0.5 }}
            disabled={i > maxStep}
            onClick={() => goto(i)}
          >
            {i + 1}. {label}
          </button>
        ))}
      </div>
      {draftRestored && channelId === null && (
        <div
          className="callout"
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}
        >
          <span>Draft restored from where you left off.</span>
          <button className="btn ghost sm" onClick={startOver}>
            Start over
          </button>
        </div>
      )}
      {error && <p className="badge red">{error}</p>}

      {step === 0 && (
        <div className="card">
          <label>
            Niche <span className="muted">(narrow beats broad — e.g. &ldquo;aviation history&rdquo;)</span>
            <input value={fields.niche} onChange={(e) => set("niche", e.target.value)} required />
          </label>
          <label>
            What should this channel be? <span className="muted">(your intent, one sentence)</span>
            <input
              value={fields.intent}
              onChange={(e) => set("intent", e.target.value)}
              placeholder="deeply researched evergreen stories, one machine per episode"
            />
          </label>

          <div className="grid-2" style={{ marginTop: 4 }}>
            <label>
              Content format
              <div className="seg" role="tablist" style={{ marginTop: 4 }}>
                {FORMATS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="tab"
                    aria-selected={fields.format === o.value}
                    className={fields.format === o.value ? "on" : ""}
                    onClick={() => setFormat(o.value)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </label>
            <label>
              Research depth
              <div className="seg" role="tablist" style={{ marginTop: 4 }}>
                {(["standard", "deep"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    role="tab"
                    aria-selected={fields.researchDepth === d}
                    className={fields.researchDepth === d ? "on" : ""}
                    onClick={() => setResearchDepth(d)}
                  >
                    {d === "deep" ? "Deep (≥3 sources)" : "Standard (≥2)"}
                  </button>
                ))}
              </div>
            </label>
            <div style={{ gridColumn: "1 / -1" }}>
              <strong style={{ fontSize: 13 }}>Release plan</strong>{" "}
              <span className="muted" style={{ fontSize: 12 }}>
                — warm-up → first month → steady output (preset by format; edit freely)
              </span>
              <div className="grid-2 grid" style={{ marginTop: 6 }}>
                <label>
                  Warm-up length (weeks)
                  <input
                    type="number"
                    min={0}
                    max={12}
                    value={fields.warmupWeeks}
                    onChange={(e) => set("warmupWeeks", Number(e.target.value))}
                  />
                </label>
                <label>
                  Videos during warm-up
                  <input
                    type="number"
                    min={0}
                    max={200}
                    value={fields.warmupVideos}
                    onChange={(e) => set("warmupVideos", Number(e.target.value))}
                  />
                </label>
                <label>
                  First-month target
                  <input
                    type="number"
                    min={1}
                    max={300}
                    value={fields.firstMonthTarget}
                    onChange={(e) => set("firstMonthTarget", Number(e.target.value))}
                  />
                </label>
                <label>
                  Videos / month (steady)
                  <input
                    type="number"
                    min={1}
                    max={300}
                    value={fields.monthlySteady}
                    onChange={(e) => set("monthlySteady", Number(e.target.value))}
                  />
                </label>
              </div>
            </div>
            <label>
              Target length (seconds)
              <input
                type="number"
                min={10}
                max={1800}
                value={fields.targetLengthSec}
                onChange={(e) => set("targetLengthSec", Number(e.target.value))}
              />
            </label>
            <label>
              Autonomy tier
              <select
                value={fields.autonomyTier}
                onChange={(e) => set("autonomyTier", Number(e.target.value))}
              >
                {TIERS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ alignSelf: "end" }}>
              <input
                type="checkbox"
                checked={fields.monetisationSafe}
                onChange={(e) => set("monetisationSafe", e.target.checked)}
              />{" "}
              Keep monetisation-safe (advertiser-friendly)
            </label>
          </div>

          <div style={{ marginTop: "1rem" }}>
            <button onClick={draftCharter} disabled={pending || !fields.niche.trim()}>
              {pending ? "Drafting charter…" : "Draft charter with AI"}
            </button>
          </div>
        </div>
      )}

      {step === 1 && identity && (
        <div>
          <div className="aibox" style={{ marginBottom: 16 }}>
            <h4>
              <IconSparkle /> AI-proposed identities
            </h4>
            <p className="muted">
              Pick one (you can edit it at the review step). You will apply the name, @handle and
              avatar by hand when you create the YouTube channel — they are not settable via API.
            </p>
          </div>
          <div className="grid grid-cards">
            {identity.options.map((opt, i) => (
              <button
                key={opt.handle}
                className={`card ${picked === i ? "selected" : ""}`}
                style={{ textAlign: "left", cursor: "pointer" }}
                onClick={() => pickIdentity(i)}
              >
                <strong>{opt.name}</strong>
                <div className="mono muted">{opt.handle}</div>
                <p className="muted">{opt.avatarConcept}</p>
              </button>
            ))}
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <label>
              Don&apos;t love these? Steer the re-roll{" "}
              <span className="muted">(optional — e.g. &ldquo;punchier&rdquo;, &ldquo;avoid puns&rdquo;)</span>
              <input
                value={regenInstructions}
                onChange={(e) => setRegenInstructions(e.target.value)}
                placeholder="one-word or short instruction"
              />
            </label>
            <button className="btn ghost" onClick={regenerateIdentities} disabled={pending}>
              <IconRefresh /> {pending ? "Generating…" : "Generate 3 more"}
            </button>
          </div>

          <div style={{ marginTop: "1rem", display: "flex", gap: 8 }}>
            {back(0)}
            <button onClick={() => advance(2)} disabled={picked === null}>
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="card">
          <h2>Review &amp; edit</h2>
          <div className="grid-2">
            <label>
              Name
              <input value={fields.name} onChange={(e) => set("name", e.target.value)} required />
            </label>
            <label>
              Handle
              <input value={fields.handle} onChange={(e) => set("handle", e.target.value)} />
            </label>
          </div>
          <label>
            Mission
            <textarea value={fields.mission} onChange={(e) => set("mission", e.target.value)} rows={3} />
          </label>
          <label style={{ marginBottom: 6 }}>
            Objectives <span className="muted">(tick presets, adjust the targets, add your own)</span>
          </label>
          <ObjectivesPicker value={fields.objectives} onChange={(v) => set("objectives", v)} />
          <div className="grid-2">
            <label>
              Authoritative domains <span className="muted">(comma-separated)</span>
              <input value={fields.domains} onChange={(e) => set("domains", e.target.value)} />
            </label>
            <label>
              Autonomy tier
              <select
                value={fields.autonomyTier}
                onChange={(e) => set("autonomyTier", Number(e.target.value))}
              >
                {TIERS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Established facts need N independent sources
              <input
                type="number"
                min={1}
                max={5}
                value={fields.minSources}
                onChange={(e) => set("minSources", Number(e.target.value))}
              />
            </label>
            <label style={{ alignSelf: "end" }}>
              <input
                type="checkbox"
                checked={fields.presentDebate}
                onChange={(e) => set("presentDebate", e.target.checked)}
              />{" "}
              Present-the-debate mode for contested claims
            </label>
          </div>
          <h2>Channel DNA</h2>
          <div className="grid-2">
            <label>
              Tone
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "6px 0 8px" }}>
                {TONE_PRESETS.map((t) => {
                  const on = fields.tone.trim().toLowerCase() === t.toLowerCase();
                  return (
                    <button
                      key={t}
                      type="button"
                      className={`chip ${on ? "acc" : ""}`}
                      style={{ cursor: "pointer" }}
                      onClick={() => set("tone", on ? "" : t)}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
              <input value={fields.tone} onChange={(e) => set("tone", e.target.value)} />
            </label>
            <label>
              Audience persona
              <input value={fields.persona} onChange={(e) => set("persona", e.target.value)} />
            </label>
            <label>
              Hook styles <span className="muted">(comma-separated)</span>
              <input value={fields.hookStyles} onChange={(e) => set("hookStyles", e.target.value)} />
            </label>
            <label>
              Forbidden topics <span className="muted">(comma-separated)</span>
              <input value={fields.forbidden} onChange={(e) => set("forbidden", e.target.value)} />
            </label>
            <label>
              Image style
              <input value={fields.imageStyle} onChange={(e) => set("imageStyle", e.target.value)} />
            </label>
            <label>
              CTA template
              <input value={fields.cta} onChange={(e) => set("cta", e.target.value)} />
            </label>
          </div>

          <div className="aibox" style={{ marginTop: 8 }}>
            <h4>
              <IconSparkle /> Channel avatar
            </h4>
            <p className="muted">
              Generate a 1:1 logo from the name + mission + image style, then download it and upload
              it by hand when you create the YouTube channel.
            </p>
            <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
              <button
                className="btn ghost"
                onClick={generateAvatar}
                disabled={pending || !fields.name.trim() || !fields.mission.trim()}
              >
                <IconSparkle /> {pending ? "Generating…" : avatarUrl ? "Regenerate avatar" : "Generate avatar"}
              </button>
              {avatarUrl && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "center" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={avatarUrl}
                    alt="Generated channel avatar"
                    width={140}
                    height={140}
                    style={{ borderRadius: 12, border: "1px solid var(--border)" }}
                  />
                  <a className="btn ghost sm" href={avatarUrl} download="channel-avatar">
                    Download
                  </a>
                </div>
              )}
            </div>
          </div>

          <div style={{ marginTop: "1rem", display: "flex", gap: 8 }}>
            {back(1)}
            <button onClick={create} disabled={pending || !fields.name.trim() || !fields.mission.trim()}>
              {pending ? "Creating…" : "Create channel"}
            </button>
          </div>
        </div>
      )}

      {step === 3 && channelId && (
        <div className="card">
          <h2>Channel created — provision YouTube by hand</h2>
          <p className="muted">
            The platform cannot create YouTube channels (no API for account/channel creation;
            title, @handle and avatar are manual). This checkpoint is by design.
          </p>
          <ol>
            <li>Create the Google account + YouTube channel.</li>
            <li>
              Apply the identity: <strong>{fields.name}</strong>{" "}
              <span className="mono">{fields.handle}</span>
            </li>
            <li>
              {avatarUrl ? (
                <>
                  Upload the avatar you generated (
                  <a href={avatarUrl} download="channel-avatar">
                    download again
                  </a>
                  ) and phone-verify the account.
                </>
              ) : (
                <>Create an avatar and phone-verify the account.</>
              )}
            </li>
            <li>
              Connect it on the channel page (Settings &amp; DNA → Connect YouTube) so publishing,
              thumbnails and scheduling run automatically.
            </li>
          </ol>
          <Link href={`/channels/${channelId}`}>
            <button>Open the channel</button>
          </Link>
        </div>
      )}

      <WizardAssistant step={STEPS[step] ?? STEPS[0]} fields={fields} onApplyPatch={applyPatch} />
    </div>
  );
}
