import type { ProductionProfile } from "@ytauto/db";
import { preferGeneratedImagery } from "./production-profile";

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

/**
 * Pick `count` items EVENLY spaced across `items` (which are in runtime order), so
 * a budget spread over more candidates than it can fund lands across the whole span
 * rather than the front. Returns all items when count >= length; [] when count <= 0.
 * Picks are distinct because count < length ⇒ stride > 1.
 */
function pickEvenly<T>(items: T[], count: number): T[] {
  if (count <= 0) return [];
  if (count >= items.length) return items.slice();
  const stride = items.length / count;
  const out: T[] = [];
  for (let k = 0; k < count; k++) {
    out.push(items[Math.min(items.length - 1, Math.floor(k * stride + stride / 2))]!);
  }
  return out;
}

export function planMotion(
  shots: Array<{
    heroShot?: boolean;
    referenceEntity?: string | null;
    startSec: number;
    endSec: number;
    /** Visual Director medium (#37): when set, it overrides the heuristic below */
    medium?: "still" | "motion" | "real_footage" | null;
    /** ticket 01KY3HWK…: the author marked this beat to move (an authored
     * motionPrompt). Under ai_video these are chosen first, so motion lands where
     * the author placed it — and, when they exceed the budget, EVENLY across them. */
    preferMotion?: boolean;
  }>,
  profile: Pick<ProductionProfile, "motion" | "visualMode">,
  opts: { maxClipSec: number; maxAiClips: number },
): MotionPlanEntry[] {
  const none = (idx: number): MotionPlanEntry => ({ idx, mode: "none", aiFallback: false });
  if (profile.motion === "static") return shots.map((_, idx) => none(idx));

  const fits = (s: { startSec: number; endSec: number }) => s.endSec - s.startSec <= opts.maxClipSec;

  // Visual Director (#37): honour each shot's chosen medium — "motion" → an i2v
  // clip (bounded by the budget), "real_footage" → the stock sourcing chain,
  // "still" → keep the still. Falls through to the heuristic when no shot
  // carries a medium (director off).
  if (shots.some((s) => s.medium != null)) {
    // AI-only ("no real images") channels must NEVER source real footage —
    // even when the Visual Director (an LLM) picks "real_footage" for a shot
    // despite its palette forbidding it. The generated still stands in, so a
    // faceless/AI channel can't leak a stock clip into the render (2026-07-19
    // operator: a Krypton short ended on a random real clip nobody chose).
    const aiOnly = preferGeneratedImagery(profile.visualMode);
    let aiBudget = opts.maxAiClips;
    return shots.map((s, idx) => {
      if (s.medium === "real_footage") {
        if (aiOnly) return none(idx);
        const fallback = aiBudget > 0 && fits(s);
        if (fallback) aiBudget--;
        return { idx, mode: "stock", aiFallback: fallback };
      }
      if (s.medium === "motion" && fits(s) && aiBudget > 0) {
        aiBudget--;
        return { idx, mode: "ai_i2v", aiFallback: false };
      }
      return none(idx);
    });
  }

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

  // motion === "ai_video": DISTRIBUTE the clip budget across the runtime instead
  // of spending it front-to-back (ticket 01KY3HWK… — walking earliest-first put all
  // 12 clips in the first 2 min of a 15-min video, leaving a static body, the
  // opposite of the "sustained movement" goal). Priority: hero shots + the opening
  // (a static first frame is worse than a static middle), then author-marked beats,
  // then an EVEN spread across the rest — and when a tier itself exceeds the budget,
  // it's sampled EVENLY too, so motion never clusters at the front.
  const eligible = shots.map((s, idx) => ({ s, idx })).filter(({ s }) => fits(s));
  const budget = opts.maxAiClips;
  const chosen = new Set<number>();
  const take = (idx: number) => {
    if (chosen.size < budget) chosen.add(idx);
  };
  // 1. hero shots always move (pivotal + author-placed), plus keep the opening moving.
  for (const { s, idx } of eligible) if (s.heroShot) take(idx);
  if (eligible.length) take(eligible[0]!.idx);
  // 2. author-preferred (motionPrompt) beats — evenly sampled if they exceed the budget.
  const preferred = eligible.filter(({ s, idx }) => s.preferMotion && !chosen.has(idx)).map(({ idx }) => idx);
  for (const idx of pickEvenly(preferred, budget - chosen.size)) take(idx);
  // 3. fill any remaining budget with an even spread across the rest of the runtime.
  const rest = eligible.filter(({ idx }) => !chosen.has(idx)).map(({ idx }) => idx);
  for (const idx of pickEvenly(rest, budget - chosen.size)) take(idx);
  return shots.map((_, idx) => (chosen.has(idx) ? { idx, mode: "ai_i2v", aiFallback: false } : none(idx)));
}
