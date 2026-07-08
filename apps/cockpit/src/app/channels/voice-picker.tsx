"use client";

import { useState } from "react";
import type { VoiceOption } from "@ytauto/providers";

/**
 * Per-channel voice selector (BACKLOG #16). Replaces the raw "voice id" text
 * box so a channel always stores a REAL voice id, never the "default"
 * placeholder that silently falls back to a generic premade voice. Shows a
 * description + playable preview per voice.
 */
export function VoicePicker({ voices, current }: { voices: VoiceOption[]; current?: string | null }) {
  const hasCurrent = !!current && current !== "default";
  const known = voices.some((v) => v.id === current);
  const [selected, setSelected] = useState<string>(hasCurrent ? current! : voices[0]?.id ?? "");
  const sel = voices.find((v) => v.id === selected);

  return (
    <label>
      Voice <span className="muted">— the channel&apos;s narration voice</span>
      <select name="voiceId" value={selected} onChange={(e) => setSelected(e.target.value)}>
        {/* preserve an unknown current id so saving never silently drops it */}
        {!known && hasCurrent && <option value={current!}>Current: {current}</option>}
        {voices.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
            {v.labels?.gender ? ` · ${v.labels.gender}` : ""}
            {v.labels?.use_case ? ` · ${v.labels.use_case}` : ""}
          </option>
        ))}
      </select>
      {sel?.description && (
        <span className="muted" style={{ fontSize: 12, display: "block", marginTop: 4 }}>
          {sel.description}
        </span>
      )}
      {sel?.previewUrl && (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <audio controls src={sel.previewUrl} style={{ marginTop: 8, width: "100%", height: 34 }} />
      )}
      {!hasCurrent && (
        <span className="chip warn" style={{ marginTop: 8 }}>
          <span className="d" />
          No voice picked — falls back to a generic default. Choose one.
        </span>
      )}
    </label>
  );
}
