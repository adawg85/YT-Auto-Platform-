/**
 * Encode quality for the final master (2026-08-05).
 *
 * Remotion defaults h264 to CRF 18, and neither render path overrode it — so a
 * 42-minute episode came out at over 2GB (~6.3 Mbps). That is near-lossless,
 * and it is spent on bits the viewer never sees: YouTube re-encodes every
 * upload to its own VP9/AV1 ladder, so what reaches an audience is YouTube's
 * transcode, not ours. The oversized master cost upload time, Render egress on
 * every automated publish, and R2 storage — and at 2GB it was large enough to
 * OOM the 2GB worker outright.
 *
 * CRF is a QUALITY target, not a size target: lower is better and larger, and
 * roughly every +6 halves the bitrate. 23 is x264's own default and is widely
 * treated as visually transparent.
 *
 * This is not lossless and should not be described as such. The honest claim is
 * narrower: for this platform's material the loss sits below what YouTube's own
 * re-encode discards anyway. The case to actually watch is fine gradients —
 * dark, smooth areas in painting-heavy channels are where banding shows up
 * first — which is why this is a knob and not a constant.
 */

/** Remotion's h264 default, i.e. the behaviour before this was configurable. */
export const REMOTION_DEFAULT_CRF = 18;

/** What we ship: a real size cut with margin left before artefacts appear. */
export const DEFAULT_RENDER_CRF = 23;

/** x264/Remotion's valid range for h264. */
const MIN_CRF = 1;
const MAX_CRF = 51;

/**
 * Resolve the CRF for a render from config. `REMOTION_CRF` is read from the
 * merged env, so it is settable on /account like the other REMOTION_* keys and
 * takes effect on the next render with no deploy.
 *
 * Anything unparseable or out of range falls back to the default rather than
 * throwing: a typo in a config field must not take the pipeline down, and a
 * silently-clamped absurd value would be worse than an obvious default.
 */
export function resolveRenderCrf(env: Record<string, string | undefined>): number {
  const raw = env.REMOTION_CRF?.trim();
  if (!raw) return DEFAULT_RENDER_CRF;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return DEFAULT_RENDER_CRF;
  if (n < MIN_CRF || n > MAX_CRF) return DEFAULT_RENDER_CRF;
  return n;
}
