/**
 * Shared axis vocabulary (2026-07-14 operator: the per-video profile gate
 * showed raw enum values with no explainers, feeling disconnected from the
 * Profile tab). ONE place owns every axis option's human label + one-line
 * meaning; the Profile tab tiles AND the production gate dropdowns render
 * from this, so the two surfaces can never drift apart again.
 *
 * Lives in the cockpit (not @ytauto/core) because the gate popup is a client
 * component and core's barrel pulls node:crypto — this module must stay pure
 * data, importable from either side of the client/server boundary.
 */
export const AXIS_OPTIONS: Record<string, { value: string; label: string; hint: string }[]> = {
  visualMode: [
    { value: "simple", label: "Simple", hint: "Minimal graphics — no imagery sourcing or generation (coming soon)" },
    { value: "real_footage", label: "Real footage", hint: "Licensed real photos/clips (Wikimedia, archives, Pexels) wherever possible" },
    { value: "ai_images", label: "AI images", hint: "Every shot generated per beat — never sources real imagery" },
    { value: "ai_video", label: "AI video", hint: "Generated visuals with beat clips animated from their images" },
    { value: "mixed", label: "Mixed", hint: "Real imagery where the archives deliver, AI generation everywhere else" },
  ],
  motion: [
    { value: "static", label: "Static", hint: "Still images with a slow Ken Burns zoom — cheapest, fastest renders" },
    { value: "partial", label: "Key beats", hint: "Hero shots move (stock clip or AI-animated); other shots stay stills" },
    { value: "ai_video", label: "Full AI video", hint: "Every eligible shot animated from its image — capped per video, the cost lever" },
  ],
  // ordered fewest → most images (2026-07-15 operator ask); short punchy
  // sentences mean "Per sentence" can cut a lot, so the count is flagged inline
  rhythm: [
    { value: "section", label: "Per section — fewest images", hint: "One image per story section — calmest and cheapest; a single still holds the whole section" },
    { value: "sentence", label: "Per sentence — more images", hint: "A new image on each sentence; with short punchy sentences this cuts a lot (capped ~3–4 per section, min shot length still applies)" },
    { value: "pause", label: "On pauses — most images", hint: "Cuts on every natural speech pause — the most images and the most movement (same per-section cap)" },
  ],
  captions: [
    { value: "on", label: "On", hint: "Word-by-word karaoke captions burned into the video" },
    { value: "off", label: "Off", hint: "No burned-in captions — viewers rely on platform subtitles" },
  ],
  music: [
    { value: "off", label: "Off", hint: "Voiceover only — no music bed" },
    { value: "subtle", label: "Subtle", hint: "Quiet music bed ducked far under the narration" },
    { value: "standard", label: "Standard", hint: "Music bed mixed under the voiceover" },
  ],
  delivery: [
    { value: "measured", label: "Measured", hint: "Calm, even narration pace" },
    { value: "warm", label: "Warm", hint: "Friendly, reassuring delivery" },
    { value: "energetic", label: "Energetic", hint: "Fast, punchy delivery that never sits still" },
    { value: "dramatic", label: "Dramatic", hint: "Big dynamic swings — tension and release" },
  ],
  archivalStrength: [
    { value: "off", label: "Off", hint: "Never source — every shot is generated" },
    { value: "light", label: "Light", hint: "Named subjects only, strict match bar" },
    { value: "balanced", label: "Balanced", hint: "Named subjects + topic search, one candidate each" },
    { value: "strong", label: "Strong", hint: "3 candidates per shot, forgiving bar, topic retry" },
    { value: "max", label: "Max", hint: "5 candidates per shot, most forgiving match bar" },
  ],
};

/** Human label for an axis value (falls back to the raw value). */
export function axisOptionLabel(axis: string, value: string): string {
  return AXIS_OPTIONS[axis]?.find((o) => o.value === value)?.label ?? value;
}
