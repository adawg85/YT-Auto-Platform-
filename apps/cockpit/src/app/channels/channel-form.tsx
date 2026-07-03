import type { channelDna, channels } from "@ytauto/db";

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
        <label>
          Name
          <input type="text" name="name" defaultValue={channel?.name} required />
        </label>
        <label>
          Handle
          <input type="text" name="handle" defaultValue={channel?.handle} placeholder="@my-channel" />
        </label>
      </div>
      <label>
        Niche <span className="muted">(narrow beats broad — this drives ideation and research)</span>
        <input type="text" name="niche" defaultValue={channel?.niche} required />
      </label>
      <label>
        Autonomy tier
        <select name="autonomyTier" defaultValue={channel?.autonomyTier ?? 0}>
          {TIERS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>

      <h2>Channel DNA</h2>
      <div className="grid-2">
        <label>
          Tone
          <input type="text" name="tone" defaultValue={dna?.tone} />
        </label>
        <label>
          Audience persona
          <input type="text" name="audiencePersona" defaultValue={dna?.audiencePersona} />
        </label>
        <label>
          Hook styles <span className="muted">(comma-separated)</span>
          <input
            type="text"
            name="hookStyles"
            defaultValue={dna?.hookStyles.join(", ")}
            placeholder="curiosity_gap, stakes_first, contrarian"
          />
        </label>
        <label>
          Forbidden topics <span className="muted">(comma-separated)</span>
          <input type="text" name="forbiddenTopics" defaultValue={dna?.forbiddenTopics.join(", ")} />
        </label>
        <label>
          Image style
          <input type="text" name="imageStyle" defaultValue={dna?.visualStyle.imageStyle} />
        </label>
        <label>
          Primary color
          <input type="text" name="primaryColor" defaultValue={dna?.visualStyle.primaryColor} placeholder="#38bdf8" />
        </label>
        <label>
          Font
          <input type="text" name="font" defaultValue={dna?.visualStyle.font} placeholder="Inter" />
        </label>
        <label>
          Voice ID <span className="muted">(TTS provider voice)</span>
          <input type="text" name="voiceId" defaultValue={dna?.voiceId} />
        </label>
        <label>
          CTA template
          <input type="text" name="ctaTemplate" defaultValue={dna?.ctaTemplate} />
        </label>
        <label>
          Target length (seconds) <span className="muted">(tuned by analytics later)</span>
          <input type="text" name="targetLengthSec" defaultValue={dna?.targetLengthSec ?? 40} />
        </label>
        <label>
          Cadence (videos/week)
          <input type="text" name="cadencePerWeek" defaultValue={dna?.cadencePerWeek ?? 3} />
        </label>
      </div>
      <div style={{ marginTop: "1rem" }}>
        <button type="submit">{submitLabel}</button>
      </div>
    </form>
  );
}
