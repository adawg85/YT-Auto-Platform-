import type { channelDna, channels } from "@ytauto/db";
import { Button, Field, Input, Select } from "@/components/ui";

type Channel = typeof channels.$inferSelect;
type Dna = typeof channelDna.$inferSelect;

const TIERS = [
  { value: 0, label: "T0 — Manual: every gate requires approval" },
  { value: 1, label: "T1 — Assisted: script + final review gated" },
  { value: 2, label: "T2 — Supervised: auto-publishes private; you click Release" },
  { value: 3, label: "T3 — Exception-only: fully automated unless flagged" },
];

/** Shared create/edit form for a channel + its DNA (strategy library). */
export function ChannelForm({
  action,
  channel,
  dna,
  submitLabel,
}: {
  action: (formData: FormData) => Promise<void>;
  channel?: Channel;
  dna?: Dna;
  submitLabel: string;
}) {
  return (
    <form action={action} className="card">
      <div className="grid-2">
        <Field label="Name">
          <Input name="name" defaultValue={channel?.name} required />
        </Field>
        <Field label="Handle">
          <Input name="handle" defaultValue={channel?.handle} placeholder="@my-channel" />
        </Field>
      </div>
      <Field label="Niche" hint="(narrow beats broad — this drives ideation and research)">
        <Input name="niche" defaultValue={channel?.niche} required />
      </Field>
      <Field label="Autonomy tier">
        <Select name="autonomyTier" defaultValue={channel?.autonomyTier ?? 0}>
          {TIERS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </Select>
      </Field>

      <h2>Channel DNA</h2>
      <div className="grid-2">
        <Field label="Tone">
          <Input name="tone" defaultValue={dna?.tone} />
        </Field>
        <Field label="Audience persona">
          <Input name="audiencePersona" defaultValue={dna?.audiencePersona} />
        </Field>
        <Field label="Hook styles" hint="(comma-separated)">
          <Input
            name="hookStyles"
            defaultValue={dna?.hookStyles.join(", ")}
            placeholder="curiosity_gap, stakes_first, contrarian"
          />
        </Field>
        <Field label="Forbidden topics" hint="(comma-separated)">
          <Input name="forbiddenTopics" defaultValue={dna?.forbiddenTopics.join(", ")} />
        </Field>
        <Field label="Image style">
          <Input name="imageStyle" defaultValue={dna?.visualStyle.imageStyle} />
        </Field>
        <Field label="Primary color">
          <Input name="primaryColor" defaultValue={dna?.visualStyle.primaryColor} placeholder="#38bdf8" />
        </Field>
        <Field label="Font">
          <Input name="font" defaultValue={dna?.visualStyle.font} placeholder="Inter" />
        </Field>
        <Field label="Voice ID" hint="(TTS provider voice)">
          <Input name="voiceId" defaultValue={dna?.voiceId} />
        </Field>
        <Field label="CTA template">
          <Input name="ctaTemplate" defaultValue={dna?.ctaTemplate} />
        </Field>
        <Field label="Target length (seconds)" hint="(tuned by analytics later)">
          <Input name="targetLengthSec" defaultValue={dna?.targetLengthSec ?? 40} />
        </Field>
        <Field label="Cadence (videos/week)">
          <Input name="cadencePerWeek" defaultValue={dna?.cadencePerWeek ?? 3} />
        </Field>
      </div>
      <div style={{ marginTop: "1rem" }}>
        <Button type="submit">{submitLabel}</Button>
      </div>
    </form>
  );
}
