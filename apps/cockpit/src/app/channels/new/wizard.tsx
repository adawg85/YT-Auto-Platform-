"use client";

import { useState, useTransition } from "react";
import type { CharterProposal, IdentityProposals } from "@ytauto/core";
import { IconSparkle } from "@/components/icons";
import {
  Badge,
  Button,
  ButtonLink,
  Field,
  Input,
  Select,
  Textarea,
} from "@/components/ui";
import {
  createChannelWithCharterAction,
  proposeCharterWizardAction,
  proposeIdentityWizardAction,
} from "../editorial-actions";

const TIERS = [
  { value: 0, label: "T0 — Manual: every gate requires approval" },
  { value: 1, label: "T1 — Assisted: script + final review gated" },
  { value: 2, label: "T2 — Supervised: auto-publishes private; you click Release" },
  { value: 3, label: "T3 — Exception-only: fully automated unless flagged" },
];

const STEPS = ["Niche & intent", "Identity", "Review charter", "Provision"] as const;

/**
 * Channel-setup wizard (build #5): co-create the charter with the AI, pick an
 * identity, review/edit everything, create — then the manual YouTube
 * provisioning checklist (the platform cannot create YouTube channels).
 */
export function ChannelWizard() {
  const [step, setStep] = useState(0);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // step 1 inputs
  const [niche, setNiche] = useState("");
  const [intent, setIntent] = useState("");
  // AI proposals
  const [charter, setCharter] = useState<CharterProposal | null>(null);
  const [identity, setIdentity] = useState<IdentityProposals | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  // step 3 editable state
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [mission, setMission] = useState("");
  const [objectives, setObjectives] = useState("");
  const [domains, setDomains] = useState("");
  const [minSources, setMinSources] = useState(2);
  const [presentDebate, setPresentDebate] = useState(true);
  const [tier, setTier] = useState(1);
  const [tone, setTone] = useState("");
  const [persona, setPersona] = useState("");
  const [hookStyles, setHookStyles] = useState("");
  const [forbidden, setForbidden] = useState("");
  const [imageStyle, setImageStyle] = useState("");
  const [cta, setCta] = useState("");
  // result
  const [channelId, setChannelId] = useState<string | null>(null);

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

  const draftCharter = () =>
    run(async () => {
      const proposal = await proposeCharterWizardAction({ niche, intent });
      setCharter(proposal);
      setMission(proposal.mission);
      setObjectives(proposal.objectives.join("\n"));
      setDomains(proposal.sourceStrategy.authoritativeDomains.join(", "));
      setMinSources(proposal.verificationBar.establishedMinSources);
      setPresentDebate(proposal.verificationBar.presentDebateMode);
      setTone(proposal.dnaDefaults.tone);
      setPersona(proposal.dnaDefaults.audiencePersona);
      setHookStyles(proposal.dnaDefaults.hookStyles.join(", "));
      setForbidden(proposal.dnaDefaults.forbiddenTopics.join(", "));
      setImageStyle(proposal.dnaDefaults.imageStyle);
      setCta(proposal.dnaDefaults.ctaTemplate);
      const ids = await proposeIdentityWizardAction({ niche, mission: proposal.mission });
      setIdentity(ids);
      setStep(1);
    });

  const pickIdentity = (i: number) => {
    setPicked(i);
    const opt = identity!.options[i]!;
    setName(opt.name);
    setHandle(opt.handle);
  };

  const create = () =>
    run(async () => {
      const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
      const res = await createChannelWithCharterAction({
        name,
        handle,
        niche,
        autonomyTier: tier,
        charter: {
          mission,
          objectives: objectives.split("\n").map((o) => o.trim()).filter(Boolean),
          archetype: charter?.archetype ?? "evergreen_series",
          sourceStrategy: {
            preferredKinds: charter?.sourceStrategy.preferredKinds ?? ["web", "rss"],
            authoritativeDomains: list(domains),
            avoidDomains: charter?.sourceStrategy.avoidDomains ?? [],
          },
          verificationBar: {
            establishedMinSources: minSources,
            presentDebateMode: presentDebate,
          },
          checkinCadence: "weekly",
        },
        dna: {
          tone,
          audiencePersona: persona,
          hookStyles: list(hookStyles),
          forbiddenTopics: list(forbidden),
          imageStyle,
          primaryColor: "#38bdf8",
          font: "Inter",
          voiceId: "default",
          ctaTemplate: cta,
          targetLengthSec: 40,
          cadencePerWeek: 3,
        },
        identityProposals: identity
          ? { options: identity.options, pickedIndex: picked }
          : { options: [], pickedIndex: null },
      });
      setChannelId(res.channelId);
      setStep(3);
    });

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: "1rem" }}>
        {STEPS.map((label, i) => (
          <Badge key={label} tone={i === step ? "accent" : "neutral"} dot={i === step}>
            {i + 1}. {label}
          </Badge>
        ))}
      </div>
      {error && (
        <p>
          <Badge tone="crit">{error}</Badge>
        </p>
      )}

      {step === 0 && (
        <div className="card">
          <Field label="Niche" hint={'(narrow beats broad — e.g. "aviation history")'}>
            <Input value={niche} onChange={(e) => setNiche(e.target.value)} required />
          </Field>
          <Field label="What should this channel be?" hint="(your intent, one sentence)">
            <Input
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              placeholder="deeply researched evergreen stories, one machine per episode"
            />
          </Field>
          <Button
            onClick={draftCharter}
            disabled={pending || !niche.trim()}
            loading={pending}
            icon={<IconSparkle />}
          >
            {pending ? "Drafting charter…" : "Draft charter with AI"}
          </Button>
        </div>
      )}

      {step === 1 && identity && (
        <div>
          <div className="aibox">
            <h4>
              <IconSparkle className="ic" /> AI-proposed identities
            </h4>
            <p className="muted">
              Pick one (you can edit it at the review step). You will apply the name, @handle and
              avatar by hand when you create the YouTube channel — they are not settable via API.
            </p>
          </div>
          <div className="grid">
            {identity.options.map((opt, i) => (
              <button
                key={opt.handle}
                className="card"
                style={{
                  textAlign: "left",
                  cursor: "pointer",
                  borderColor: picked === i ? "var(--accent)" : undefined,
                  boxShadow: picked === i ? "var(--ring)" : undefined,
                }}
                onClick={() => pickIdentity(i)}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <strong>{opt.name}</strong>
                  {picked === i && <Badge tone="accent">selected</Badge>}
                </div>
                <div className="mono muted">{opt.handle}</div>
                <p className="muted">{opt.avatarConcept}</p>
              </button>
            ))}
          </div>
          <div style={{ marginTop: "1rem" }}>
            <Button onClick={() => setStep(2)} disabled={picked === null}>
              Continue
            </Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="card">
          <h2>Review &amp; edit</h2>
          <div className="grid-2">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>
            <Field label="Handle">
              <Input value={handle} onChange={(e) => setHandle(e.target.value)} />
            </Field>
          </div>
          <Field label="Mission">
            <Textarea value={mission} onChange={(e) => setMission(e.target.value)} rows={3} />
          </Field>
          <Field label="Objectives" hint="(one per line)">
            <Textarea value={objectives} onChange={(e) => setObjectives(e.target.value)} rows={3} />
          </Field>
          <div className="grid-2">
            <Field label="Authoritative domains" hint="(comma-separated)">
              <Input value={domains} onChange={(e) => setDomains(e.target.value)} />
            </Field>
            <Field label="Autonomy tier">
              <Select value={tier} onChange={(e) => setTier(Number(e.target.value))}>
                {TIERS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Established facts need N independent sources">
              <Input
                type="number"
                min={1}
                max={5}
                value={minSources}
                onChange={(e) => setMinSources(Number(e.target.value))}
              />
            </Field>
            <label style={{ alignSelf: "end" }}>
              <input
                type="checkbox"
                checked={presentDebate}
                onChange={(e) => setPresentDebate(e.target.checked)}
              />{" "}
              Present-the-debate mode for contested claims
            </label>
          </div>
          <h2>Channel DNA</h2>
          <div className="grid-2">
            <Field label="Tone">
              <Input value={tone} onChange={(e) => setTone(e.target.value)} />
            </Field>
            <Field label="Audience persona">
              <Input value={persona} onChange={(e) => setPersona(e.target.value)} />
            </Field>
            <Field label="Hook styles" hint="(comma-separated)">
              <Input value={hookStyles} onChange={(e) => setHookStyles(e.target.value)} />
            </Field>
            <Field label="Forbidden topics" hint="(comma-separated)">
              <Input value={forbidden} onChange={(e) => setForbidden(e.target.value)} />
            </Field>
            <Field label="Image style">
              <Input value={imageStyle} onChange={(e) => setImageStyle(e.target.value)} />
            </Field>
            <Field label="CTA template">
              <Input value={cta} onChange={(e) => setCta(e.target.value)} />
            </Field>
          </div>
          <div style={{ marginTop: "1rem" }}>
            <Button
              onClick={create}
              disabled={pending || !name.trim() || !mission.trim()}
              loading={pending}
            >
              {pending ? "Creating…" : "Create channel"}
            </Button>
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
              Apply the identity: <strong>{name}</strong> <span className="mono">{handle}</span>
            </li>
            <li>Create an avatar from the concept you picked, and phone-verify the account.</li>
            <li>
              Connect it on the channel page (Settings &amp; DNA → Connect YouTube) so publishing,
              thumbnails and scheduling run automatically.
            </li>
          </ol>
          <ButtonLink href={`/channels/${channelId}`}>Open the channel</ButtonLink>
        </div>
      )}
    </div>
  );
}
