"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import type { CharterProposal, IdentityProposals } from "@ytauto/core";
import type { WizardPatch } from "@ytauto/agents";
import type { VoiceOption } from "@ytauto/providers";
import { IconSparkle, IconChevronLeft, IconCheck, IconRefresh, IconX } from "@/components/icons";
import { Dialog, Disclosure, Segmented, Stepper, Switch, Tile, TileGroup } from "@/components/ui";
import {
  createChannelWithCharterAction,
  generateChannelAvatarAction,
  generateChannelBannerAction,
  proposeCharterWizardAction,
  proposeIdentityWizardAction,
  scoutDomainsAction,
  validateDomainsAction,
  type WizardImageEngine,
} from "../editorial-actions";
import { WizardAssistant } from "./wizard-assistant";
import { ObjectivesPicker } from "./objectives-picker";

const STEPS = ["Blueprint", "Identity", "Review", "YouTube"] as const;

/** Quick-pick tone presets for Channel DNA (still free-editable below), with hover hints. */
const TONE_PRESETS: { t: string; hint: string }[] = [
  { t: "Authoritative", hint: "confident expert delivery — states facts plainly and owns them" },
  { t: "Cinematic", hint: "big filmic storytelling — builds atmosphere, scale and drama" },
  { t: "Playful", hint: "light and fun — jokes land but the facts still lead" },
  { t: "Contrarian", hint: "challenges the received story — 'everything you know about this is wrong'" },
  { t: "Warm", hint: "friendly and reassuring — a knowledgeable friend explaining" },
  { t: "Energetic", hint: "fast, punchy pacing that never sits still" },
  { t: "Deadpan", hint: "dry, flat delivery that lets absurd facts speak for themselves" },
  { t: "Investigative", hint: "digs, questions and reveals — treats every topic as a case to crack" },
  { t: "Conversational", hint: "casual and direct, like explaining to a mate over coffee" },
  { t: "Inspirational", hint: "uplifting framing — every story ends on possibility" },
];

/**
 * Objectives that duplicate structured settings (cadence, subscribers, watch
 * hours, retention, views) never reach the textarea — the Blueprint step owns
 * the publishing plan and the ObjectivesPicker owns qualitative strategy.
 */
const NUMERIC_OBJECTIVE_RE =
  /subscriber|watch.?hours|retention|views?\b|per week|\/wk|cadence|videos.+month/i;

/** Custom-identity sentinel for `picked` — the operator typed their own name. */
const CUSTOM_PICK = -1;

/** Slugify a channel name into a @handle (same shape the AI proposals use). */
const slugHandle = (name: string) =>
  `@${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}`;

/** Every editable field the wizard tracks — one object so the co-pilot can patch it. */
type Fields = {
  niche: string;
  intent: string;
  /** BACKLOG #6/#17: parent long-form channel id when this is a derived Shorts channel ("" = standalone) */
  derivedFrom: string;
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
  minFacts: number;
  /** BACKLOG #21.3 */
  factualityMode: "strict" | "balanced" | "entertainment";
  /** BACKLOG #21.1/#21.4: AI-proposed writing-persona archetype */
  personaArchetype:
    | "documentary_narrator"
    | "enthusiast_expert"
    | "contrarian_analyst"
    | "storyteller"
    | "playful_explainer";
  tone: string;
  /** TTS voice id from the provider library ("default" = provider fallback) */
  voiceId: string;
  persona: string;
  hookStyles: string;
  forbidden: string;
  imageStyle: string;
  /** #35.1 wizard-lite: YouTube video URLs (one per line) seeding the visual style */
  styleExamples: string;
  cta: string;
};

const DEFAULT_FIELDS: Fields = {
  niche: "",
  intent: "",
  derivedFrom: "",
  format: "short",
  // matches the default verification bar (1 source / 3 facts) — Deep is opt-in
  researchDepth: "standard",
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
  minSources: 1,
  presentDebate: true,
  minFacts: 3,
  factualityMode: "balanced",
  personaArchetype: "documentary_narrator",
  tone: "",
  voiceId: "default",
  persona: "",
  hookStyles: "",
  forbidden: "",
  imageStyle: "",
  styleExamples: "",
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
  avatarPrompt: string | null;
  bannerUrl: string | null;
  bannerPrompt: string | null;
  imageEngine?: WizardImageEngine;
};

/**
 * Channel-setup wizard (build #5): pre-filled channel defaults → co-create the
 * charter with the AI → pick/re-roll an identity → review/edit → generate an
 * avatar and create. A persistent co-pilot dock rides along the whole flow and
 * can edit any field. YouTube provisioning stays a manual checklist (no API).
 */
