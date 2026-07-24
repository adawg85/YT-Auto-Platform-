import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { ideas, productions, publications, type Db } from "@ytauto/db";

/**
 * Publication ↔ YouTube reconciliation (ticket 01KY1VFP…). The platform's
 * publication records drifted from reality — 7 "published" rows vs 5 live
 * videos — which makes every per-published-video metric wrong. Two failure
 * modes: (a) duplicates were published then deleted on YouTube, leaving stale
 * "published" records; (b) records were written for uploads that never actually
 * completed (a shell/missing video). This module detects both.
 */

/** Live status shape returned by PublishProvider.videoStatus. */
export type LiveVideoStatus =
  | { state: "unknown" }
  | { state: "missing" }
  | {
      state: "found";
      privacyStatus: "private" | "public" | "unlisted";
      publishAt: string | null;
      /** actual go-live time (snippet.publishedAt); null if unreported */
      publishedAt: string | null;
      durationSec: number | null;
      uploadStatus: string | null;
      processingStatus: string | null;
    };

export type ReconcileVerdict =
  | "ok"
  | "no_video_id" // record has no providerVideoId — an upload that likely never completed (case b)
  | "missing_on_youtube" // id set but YouTube has no such video — deleted/never existed (case a)
  | "shell" // exists but has no processed media — "processing forever" (case b)
  | "private_on_youtube" // live but private/unlisted while the platform thinks it's live
  | "unknown"; // provider couldn't answer (mock / read error)

/** Pure classifier: platform record + live status → a verdict + human note. */
export function classifyPublication(input: {
  providerVideoId: string | null;
  /** the platform's belief that this video is live (published + has a publishedAt) */
  believedLive: boolean;
  live: LiveVideoStatus;
}): { verdict: ReconcileVerdict; note: string } {
  if (!input.providerVideoId) {
    return { verdict: "no_video_id", note: "Publication record has no YouTube video id — the upload likely never completed." };
  }
  switch (input.live.state) {
    case "unknown":
      return { verdict: "unknown", note: "Provider couldn't resolve the video (no creds / read error)." };
    case "missing":
      return { verdict: "missing_on_youtube", note: "YouTube has no video with this id — deleted or never existed." };
    case "found": {
      if (input.live.durationSec == null || input.live.uploadStatus === "uploaded" || input.live.processingStatus === "processing") {
        return { verdict: "shell", note: "Video exists but has no processed media (stuck processing) — not a completed upload." };
      }
      if (input.believedLive && input.live.privacyStatus !== "public") {
        return { verdict: "private_on_youtube", note: `Platform thinks this is live, but YouTube has it ${input.live.privacyStatus}.` };
      }
      return { verdict: "ok", note: `Live on YouTube (${input.live.privacyStatus}).` };
    }
  }
}

/** A verdict that means the record does NOT correspond to a real live video. */
export function isReconcileMismatch(v: ReconcileVerdict): boolean {
  return v === "no_video_id" || v === "missing_on_youtube" || v === "shell" || v === "private_on_youtube";
}

/**
 * A verdict that is POSITIVE evidence the record is a phantom — no live completed
 * video exists at the id — so it's safe for the fix mode to reclassify to
 * `published_unverified` (ticket 01KY4VVP…). Deliberately EXCLUDES:
 *  - `unknown`: the provider was unreachable (no creds / read error), and the MOCK
 *    always returns unknown — reclassifying it would nuke every mock/dev record.
 *  - `private_on_youtube`: a real, live video that's merely private — a state
 *    discrepancy to reconcile, NOT a phantom to demote.
 *  - `ok`: live and correct.
 */
export function isConfirmedPhantom(v: ReconcileVerdict): boolean {
  return v === "no_video_id" || v === "missing_on_youtube" || v === "shell";
}

/**
 * Default tolerance for publishedAt drift (ticket 01KY9C9R…). YouTube truncates
 * the ISO string to whole seconds and the native flip isn't instant, so sub-hour
 * differences are benign clock/format noise. A record whose stored publishedAt
 * disagrees with YouTube's real `snippet.publishedAt` by MORE than this is a
 * genuine drift — the incident case was a full six days (scheduled slot stamped
 * as the go-live time when the operator released early in Studio).
 */
export const PUBLISHED_AT_DRIFT_TOLERANCE_MS = 60 * 60_000;

export type PublishedAtDrift = {
  drifted: boolean;
  /** signed ms of (stored − real): positive = stored is LATER than reality */
  deltaMs: number;
  /** which way the CORRECTION moves the stored date */
  direction: "backward" | "forward" | "none";
};

