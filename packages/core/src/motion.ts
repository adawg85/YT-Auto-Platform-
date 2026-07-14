import type { ProductionProfile } from "@ytauto/db";

/**
 * Motion planning (2026-07-14, BACKLOG #6/#26-v2): give the Production
 * Profile's motion axis real semantics. Pure — unit-testable without
 * DB/Inngest, mirroring archivalImagePolicy.
 *
 *   static   → stills only (unchanged).
 *   partial  → "Key beats": hero shots move. Real-imagery channels source the
 *              clip (archival → Pexels) with AI image-to-video as fallback;
 *              AI-imagery channels animate the beat image directly.
 *   ai_video → every eligible shot is animated (i2v over its beat image),
 *              hero shots first, capped at maxAiClips — the cost knob.
 *
 * A shot longer than maxClipSec keeps its Ken Burns still — a clip that
 * freezes on its last frame mid-beat looks worse than deliberate stillness.
 */
export type MotionPlanEntry = {
  idx: number;
  /** stock = archival→Pexels sourcing chain; ai_i2v = animate the beat image */
  mode: "none" | "stock" | "ai_i2v";
  /** stock only: try AI i2v when every stock source misses */
  aiFallback: boolean;
};

export function planMotion(
  shots: Array<{
    heroShot?: boolean;
    referenceEntity?: string | null;
    startSec: number;
    endSec: number;
  }>,
  profile: Pick<ProductionProfile, "motion" | "visualMode">,
  opts: { maxClipSec: number; maxAiClips: number },
): MotionPlanEntry[] {
  const none = (idx: number): MotionPlanEntry => ({ idx, mode: "none", aiFallback: false });
  if (profile.motion === "static") return shots.map((_, idx) => none(idx));

  const fits = (s: { startSec: number; endSec: number }) => s.endSec - s.startSec <= opts.maxClipSec;
  const aiVisuals = profile.visualMode === "ai_images" || profile.visualMode === "ai_video";

  if (profile.motion === "partial") {
    let aiBudget = opts.maxAiClips;
    return shots.map((s, idx) => {
      if (!s.heroShot || !fits(s)) return none(idx);
      if (aiVisuals) {
        if (aiBudget <= 0) return none(idx);
        aiBudget--;
        return { idx, mode: "ai_i2v", aiFallback: false };
      }
      // real-imagery channels: stock chain first; the i2v fallback also
      // consumes AI budget so a sourcing dry spell can't blow the cap
      const fallback = aiBudget > 0;
      if (fallback) aiBudget--;
      return { idx, mode: "stock", aiFallback: fallback };
    });
  }

  // motion === "ai_video": animate everything eligible, hero-first up to cap
  const eligible = shots
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => fits(s))
    .sort((a, b) => Number(b.s.heroShot ?? false) - Number(a.s.heroShot ?? false) || a.idx - b.idx)
    .slice(0, opts.maxAiClips)
    .map(({ idx }) => idx);
  const animate = new Set(eligible);
  return shots.map((_, idx) =>
    animate.has(idx) ? { idx, mode: "ai_i2v", aiFallback: false } : none(idx),
  );
}