export function ChannelWizard({
  longFormChannels = [],
  voices = [],
  personaBlurbs = {},
  initialFields,
  nanoBananaReady = false,
}: {
  longFormChannels?: { id: string; name: string; niche: string }[];
  /** TTS voice library for the wizard's narration-voice picker */
  voices?: VoiceOption[];
  /** archetype key → blurb (from PERSONA_ARCHETYPE_LIBRARY, loaded server-side) */
  personaBlurbs?: Record<string, string>;
  /** BACKLOG #22: pre-fill from a market opportunity (?niche=&intent=) */
  initialFields?: Partial<Pick<Fields, "niche" | "intent">>;
  /** GEMINI_API_KEY present → the Nano Banana (Google-direct) art engine works */
  nanoBananaReady?: boolean;
} = {}) {
  const [step, setStep] = useState(0);
  const [maxStep, setMaxStep] = useState(0);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [fields, setFields] = useState<Fields>({ ...DEFAULT_FIELDS, ...initialFields });
  const set = <K extends keyof Fields>(key: K, value: Fields[K]) =>
    setFields((f) => ({ ...f, [key]: value }));
  const applyPatch = (patch: WizardPatch) =>
    setFields((f) => ({ ...f, ...(patch as Partial<Fields>) }));

  const [charter, setCharter] = useState<CharterProposal | null>(null);
  const [identity, setIdentity] = useState<IdentityProposals | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [regenInstructions, setRegenInstructions] = useState("");
  const [customName, setCustomName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarPrompt, setAvatarPrompt] = useState<string | null>(null);
  const [bannerUrl, setBannerUrl] = useState<string | null>(null);
  const [bannerPrompt, setBannerPrompt] = useState<string | null>(null);
  // Art-engine toggle for the avatar/banner: fal.ai (flux, the default) vs
  // Google-direct Nano Banana (needs GEMINI_API_KEY on /account).
  const [imageEngine, setImageEngine] = useState<WizardImageEngine>("fal");
  // Lightbox over the avatar/banner preview: view large + steer a regenerate.
  const [lightbox, setLightbox] = useState<"avatar" | "banner" | null>(null);
  const [lightboxPrompt, setLightboxPrompt] = useState("");
  // Sources helpers: per-domain reachability + AI-scouted additions.
  const [domainChecks, setDomainChecks] = useState<{ domain: string; ok: boolean }[] | null>(null);
  const [scoutHints, setScoutHints] = useState<{ domain: string; why: string }[]>([]);
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
        // an explicit opportunity hand-off (?niche=) outranks a stale draft
        if (d.fields) setFields((f) => ({ ...f, ...d.fields, ...initialFields }));
        if (typeof d.step === "number") setStep(d.step);
        if (typeof d.maxStep === "number") setMaxStep(d.maxStep);
        if (d.charter !== undefined) setCharter(d.charter);
        if (d.identity !== undefined) setIdentity(d.identity);
        if (d.picked !== undefined) setPicked(d.picked);
        if (d.avatarUrl !== undefined) setAvatarUrl(d.avatarUrl);
        if (d.avatarPrompt !== undefined) setAvatarPrompt(d.avatarPrompt);
        if (d.bannerUrl !== undefined) setBannerUrl(d.bannerUrl);
        if (d.bannerPrompt !== undefined) setBannerPrompt(d.bannerPrompt);
        if (d.imageEngine) setImageEngine(d.imageEngine);
        // custom identity path: rehydrate the card's input from the saved name
        if (d.picked === CUSTOM_PICK && d.fields?.name) setCustomName(d.fields.name);
        setDraftRestored(true);
      }
    } catch {
      /* corrupt/absent draft — start fresh */
    }
    hydrated.current = true;
  }, []);

  useEffect(() => {
    if (!hydrated.current || channelId) return; // don't persist after create
    const draft: PersistedDraft = {
      fields,
      step,
      maxStep,
      charter,
      identity,
      picked,
      avatarUrl,
      avatarPrompt,
      bannerUrl,
      bannerPrompt,
      imageEngine,
    };
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      /* storage full/unavailable — non-fatal */
    }
  }, [fields, step, maxStep, charter, identity, picked, avatarUrl, avatarPrompt, bannerUrl, bannerPrompt, imageEngine, channelId]);

  const startOver = () => {
    clearDraft();
    setFields(DEFAULT_FIELDS);
    setCharter(null);
    setIdentity(null);
    setPicked(null);
    setRegenInstructions("");
    setCustomName("");
    setAvatarUrl(null);
    setAvatarPrompt(null);
    setBannerUrl(null);
    setBannerPrompt(null);
    setImageEngine("fal");
    setLightbox(null);
    setDomainChecks(null);
    setScoutHints([]);
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

  // Deriving from a long-form channel forces the Shorts format + preset and
  // inherits the parent's niche (§6/#17).
  const setDerivedFrom = (parentId: string) =>
    setFields((f) => {
      if (!parentId) return { ...f, derivedFrom: "" };
      const parent = longFormChannels.find((c) => c.id === parentId);
      return { ...f, derivedFrom: parentId, format: "short", ...FORMAT_PRESET.short, niche: parent?.niche ?? f.niche };
    });

  // researchDepth is an operator dial on step 1; keep the derived verification
  // bar in sync until the AI draft refines it.
  const setResearchDepth = (depth: "standard" | "deep") =>
    setFields((f) => ({
      ...f,
      researchDepth: depth,
      // corroboration default lowered to 1 (BACKLOG #20 operator call): the ≥2
      // bar cut 58% of facts on the smoke-test channel. Deep rigor = 2.
      minSources: depth === "deep" ? 2 : 1,
      presentDebate: depth === "deep",
      minFacts: depth === "deep" ? 4 : 3,
      factualityMode: depth === "deep" ? "strict" : "balanced",
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
        // blueprint owns publishing: drop any AI objective that duplicates a
        // structured setting (cadence/subs/watch-hours/retention/views)
        objectives: proposal.objectives.filter((o) => !NUMERIC_OBJECTIVE_RE.test(o)).join("\n"),
        domains: proposal.sourceStrategy.authoritativeDomains.join(", "),
        minSources: proposal.verificationBar.establishedMinSources,
        presentDebate: proposal.verificationBar.presentDebateMode,
        minFacts: proposal.verificationBar.minFactsToScript,
        // #21.4: the AI reasons about what WORKS for this channel — mode + persona
        factualityMode: proposal.verificationBar.factualityMode ?? f.factualityMode,
        personaArchetype: proposal.personaArchetype ?? f.personaArchetype,
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

  /** "Use your own": custom name + derived handle, `picked` = CUSTOM_PICK. */
  const useCustomIdentity = () => {
    const name = customName.trim();
    if (!name) return;
    setPicked(CUSTOM_PICK);
    setFields((f) => ({ ...f, name, handle: slugHandle(name) }));
  };

  const buildAvatarPrompt = () =>
    [
      `Channel avatar / logo for a YouTube channel named "${fields.name}".`,
      fields.mission ? `Mission: ${fields.mission}.` : "",
      fields.imageStyle ? `Visual style: ${fields.imageStyle}.` : "",
      "Clean, iconic, centered, works as a small circular profile picture.",
    ]
      .filter(Boolean)
      .join(" ");

  const buildBannerPrompt = () =>
    [
      `Wide channel banner art for a YouTube channel named "${fields.name}".`,
      fields.mission ? `Mission: ${fields.mission}.` : "",
      fields.imageStyle ? `Visual style: ${fields.imageStyle}.` : "",
      "Cinematic 16:9 composition with the key subject centered in the middle third (YouTube crops the edges on TV/desktop), rich atmospheric background, room for the channel name to sit over it later.",
    ]
      .filter(Boolean)
      .join(" ");

  const generateAvatar = () =>
    run(async () => {
      const prompt = buildAvatarPrompt();
      const res = await generateChannelAvatarAction({ prompt, engine: imageEngine });
      if ("error" in res) throw new Error(res.error);
      setAvatarUrl(res.url);
      setAvatarPrompt(prompt);
    });

  const generateBanner = () =>
    run(async () => {
      const prompt = buildBannerPrompt();
      const res = await generateChannelBannerAction({ prompt, engine: imageEngine });
      if ("error" in res) throw new Error(res.error);
      setBannerUrl(res.url);
      setBannerPrompt(prompt);
    });

  /** Open the lightbox pre-filled with the LAST prompt used for that image. */
  const openLightbox = (kind: "avatar" | "banner") => {
    setLightbox(kind);
    setLightboxPrompt(kind === "avatar" ? (avatarPrompt ?? buildAvatarPrompt()) : (bannerPrompt ?? buildBannerPrompt()));
  };

  const regenerateFromLightbox = () => {
    const kind = lightbox;
    if (!kind) return;
    run(async () => {
      const res =
        kind === "avatar"
          ? await generateChannelAvatarAction({ prompt: lightboxPrompt, engine: imageEngine })
          : await generateChannelBannerAction({ prompt: lightboxPrompt, engine: imageEngine });
      if ("error" in res) throw new Error(res.error);
      if (kind === "avatar") {
        setAvatarUrl(res.url);
        setAvatarPrompt(lightboxPrompt);
      } else {
        setBannerUrl(res.url);
        setBannerPrompt(lightboxPrompt);
      }
    });
  };

  const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

  /** Sources helper: probe every listed domain over https, chip the results. */
  const checkDomains = () =>
    run(async () => {
      setDomainChecks(await validateDomainsAction(list(fields.domains)));
    });

  /** Sources helper: AI-scout fresh authoritative domains and append them. */
  const scoutDomains = () =>
    run(async () => {
      const existing = list(fields.domains);
      const res = await scoutDomainsAction({ niche: fields.niche, existing });
      if ("error" in res) throw new Error(res.error);
      const fresh = res.domains.filter((d) => !existing.includes(d.domain));
      if (fresh.length) set("domains", [...existing, ...fresh.map((d) => d.domain)].join(", "));
      setScoutHints(fresh);
    });

  const create = () =>
    run(async () => {
      const res = await createChannelWithCharterAction({
        name: fields.name,
        handle: fields.handle,
        niche: fields.niche,
        contentFormat: fields.format,
        autonomyTier: fields.autonomyTier,
        derivedFromChannelId: fields.derivedFrom || null,
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
            minFactsToScript: fields.minFacts,
            factualityMode: fields.factualityMode as "strict" | "balanced" | "entertainment",
          },
          checkinCadence: "weekly",
          personaArchetype: fields.personaArchetype,
          personaRationale: charter?.personaRationale ?? null,
        },
        dna: {
          tone: fields.tone,
          audiencePersona: fields.persona,
          hookStyles: list(fields.hookStyles),
          forbiddenTopics: list(fields.forbidden),
          imageStyle: fields.imageStyle,
          primaryColor: "#38bdf8",
          font: "Inter",
          voiceId: fields.voiceId || "default",
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
          ? // CUSTOM_PICK means the operator typed their own name — no AI option applies
            { options: identity.options, pickedIndex: picked != null && picked >= 0 ? picked : null }
          : { options: [], pickedIndex: null },
        // #35.1 wizard-lite: example video URLs → style refs + auto-distilled v1
        styleExampleUrls: fields.styleExamples
          .split("\n")
          .map((u) => u.trim())
          .filter(Boolean)
          .slice(0, 6),
        bannerKey: bannerUrl ? bannerUrl.replace(/^\/api\/media\//, "") : null,
        // persist the generated logo (bytes already in the store); the avatar
        // action returns "/api/media/<key>" — store just the <key>.
        avatarKey: avatarUrl ? avatarUrl.replace(/^\/api\/media\//, "") : null,
      });
      setChannelId(res.channelId);
      clearDraft();
      setDraftRestored(false);
      advance(3);
    });
  // ── #20 polish: derived "Your steer" markers — an edited value differs from
  // the AI's proposal; the chip flips and the change is recorded on create.
  const verSteered =
    !!charter &&
    (fields.minSources !== charter.verificationBar.establishedMinSources ||
      fields.minFacts !== (charter.verificationBar.minFactsToScript ?? 3) ||
      fields.presentDebate !== charter.verificationBar.presentDebateMode ||
      (charter.verificationBar.factualityMode != null &&
        fields.factualityMode !== charter.verificationBar.factualityMode));
  const missionSteered = !!charter && fields.mission.trim() !== charter.mission.trim();

  // Release-plan ramp preview (mirrors the warm-up scheduler's shape): weekly
  // output ramps to steady over the warm-up weeks.
  const steadyWeekly = Math.max(1, Math.round(fields.monthlySteady / 4.3));
  const rampBars = (() => {
    const wu = fields.warmupWeeks;
    const perWk = wu > 0 ? Math.max(1, Math.round(fields.warmupVideos / wu)) : steadyWeekly;
    const bars: { v: number; steady: boolean }[] = [];
    for (let w = 1; w <= 4; w++) {
      const inWarmup = w <= wu;
      bars.push({
        v: inWarmup ? Math.max(1, Math.round(perWk * (0.6 + (0.4 * w) / Math.max(1, wu)))) : steadyWeekly,
        steady: !inWarmup,
      });
    }
    bars.push({ v: steadyWeekly, steady: true });
    return bars;
  })();
  const rampMax = Math.max(...rampBars.map((b) => b.v), 1);
  const firstMonthEstimate =
    fields.warmupVideos + Math.max(0, 4 - fields.warmupWeeks) * steadyWeekly;

  const presetLabel = fields.derivedFrom
    ? "Linked-Shorts preset applied"
    : fields.format === "long"
      ? "Long-form preset applied"
      : fields.format === "both"
        ? "Hybrid preset applied"
        : "Shorts preset applied";

  const AUTONOMY_TILES = [
    { value: 0, title: "T0 Manual", sub: "approve every stage" },
    { value: 1, title: "T1 Assisted", sub: "you approve script + final cut" },
    { value: 2, title: "T2 Supervised", sub: "no per-video gates; you release" },
    { value: 3, title: "T3 Exceptions", sub: "you only see holds + briefings" },
  ];

  const copyIdentity = () => {
    try {
      void navigator.clipboard.writeText(`${fields.name} ${fields.handle}`);
    } catch {
      /* clipboard unavailable */
    }
  };

  const doneN = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );

  return (
    <div>
      <div className="wprog">
        {STEPS.map((label, i) => (
          <span key={label} style={{ display: "inline-flex", alignItems: "center" }}>
            {i > 0 && <span className="wsep" />}
            <button
              type="button"
              className={`wstep${i === step ? " on" : i < step ? " done" : ""}`}
              disabled={i > maxStep}
              onClick={() => goto(i)}
            >
              <span className="n">{i < step ? doneN : i + 1}</span>
              {label}
            </button>
          </span>
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

      {/* ── Step 1 · Blueprint ──────────────────────────────────────────── */}
      {step === 0 && (
        <div>
          <div className="panel">
            <div className="panel-body">
              <label className="field-label" htmlFor="wz-niche">
                Niche
              </label>
              <input id="wz-niche" value={fields.niche} onChange={(e) => set("niche", e.target.value)} required />
              <p className="muted" style={{ fontSize: 12, margin: "5px 0 0" }}>
                Narrow beats broad — &ldquo;aviation history&rdquo;, not &ldquo;history&rdquo;.
              </p>
              <div style={{ height: 14 }} />
              <label className="field-label" htmlFor="wz-intent">
                What should this channel be?
              </label>
              <input
                id="wz-intent"
                value={fields.intent}
                onChange={(e) => set("intent", e.target.value)}
                placeholder="deeply researched evergreen stories, one machine per episode"
              />
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h3>Format</h3>
              <span className="chip acc">{presetLabel}</span>
            </div>
            <div className="panel-body">
              <TileGroup>
                <Tile
                  selected={fields.format === "short" && !fields.derivedFrom}
                  onSelect={() => {
                    set("derivedFrom", "");
                    setFormat("short");
                  }}
                  art={
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <rect x="8" y="3" width="8" height="18" rx="2" />
                    </svg>
                  }
                  title="Shorts"
                  subtitle="~45s vertical · discovery engine · 10–15/wk at full pace"
                />
                <Tile
                  selected={fields.format === "long"}
                  onSelect={() => {
                    set("derivedFrom", "");
                    setFormat("long");
                  }}
                  art={
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <rect x="3" y="6" width="18" height="12" rx="2" />
                    </svg>
                  }
                  title="Long-form"
                  subtitle="8–15 min · depth & revenue · 2–3/wk at full pace"
                />
                <Tile
                  selected={fields.format === "both"}
                  onSelect={() => {
                    set("derivedFrom", "");
                    setFormat("both");
                  }}
                  art={
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <rect x="3" y="7" width="11" height="10" rx="2" />
                      <rect x="17" y="5" width="4" height="14" rx="1.5" />
                    </svg>
                  }
                  title="Both"
                  subtitle="Long-form masters + native Shorts on one channel"
                />
                {longFormChannels.map((c) => (
                  <Tile
                    key={c.id}
                    wide
                    selected={fields.derivedFrom === c.id}
                    onSelect={() => setDerivedFrom(c.id)}
                    art={
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                        <rect x="3" y="7" width="11" height="10" rx="2" />
                        <rect x="16" y="5" width="5" height="14" rx="1.5" />
                      </svg>
                    }
                    title={`Shorts of ${c.name}`}
                    subtitle="Linked companion — auto-cut from the parent's masters"
                  />
                ))}
              </TileGroup>
              <p className="muted" style={{ fontSize: 12, margin: "10px 0 0" }}>
                Picking a format pre-fills length + the release plan below — every number stays editable.
              </p>
            </div>
          </div>

          <div className="grid-2 grid">
            <div className="panel" style={{ marginBottom: 0 }}>
              <div className="panel-head">
                <h3>Research rigor</h3>
              </div>
              <div className="panel-body">
                <TileGroup>
                  <Tile
                    selected={fields.researchDepth === "standard"}
                    onSelect={() => setResearchDepth("standard")}
                    art={
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    }
                    title="Standard"
                    subtitle="Every established fact needs ≥1 independent source, or it's cut"
                  />
                  <Tile
                    selected={fields.researchDepth === "deep"}
                    onSelect={() => setResearchDepth("deep")}
                    art={
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                        <path d="M9 11l3 3 8-8" />
                        <path d="M4 12l3 3 3-3" />
                      </svg>
                    }
                    title="Deep"
                    subtitle="≥2 independent sources + present-the-debate on contested claims"
                  />
                </TileGroup>
              </div>
            </div>
            <div className="panel" style={{ marginBottom: 0 }}>
              <div className="panel-head">
                <h3>Autonomy</h3>
              </div>
              <div className="panel-body">
                <TileGroup>
                  {AUTONOMY_TILES.map((t) => (
                    <Tile
                      key={t.value}
                      selected={fields.autonomyTier === t.value}
                      onSelect={() => set("autonomyTier", t.value)}
                      title={t.title}
                      subtitle={t.sub}
                    />
                  ))}
                </TileGroup>
                <Switch
                  checked={fields.monetisationSafe}
                  onChange={(v) => set("monetisationSafe", v)}
                  label="Monetisation-safe"
                  hint="keeps every charter decision advertiser-friendly"
                />
              </div>
            </div>
          </div>
          <div style={{ height: 14 }} />

          <div className="panel">
            <div className="panel-head">
              <h3>Release plan</h3>
              <span className="chip">
                first month ≈ <span className="num">{firstMonthEstimate}</span> videos
              </span>
            </div>
            <div className="panel-body">
              <div className="ramp">
                {rampBars.map((b, i) => (
                  <div
                    key={i}
                    className={`bar${b.steady ? " steady" : ""}`}
                    style={{ height: `${Math.max(12, Math.round((b.v / rampMax) * 100))}%` }}
                  >
                    <b>{b.v}</b>
                  </div>
                ))}
              </div>
              <div className="ramplabs">
                <div>wk 1</div>
                <div>wk 2</div>
                <div>wk 3</div>
                <div>wk 4</div>
                <div>steady</div>
              </div>
              <div className="grid-2 grid" style={{ marginTop: 12 }}>
                <div>
                  <Stepper
                    label="Warm-up"
                    hint="ramping weeks before full pace"
                    value={fields.warmupWeeks}
                    onChange={(v) => set("warmupWeeks", v)}
                    min={0}
                    max={12}
                    format={(v) => `${v} wk`}
                  />
                  <Stepper
                    label="Videos during warm-up"
                    hint="front-loads the backlog"
                    value={fields.warmupVideos}
                    onChange={(v) => set("warmupVideos", v)}
                    min={0}
                    max={200}
                  />
                </div>
                <div>
                  <Stepper
                    label="Steady output"
                    hint="per month, after warm-up"
                    value={fields.monthlySteady}
                    onChange={(v) => set("monthlySteady", v)}
                    min={1}
                    max={300}
                  />
                  <Stepper
                    label="Video length"
                    hint="target narration"
                    value={fields.targetLengthSec}
                    onChange={(v) => set("targetLengthSec", v)}
                    min={10}
                    max={1800}
                    step={fields.targetLengthSec >= 120 ? 30 : 5}
                    format={(v) => `${v}s`}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="ctabar">
            <span className="muted" style={{ fontSize: 12.5 }}>
              Draft autosaves — safe to leave and come back
            </span>
            <button className="btn" onClick={draftCharter} disabled={pending || !fields.niche.trim()}>
              {pending ? "Drafting charter…" : "Draft charter with AI →"}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 2 · Identity ───────────────────────────────────────────── */}
      {step === 1 && identity && (
        <div>
          <div className="idcards">
            {identity.options.map((opt, i) => (
              <button
                key={opt.handle}
                type="button"
                className={`idcard${picked === i ? " on" : ""}`}
                onClick={() => pickIdentity(i)}
              >
                <span className="ck">
                  <IconCheck />
                </span>
                <span className="avmark">
                  {opt.name
                    .split(/\s+/)
                    .map((w) => w[0])
                    .join("")
                    .slice(0, 2)
                    .toUpperCase()}
                </span>
                <span className="nm">{opt.name}</span>
                <div className="hd">{opt.handle}</div>
                <Disclosure summary="concept">
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    {opt.avatarConcept}
                  </span>
                </Disclosure>
              </button>
            ))}
            {/* Use-your-own: custom name + auto-derived @handle */}
            <div className={`idcard${picked === CUSTOM_PICK ? " on" : ""}`} style={{ cursor: "default" }}>
              <span className="ck">
                <IconCheck />
              </span>
              <span className="nm">Use your own</span>
              <p className="muted" style={{ fontSize: 12.5, margin: "6px 0 10px" }}>
                Already have a name? Type it — the @handle derives automatically.
              </p>
              <input
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="Channel name"
                aria-label="Custom channel name"
                style={{ width: "100%" }}
              />
              <div className="hd" style={{ margin: "6px 0 10px" }}>
                {customName.trim() ? slugHandle(customName) : "@your-handle"}
              </div>
              <button type="button" className="btn sm" disabled={!customName.trim()} onClick={useCustomIdentity}>
                Use this
              </button>
            </div>
          </div>

          <div className="panel" style={{ marginTop: 14 }}>
            <div className="panel-body" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <input
                value={regenInstructions}
                onChange={(e) => setRegenInstructions(e.target.value)}
                placeholder="Steer the re-roll — e.g. “punchier”, “avoid puns”"
                style={{ flex: 1, minWidth: 220 }}
              />
              <button className="btn ghost" onClick={regenerateIdentities} disabled={pending}>
                <IconRefresh /> {pending ? "Generating…" : "3 more"}
              </button>
            </div>
          </div>

          <div className="ctabar">
            <button className="btn ghost" onClick={() => setStep(0)}>
              <IconChevronLeft /> Back
            </button>
            <button className="btn" onClick={() => advance(2)} disabled={picked === null}>
              {picked === null
                ? "Pick an identity to continue"
                : `Continue with “${picked >= 0 ? identity.options[picked]!.name : fields.name}” →`}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3 · Review — the charter, as cards ─────────────────────── */}
      {step === 2 && (
        <div>
          <div className="grid-2 grid">
            <div className="panel" style={{ marginBottom: 0 }}>
              <div className="panel-head">
                <h3>Identity</h3>
                <span className="chip">AI default</span>
              </div>
              <div className="panel-body">
                <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                  <span className="avmark" style={{ width: 52, height: 52, fontSize: 18 }}>
                    {avatarUrl ? (
                      <button
                        type="button"
                        onClick={() => openLightbox("avatar")}
                        aria-label="Expand avatar and steer a regenerate"
                        style={{ padding: 0, border: "none", background: "none", cursor: "zoom-in", display: "block", width: "100%", height: "100%" }}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={avatarUrl} alt="Channel avatar" />
                      </button>
                    ) : (
                      fields.name
                        .split(/\s+/)
                        .map((w) => w[0])
                        .join("")
                        .slice(0, 2)
                        .toUpperCase() || "?"
                    )}
                  </span>
                  <div style={{ flex: 1, display: "grid", gap: 6 }}>
                    <input
                      value={fields.name}
                      onChange={(e) => set("name", e.target.value)}
                      aria-label="Channel name"
                      style={{ fontWeight: 700, fontSize: 15 }}
                      required
                    />
                    <input
                      value={fields.handle}
                      onChange={(e) => set("handle", e.target.value)}
                      aria-label="Handle"
                      className="mono"
                      style={{ fontSize: 12.5 }}
                    />
                  </div>
                </div>
                <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <span className="field-label" style={{ margin: 0 }}>
                    Art engine
                  </span>
                  <Segmented
                    value={imageEngine}
                    onChange={setImageEngine}
                    options={[
                      { value: "fal", label: "fal.ai · Flux" },
                      { value: "nano-banana", label: "Nano Banana · Google" },
                    ]}
                  />
                </div>
                {imageEngine === "nano-banana" && !nanoBananaReady && (
                  <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>
                    Nano Banana calls Google directly and needs a Gemini API key — add it on{" "}
                    <Link href="/account" style={{ color: "var(--accent-ink)", fontWeight: 600 }}>
                      /account
                    </Link>{" "}
                    first.
                  </p>
                )}
                <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <button
                    className="btn ghost sm"
                    onClick={generateAvatar}
                    disabled={pending || !fields.name.trim() || !fields.mission.trim()}
                  >
                    <IconSparkle /> {pending ? "Generating…" : avatarUrl ? "Regenerate avatar" : "Generate avatar"}
                  </button>
                  <button
                    className="btn ghost sm"
                    onClick={generateBanner}
                    disabled={pending || !fields.name.trim() || !fields.mission.trim()}
                  >
                    <IconSparkle /> {pending ? "Generating…" : bannerUrl ? "Regenerate banner" : "Generate banner"}
                  </button>
                  {avatarUrl && (
                    <a className="btn ghost sm" href={avatarUrl} download="channel-avatar">
                      Download
                    </a>
                  )}
                </div>
                {avatarUrl && (
                  <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
                    Click the avatar to view it large and steer a regenerate.
                  </p>
                )}
                {bannerUrl && (
                  <div style={{ marginTop: 12 }}>
                    <button
                      type="button"
                      onClick={() => openLightbox("banner")}
                      aria-label="Expand banner and steer a regenerate"
                      style={{ padding: 0, border: "none", background: "none", cursor: "zoom-in", display: "block", width: "100%" }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={bannerUrl}
                        alt="Channel banner"
                        style={{ width: "100%", borderRadius: 10, display: "block", border: "1px solid var(--border)" }}
                      />
                    </button>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
                      <a className="btn ghost sm" href={bannerUrl} download="channel-banner">
                        Download banner
                      </a>
                      <span className="muted" style={{ fontSize: 12 }}>
                        Upload at 2560×1440 — keep the key art inside the 1546×423 safe-area.
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="panel" style={{ marginBottom: 0 }}>
              <div className="panel-head">
                <h3>Verification</h3>
                <span className={`chip${verSteered ? " warn" : ""}`}>{verSteered ? "Your steer" : "AI default"}</span>
              </div>
              <div className="panel-body">
                <div style={{ marginBottom: 12 }}>
                  <div className="field-label">Factual rigor</div>
                  <div className="field-hint" style={{ marginBottom: 6 }}>
                    {fields.factualityMode === "strict"
                      ? "cut anything that can't be corroborated (science / finance / news)"
                      : fields.factualityMode === "entertainment"
                        ? "fun-first — facts inspire, nothing is cut for lack of corroboration"
                        : "unknowns survive as framed conjecture — “no one knows” is a hook (history / mystery)"}
                    {charter?.factualityRationale ? ` · AI: ${charter.factualityRationale}` : ""}
                  </div>
                  <div className="seg">
                    {(["strict", "balanced", "entertainment"] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={fields.factualityMode === m ? "on" : ""}
                        onClick={() => set("factualityMode", m)}
                      >
                        {m === "strict" ? "Strict" : m === "balanced" ? "Balanced" : "Entertainment"}
                      </button>
                    ))}
                  </div>
                </div>
                <Stepper
                  label="Corroboration bar"
                  hint="independent sources before a fact is asserted"
                  value={fields.minSources}
                  onChange={(v) => set("minSources", v)}
                  min={1}
                  max={5}
                />
                <Stepper
                  label="Facts before scripting"
                  hint="episodes below this are cut, not scripted"
                  value={fields.minFacts}
                  onChange={(v) => set("minFacts", v)}
                  min={1}
                  max={20}
                />
                <Switch
                  checked={fields.presentDebate}
                  onChange={(v) => set("presentDebate", v)}
                  label="Present-the-debate"
                  hint="contested claims are attributed, never asserted"
                />
              </div>
            </div>
          </div>
          <div style={{ height: 14 }} />

          <div className="panel">
            <div className="panel-head">
              <h3>Mission &amp; objectives</h3>
              <span className={`chip${missionSteered ? " warn" : ""}`}>
                {missionSteered ? "Your steer" : "AI default"}
              </span>
            </div>
            <div className="panel-body">
              <textarea
                value={fields.mission}
                onChange={(e) => set("mission", e.target.value)}
                rows={2}
                aria-label="Mission"
              />
              <div style={{ marginTop: 12 }}>
                {/* Blueprint owns publishing — objectives stay qualitative */}
                <p className="muted" style={{ fontSize: 12.5, margin: "0 0 10px" }}>
                  Publishing plan: <span className="num">{fields.warmupVideos}</span> videos in{" "}
                  <span className="num">{fields.warmupWeeks}</span>-week warm-up →{" "}
                  <span className="num">{fields.firstMonthTarget}</span> in month one →{" "}
                  <span className="num">{fields.monthlySteady}</span>/mo steady — set in Blueprint.
                </p>
                <ObjectivesPicker value={fields.objectives} onChange={(v) => set("objectives", v)} />
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h3>Voice &amp; style</h3>
              <span className="chip">AI default</span>
            </div>
            <div className="panel-body">
              <div style={{ marginBottom: 12 }}>
                <span className="field-label">Writing persona</span>
                <div className="field-hint" style={{ margin: "2px 0 6px" }}>
                  who the narrator IS — every episode is written in this one voice (tweakable later on
                  the channel&apos;s Persona tab){charter?.personaRationale ? ` · AI: ${charter.personaRationale}` : ""}
                </div>
                <div className="tagrow">
                  {(
                    [
                      ["documentary_narrator", "Documentary Narrator"],
                      ["enthusiast_expert", "Enthusiast Expert"],
                      ["contrarian_analyst", "Contrarian Analyst"],
                      ["storyteller", "Storyteller"],
                      ["playful_explainer", "Playful Explainer"],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      className={`objchip${fields.personaArchetype === key ? " on" : ""}`}
                      title={personaBlurbs[key]}
                      onClick={() => set("personaArchetype", key)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {voices.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <label className="field-label" htmlFor="wz-voice">
                    Narration voice
                  </label>
                  <div className="field-hint" style={{ margin: "2px 0 6px" }}>
                    the TTS voice every episode is narrated in (changeable later on the Persona tab)
                  </div>
                  <select id="wz-voice" value={fields.voiceId} onChange={(e) => set("voiceId", e.target.value)}>
                    <option value="default">Default — provider fallback voice</option>
                    {voices.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                        {v.labels?.gender ? ` · ${v.labels.gender}` : ""}
                        {v.labels?.use_case ? ` · ${v.labels.use_case}` : ""}
                      </option>
                    ))}
                  </select>
                  {voices.find((v) => v.id === fields.voiceId)?.description && (
                    <span className="muted" style={{ fontSize: 12, display: "block", marginTop: 4 }}>
                      {voices.find((v) => v.id === fields.voiceId)!.description}
                    </span>
                  )}
                </div>
              )}
              <div className="grid-2 grid">
                <div>
                  <span className="field-label">Tone</span>
                  <div className="tagrow" style={{ margin: "6px 0 8px" }}>
                    {TONE_PRESETS.map(({ t, hint }) => {
                      const on = fields.tone.trim().toLowerCase() === t.toLowerCase();
                      return (
                        <button
                          key={t}
                          type="button"
                          className={`objchip${on ? " on" : ""}`}
                          title={hint}
                          onClick={() => set("tone", on ? "" : t)}
                        >
                          {t}
                        </button>
                      );
                    })}
                  </div>
                  <input value={fields.tone} onChange={(e) => set("tone", e.target.value)} aria-label="Tone" />
                </div>
                <div>
                  <span
                    className="field-label"
                    title="openers the scriptwriter favors — e.g. curiosity_gap teases an unanswered question"
                  >
                    Hook styles
                  </span>
                  <div className="tagrow" style={{ margin: "6px 0 8px" }}>
                    {list(fields.hookStyles).map((h) => (
                      <span key={h} className="tagx">
                        {h}
                        <button
                          type="button"
                          aria-label={`Remove ${h}`}
                          onClick={() =>
                            set("hookStyles", list(fields.hookStyles).filter((x) => x !== h).join(", "))
                          }
                        >
                          <IconX />
                        </button>
                      </span>
                    ))}
                  </div>
                  <input
                    value={fields.hookStyles}
                    onChange={(e) => set("hookStyles", e.target.value)}
                    aria-label="Hook styles (comma-separated)"
                    placeholder="curiosity_gap, stakes_first"
                  />
                </div>
              </div>
              <Disclosure summary="More — audience, forbidden topics, image style, CTA, source domains" className="mt8">
                <div className="grid-2 grid">
                  <label>
                    Audience persona
                    <textarea
                      rows={2}
                      value={fields.persona}
                      onChange={(e) => set("persona", e.target.value)}
                      style={{ width: "100%", resize: "vertical" }}
                    />
                  </label>
                  <label>
                    Forbidden topics <span className="muted">(comma-separated)</span>
                    <textarea
                      rows={2}
                      value={fields.forbidden}
                      onChange={(e) => set("forbidden", e.target.value)}
                      style={{ width: "100%", resize: "vertical" }}
                    />
                  </label>
                  <label>
                    Image style
                    <textarea
                      rows={2}
                      value={fields.imageStyle}
                      onChange={(e) => set("imageStyle", e.target.value)}
                      style={{ width: "100%", resize: "vertical" }}
                    />
                  </label>
                  <label>
                    Style examples <span className="muted">(optional — YouTube video URLs, one per line; their thumbnails seed this channel&apos;s look)</span>
                    <textarea
                      rows={3}
                      value={fields.styleExamples}
                      onChange={(e) => set("styleExamples", e.target.value)}
                      placeholder={"https://youtube.com/watch?v=…\nhttps://youtu.be/…"}
                      style={{ width: "100%", resize: "vertical" }}
                    />
                  </label>
                  <label>
                    CTA template
                    <textarea
                      rows={2}
                      value={fields.cta}
                      onChange={(e) => set("cta", e.target.value)}
                      style={{ width: "100%", resize: "vertical" }}
                    />
                  </label>
                  <label>
                    Authoritative domains <span className="muted">(comma-separated)</span>
                    <textarea
                      rows={2}
                      value={fields.domains}
                      onChange={(e) => set("domains", e.target.value)}
                      style={{ width: "100%", resize: "vertical" }}
                    />
                  </label>
                </div>
                <div style={{ marginTop: 10 }}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={checkDomains}
                      disabled={pending || list(fields.domains).length === 0}
                    >
                      {pending ? "Working…" : "Check reachability"}
                    </button>
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={scoutDomains}
                      disabled={pending || !fields.niche.trim()}
                    >
                      <IconSparkle /> {pending ? "Working…" : "Scout more domains"}
                    </button>
                    {domainChecks?.map((c) => (
                      <span key={c.domain} className={`chip ${c.ok ? "good" : "crit"}`}>
                        {c.ok ? <IconCheck /> : <IconX />} {c.domain}
                      </span>
                    ))}
                  </div>
                  {scoutHints.length > 0 && (
                    <ul className="muted" style={{ fontSize: 12, margin: "8px 0 0", paddingLeft: 18 }}>
                      {scoutHints.map((h) => (
                        <li key={h.domain}>
                          <span className="mono">{h.domain}</span> — {h.why}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Disclosure>
            </div>
          </div>

          <div className="ctabar">
            <button className="btn ghost" onClick={() => setStep(1)}>
              <IconChevronLeft /> Back
            </button>
            <button className="btn" onClick={create} disabled={pending || !fields.name.trim() || !fields.mission.trim()}>
              {pending ? "Creating…" : "Create channel"}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 4 · YouTube checklist ──────────────────────────────────── */}
      {step === 3 && channelId && (
        <div>
          <div className="panel">
            <div className="panel-head">
              <h3>{fields.name} is live in the platform</h3>
              <span className="chip good">
                <span className="d" />
                Planning &amp; researching
              </span>
            </div>
            <div className="panel-body">
              <p className="muted" style={{ margin: "0 0 6px", fontSize: 12.5 }}>
                YouTube can&apos;t be provisioned by API (account, title, @handle and avatar are manual — by
                design, this is your checkpoint). Tick these off, then connect:
              </p>
              {[
                {
                  t: "Create the Google account",
                  s: "pod model — unique recovery phone + email (see the accounts research)",
                },
                {
                  t: "Create the Brand-Account channel & apply the identity",
                  s: (
                    <>
                      {fields.name} · <span className="mono">{fields.handle}</span>{" "}
                      <button className="btn ghost sm" style={{ padding: "1px 9px", fontSize: 11 }} onClick={copyIdentity}>
                        copy
                      </button>
                    </>
                  ),
                },
                {
                  t: "Upload the avatar & phone-verify the account",
                  s: avatarUrl ? (
                    <>
                      <a href={avatarUrl} download="channel-avatar">
                        download the avatar again
                      </a>{" "}
                      — verification unlocks custom thumbnails
                    </>
                  ) : (
                    "generate one back at Review, or brief a designer with the concept"
                  ),
                },
                {
                  t: "Connect YouTube",
                  s: "Settings & DNA → Connect — per-channel OAuth, needed before the first publish",
                },
              ].map((row, i) => (
                <div className="checkrow" key={i}>
                  <input type="checkbox" id={`prov-${i}`} />
                  <label htmlFor={`prov-${i}`} className="t" style={{ cursor: "pointer" }}>
                    {row.t}
                    <small>{row.s}</small>
                  </label>
                </div>
              ))}
            </div>
          </div>

          <div className="ctabar">
            <span className="muted" style={{ fontSize: 12.5 }}>
              The engine plans + researches while you provision
            </span>
            <Link href={`/channels/${channelId}`} className="btn">
              Open the channel → Plan
            </Link>
          </div>
        </div>
      )}

      {/* Avatar/banner lightbox: view large + edit the prompt + regenerate */}
      {lightbox && (
        <Dialog
          open
          onClose={() => setLightbox(null)}
          title={lightbox === "avatar" ? "Channel avatar" : "Channel banner"}
          footer={
            <button className="btn" onClick={regenerateFromLightbox} disabled={pending || !lightboxPrompt.trim()}>
              <IconRefresh /> {pending ? "Regenerating…" : "Regenerate with this direction"}
            </button>
          }
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={(lightbox === "avatar" ? avatarUrl : bannerUrl) ?? ""}
            alt={lightbox === "avatar" ? "Channel avatar" : "Channel banner"}
            style={{
              display: "block",
              width: lightbox === "avatar" ? "min(320px, 100%)" : "100%",
              margin: lightbox === "avatar" ? "0 auto 12px" : "0 0 12px",
              borderRadius: 10,
              border: "1px solid var(--border)",
            }}
          />
          <label style={{ marginBottom: 0 }}>
            Direction <span className="muted">— edit the prompt, then regenerate</span>
            <textarea
              rows={3}
              value={lightboxPrompt}
              onChange={(e) => setLightboxPrompt(e.target.value)}
              style={{ width: "100%", resize: "vertical" }}
            />
          </label>
        </Dialog>
      )}

      <WizardAssistant step={STEPS[step] ?? STEPS[0]} fields={fields} onApplyPatch={applyPatch} />
    </div>
  );
}
