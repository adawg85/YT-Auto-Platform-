import { NextResponse } from "next/server";
import { desc, eq, like, or } from "drizzle-orm";
import { assets, channelDecisions } from "@ytauto/db";
import { getAppContext, getMergedEnv } from "@/lib/context";

/**
 * Animate/clip diagnostics (operator-only; the middleware gates every route).
 * Clips generate ASYNC in the worker (the vendor polls for minutes), so a
 * missing clip is either still-in-flight or a recorded failure. This answers,
 * without a DB client:
 *  - which video engines have keys (Wan/Minimax/Seedance/Kling)?
 *  - the recent "Animate shot N failed: …" ledger entries, with the exact error
 *  - the most recent video_clip assets that DID land
 *
 * Hit: /api/diag/clips
 */
export const dynamic = "force-dynamic";

const mask = (v: string | undefined): string | null => (v ? "set" : null);

export async function GET() {
  const { db } = await getAppContext();
  const env = await getMergedEnv();

  const failures = await db
    .select({
      createdAt: channelDecisions.createdAt,
      summary: channelDecisions.summary,
      detail: channelDecisions.detail,
    })
    .from(channelDecisions)
    // "Shot realignment dropped …" rows (2026-08-09): clips deleted because the
    // shot plan changed under them — the other way an animate "disappears".
    .where(
      or(
        like(channelDecisions.summary, "%Animate shot%"),
        like(channelDecisions.summary, "%Shot realignment dropped%"),
      ),
    )
    .orderBy(desc(channelDecisions.createdAt))
    .limit(20);

  const clips = await db
    .select({
      productionId: assets.productionId,
      idx: assets.idx,
      storageKey: assets.storageKey,
      createdAt: assets.createdAt,
      meta: assets.meta,
    })
    .from(assets)
    .where(eq(assets.kind, "video_clip"))
    .orderBy(desc(assets.createdAt))
    .limit(20);

  return NextResponse.json({
    videoKeys: {
      DASHSCOPE_API_KEY: mask(env.DASHSCOPE_API_KEY), // Wan
      MINIMAX_API_KEY: mask(env.MINIMAX_API_KEY),
      SEEDANCE_API_KEY: mask(env.SEEDANCE_API_KEY),
      ARK_API_KEY: mask(env.ARK_API_KEY), // Seedance/Seedream fallback key
      KLING_ACCESS_KEY: mask(env.KLING_ACCESS_KEY),
      KLING_SECRET_KEY: mask(env.KLING_SECRET_KEY),
    },
    note: "Seedance needs SEEDANCE_API_KEY or ARK_API_KEY; with neither, an Animate request falls back to Wan/Minimax, else the mock.",
    recentAnimateFailures: failures.map((f) => ({
      at: f.createdAt,
      summary: f.summary,
      shot: (f.detail as { idx?: number } | null)?.idx ?? null,
      error: (f.detail as { error?: string } | null)?.error ?? null,
      productionId: (f.detail as { productionId?: string } | null)?.productionId ?? null,
      // realignment-drop rows: which clips went, and whether any was operator footage
      droppedClips: (f.detail as { droppedClips?: unknown } | null)?.droppedClips ?? null,
    })),
    recentClips: clips.map((c) => ({
      productionId: c.productionId,
      idx: c.idx,
      engine: (c.meta as { engine?: string } | null)?.engine ?? null,
      at: c.createdAt,
    })),
  });
}