/**
 * Pure drift check between the platform's stored publishedAt and YouTube's
 * authoritative `snippet.publishedAt`. `direction` describes how a correction
 * would move the STORED value toward reality: "backward" (stored is in the
 * future / too late — the incident case, and the one that must re-trigger
 * ingest because the analytics window was empty), "forward", or "none".
 * Returns not-drifted when either date is missing (nothing to compare).
 */
export function publishedAtDrift(input: {
  storedPublishedAt: Date | string | null | undefined;
  remotePublishedAt: string | null | undefined;
  toleranceMs?: number;
}): PublishedAtDrift {
  const tol = input.toleranceMs ?? PUBLISHED_AT_DRIFT_TOLERANCE_MS;
  const storedMs =
    input.storedPublishedAt != null ? new Date(input.storedPublishedAt).getTime() : NaN;
  const remoteMs = input.remotePublishedAt ? new Date(input.remotePublishedAt).getTime() : NaN;
  if (Number.isNaN(storedMs) || Number.isNaN(remoteMs)) {
    return { drifted: false, deltaMs: 0, direction: "none" };
  }
  const deltaMs = storedMs - remoteMs;
  if (Math.abs(deltaMs) <= tol) return { drifted: false, deltaMs, direction: "none" };
  // stored is LATER than reality → correcting it moves the date BACKWARD
  return { drifted: true, deltaMs, direction: deltaMs > 0 ? "backward" : "forward" };
}

export type SuspiciousPublications = {
  /** ideaIds with more than one PUBLISHED production — the duplicate-publish smell */
  duplicateIdeaClusters: { ideaId: string; title: string; productionIds: string[] }[];
  /** published productions whose publication row has no providerVideoId (case b) */
  publishedWithoutVideoId: { productionId: string; title: string }[];
  /** the same providerVideoId on more than one publication */
  duplicateVideoIds: { providerVideoId: string; publicationIds: string[] }[];
};

/**
 * DB-only smell test (cheap — no API calls): surfaces the reconciliation
 * hazards that are detectable from the platform's own data, so get_diagnostics
 * can flag them without N YouTube round-trips. The live check (reconcile tool)
 * confirms which are genuinely wrong.
 */
export async function findSuspiciousPublications(db: Db, channelId?: string): Promise<SuspiciousPublications> {
  const chan = channelId ? eq(productions.channelId, channelId) : undefined;

  // Published productions grouped by idea → clusters of >1 (dup-publish smell).
  const pubProds = await db
    .select({ productionId: productions.id, ideaId: productions.ideaId, title: ideas.title })
    .from(productions)
    .innerJoin(ideas, eq(productions.ideaId, ideas.id))
    .where(chan ? and(eq(productions.status, "published"), chan) : eq(productions.status, "published"));
  const byIdea = new Map<string, { title: string; productionIds: string[] }>();
  for (const p of pubProds) {
    const e = byIdea.get(p.ideaId) ?? { title: p.title, productionIds: [] };
    e.productionIds.push(p.productionId);
    byIdea.set(p.ideaId, e);
  }
  const duplicateIdeaClusters = [...byIdea.entries()]
    .filter(([, v]) => v.productionIds.length > 1)
    .map(([ideaId, v]) => ({ ideaId, title: v.title, productionIds: v.productionIds }));

  // Published productions whose publication has no providerVideoId.
  const missing = await db
    .select({ productionId: productions.id, title: ideas.title })
    .from(publications)
    .innerJoin(productions, eq(publications.productionId, productions.id))
    .innerJoin(ideas, eq(productions.ideaId, ideas.id))
    .where(
      chan
        ? and(eq(productions.status, "published"), isNull(publications.providerVideoId), chan)
        : and(eq(productions.status, "published"), isNull(publications.providerVideoId)),
    );

  // Same providerVideoId on >1 publication.
  const dupRows = await db
    .select({ providerVideoId: publications.providerVideoId, publicationId: publications.id, channelId: productions.channelId })
    .from(publications)
    .innerJoin(productions, eq(publications.productionId, productions.id))
    .where(chan ? and(isNotNull(publications.providerVideoId), chan) : isNotNull(publications.providerVideoId));
  const byVideo = new Map<string, string[]>();
  for (const r of dupRows) {
    if (!r.providerVideoId) continue;
    byVideo.set(r.providerVideoId, [...(byVideo.get(r.providerVideoId) ?? []), r.publicationId]);
  }
  const duplicateVideoIds = [...byVideo.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([providerVideoId, publicationIds]) => ({ providerVideoId, publicationIds }));

  return {
    duplicateIdeaClusters,
    publishedWithoutVideoId: missing,
    duplicateVideoIds,
  };
}
