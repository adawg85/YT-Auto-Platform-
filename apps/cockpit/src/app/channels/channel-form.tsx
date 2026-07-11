import type { channelDna, channels } from "@ytauto/db";
import type { VoiceOption } from "@ytauto/providers";
import { VoicePicker } from "./voice-picker";

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
  voices,
}: {
  action: (formData: FormData) => Promise<void>;
  channel?: Channel;
  dna?: Dna;
  submitLabel: string;
  /** TTS voice library for the picker; when absent, a plain id field is shown. */
  voices?: VoiceOption[];
}) {
  return (
    <form action={action} className="form-narrow">
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Channel</h2>
        <div className="grid-2 grid">
          <label>
            Name
            <input type="text" name="name" defaultValue={channel?.name} placeholder="Everyday Physics" required />
          </label>
          <label>
            Handle
            <input type="text" name="handle" defaultValue={channel?.handle} placeholder="@my-channel" />
          </label>
        </div>
        <label>
          Niche <span className="muted">— narrow beats broad; this drives ideation and research</span>
          <input
            type="text"
            name="niche"
            defaultValue={channel?.niche}
            placeholder="counterintuitive physics of daily life"
            required
          />
        </label>
        <label style={{ marginBottom: 0 }}>
          Autonomy tier
          <select name="autonomyTier" defaultValue={channel?.autonomyTier ?? 0}>
            {TIERS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Channel DNA</h2>
        <p className="muted" style={{ margin: "-6px 0 14px", fontSize: 12.5 }}>
          The creative strategy every agent works from — tone, audience, visuals and cadence.
        </p>
        <div className="grid-2 grid">
          <label>
            Tone
            <input type="text" name="tone" defaultValue={dna?.tone} placeholder="curious, punchy, no jargon" />
          </label>
          <label>
            Audience persona
            <input
              type="text"
              name="audiencePersona"
              defaultValue={dna?.audiencePersona}
              placeholder="commuters who like 'today I learned' content"
            />
          </label>
          <label>
            Hook styles <span className="muted">— comma-separated</span>
            <input
              type="text"
              name="hookStyles"
              defaultValue={dna?.hookStyles.join(", ")}
              placeholder="curiosity_gap, stakes_first, contrarian"
            />
          </label>
          <label>
            Forbidden topics <span className="muted">— comma-separated</span>
            <input
              type="text"
              name="forbiddenTopics"
              defaultValue={dna?.forbiddenTopics.join(", ")}
              placeholder="health advice, politics"
            />
          </label>
          <label>
            Image style
            <input
              type="text"
              name="imageStyle"
              defaultValue={dna?.visualStyle.imageStyle}
              placeholder="clean flat illustration, high contrast"
            />
          </label>
          <label>
            Primary color
            <input type="text" name="primaryColor" defaultValue={dna?.visualStyle.primaryColor} placeholder="#38bdf8" />
          </label>
          <label>
            Font
            <input type="text" name="font" defaultValue={dna?.visualStyle.font} placeholder="Inter" />
          </label>
          {voices && voices.length > 0 ? (
            <VoicePicker voices={voices} current={dna?.voiceId} />
          ) : (
            <label>
              Voice ID <span className="muted">— TTS provider voice</span>
              <input type="text" name="voiceId" defaultValue={dna?.voiceId} placeholder="voice id from your TTS provider" />
            </label>
          )}
          <label>
            CTA template
            <input
              type="text"
              name="ctaTemplate"
              defaultValue={dna?.ctaTemplate}
              placeholder="Follow for one surprising fact every day."
            />
          </label>
          <label>
            Target length <span className="muted">— seconds; tuned by analytics later</span>
            <input type="number" name="targetLengthSec" min={10} max={1800} defaultValue={dna?.targetLengthSec ?? 40} />
          </label>
          <label>
            Cadence <span className="muted">— videos per week</span>
            <input type="number" name="cadencePerWeek" min={1} max={21} defaultValue={dna?.cadencePerWeek ?? 3} />
          </label>
        </div>
        <div className="form-foot">
          <button type="submit" className="btn">
            {submitLabel}
          </button>
        </div>
      </div>
    </form>
  );
}
