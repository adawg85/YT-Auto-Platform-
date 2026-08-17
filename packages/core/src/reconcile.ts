import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { ideas, productions, publications, type Db } from "@ytauto/db";

/**
 * #87: statuses in which a production is expected to have a completed upload (a
 * providerVideoId). `scheduled` is included because the current pipeline uploads
 * PRIVATE immediately and only then schedules go-live — so a `scheduled` row with
 * no providerVideoId is a stuck/failed upload, not a normal pending state (the
 * seven-uploads-none-completed case). Used by both the duplicate-cluster and the
 * missing-video-id smell tests so a stuck upload is discoverable in get_diagnostics.
 */
export const UPLOAD_EXPECTED_STATUSES = ["published", "scheduled"] as const;

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

/**
 * #126: statuses in which the PLATFORM believes the video is already live. Every
 * other status means "not out yet" — so YouTube reporting it PUBLIC is drift the
 * platform has not recorded.
 *
 * `published_unverified` counts as believed-live for this purpose: it is a
 * published record demoted for a dead id, and if the id ever resolves public
 * again that is the phantom check's business, not an unrecorded publish.
 */
const BELIEVED_LIVE_STATUSES = ["published", "published_unverified", "analysing"] as const;

export function platformBelievesLive(status: string): boolean {
  return (BELIEVED_LIVE_STATUSES as readonly string[]).includes(status);
}

/**
 * #126: statuses whose unrecorded publish is safe for `fix:true` to record —
 * a video that was ALWAYS meant to go live and simply went early. Everything
 * else (on_hold, failed, retired, superseded, a mid-pipeline status) is flagged
 * but never auto-published: a retired record whose video is somehow public is a
 * judgement call for the operator, not bookkeeping.
 */
const UNRECORDED_PUBLISH_AUTOFIX_STATUSES = ["scheduled", "ready"] as const;

export type UnrecordedPublish = {
  /** the production status the platform is still carrying */
  productionStatus: string;
  /** YouTube's real go-live moment (ISO) */
  realPublishedAt: string;
  /** the slot the platform was still waiting for (ISO), when there was one */
  scheduledFor: string | null;
  /** how far the go-live PRECEDED the scheduled slot; null without a slot */
  earlyByHours: number | null;
  earlyByDays: number | null;
  /** whether fix:true may record this as published */
  autoFixable: boolean;
  note: string;
};

/**
 * #126 — the drift class `reconcile_publications` could not see.
 *
 * A video went PUBLIC four days before its slot; the platform record sat at
 * `scheduled` indefinitely and the full-platform sweep reported `driftCount: 0`,
 * because the date-drift check only compares records the platform already
 * believes are live (`published` + a stored publishedAt). A record still marked
 * `scheduled` has publishedAt NULL, so there was nothing to compare and it read
 * as an all-clear — while analytics ingest, which keys off publishedAt, missed
 * the first four days of a Short's life.
 *
 * This detects the state rather than the cause: the platform does not think the
 * video is live, YouTube says it is. Pure, so the day-count and the auto-fix
 * rule are unit-testable without a DB or the YouTube API.
 */
export function detectUnrecordedPublish(input: {
  productionStatus: string;
  scheduledFor: Date | string | null | undefined;
  live: LiveVideoStatus;
  now: Date;
}): UnrecordedPublish | null {
  if (input.live.state !== "found" || input.live.privacyStatus !== "public") return null;
  if (platformBelievesLive(input.productionStatus)) return null;

  const realPublishedAt = resolveGoLivePublishedAtLocal({
    remotePublishedAt: input.live.publishedAt,
    scheduledFor: input.scheduledFor,
    now: input.now,
  });
  const slotMs = input.scheduledFor != null ? new Date(input.scheduledFor).getTime() : NaN;
  const earlyMs = Number.isNaN(slotMs) ? null : slotMs - realPublishedAt.getTime();
  // Only a POSITIVE gap is "early" — a slot in the past is a normal go-live the
  // bookkeeping simply never recorded.
  const early = earlyMs != null && earlyMs > 0 ? earlyMs : null;
  const autoFixable = (UNRECORDED_PUBLISH_AUTOFIX_STATUSES as readonly string[]).includes(
    input.productionStatus,
  );
  const earlyByHours = early != null ? Math.round((early / 3_600_000) * 10) / 10 : null;
  const earlyByDays = early != null ? Math.round((early / 86_400_000) * 10) / 10 : null;

  const when =
    early != null
      ? `${earlyByDays} day(s) BEFORE its ${new Date(slotMs).toISOString()} slot`
      : "with no future slot outstanding";
  return {
    productionStatus: input.productionStatus,
    realPublishedAt: realPublishedAt.toISOString(),
    scheduledFor: Number.isNaN(slotMs) ? null : new Date(slotMs).toISOString(),
    earlyByHours,
    earlyByDays,
    autoFixable,
    note: autoFixable
      ? `YouTube has this PUBLIC (since ${realPublishedAt.toISOString()}) while the platform still reads '${input.productionStatus}' — live ${when}. Analytics ingest keys off publishedAt, so nothing was collected for it. fix:true records the real publish date and re-triggers ingest.`
      : `YouTube has this PUBLIC (since ${realPublishedAt.toISOString()}) while the platform reads '${input.productionStatus}' — live ${when}. NOT auto-corrected from a '${input.productionStatus}' record: use sync_publication_from_youtube on it if it should be recorded as published.`,
  };
}

/**
 * Local copy of `resolveGoLivePublishedAt`'s rule (publish.ts) — duplicated here
 * rather than imported so this module stays free of the DB/inngest import chain
 * that publish.ts pulls in. Same three rules, and a shared unit test pins them
 * to the same answers.
 */
function resolveGoLivePublishedAtLocal(input: {
  remotePublishedAt?: string | null;
  scheduledFor?: Date | string | null;
  now: Date;
}): Date {
  if (input.remotePublishedAt) {
    const d = new Date(input.remotePublishedAt);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (input.scheduledFor != null) {
    const slot = new Date(input.scheduledFor);
    if (!Number.isNaN(slot.getTime()) && slot.getTime() <= input.now.getTime()) return slot;
  }
  return input.now;
}

/**
 * #126 (defect A, the invisibility half) — which rows the publish-finalize cron
 * must reconcile every 10 minutes.
 *
 * The cron used to sweep `publications.privacyStatus = 'scheduled'` only. But the
 * pipeline writes that value LAST (step 9e, `finalize-publication`); the row is
 * created earlier (step 8b, `mark-scheduled`) as `private` while the PRODUCTION
 * is already `scheduled`. A run that dies, is halted, or is superseded between
 * those two steps leaves an uploaded video with a native publishAt on YouTube and
 * a platform row the sweep never looks at again — so when YouTube flips it
 * public, nothing on the platform ever notices. That is exactly the reported
 * state: a video live for four days against a record still reading `scheduled`.
 *
 * Scope is therefore "the platform is waiting for this to go live and there IS
 * something on YouTube to ask about": a recorded video id, no recorded go-live,
 * and either side still saying scheduled. Pure + tested.
 */
export function scheduledSweepInScope(row: {
  productionStatus: string;
  privacyStatus: string;
  providerVideoId: string | null;
  publishedAt: Date | string | null;
}): boolean {
  if (!row.providerVideoId) return false; // nothing to ask YouTube about
  if (row.publishedAt) return false; // already recorded live
  return row.privacyStatus === "scheduled" || row.productionStatus === "scheduled";
}

/**
 * #126 (requested item 4) — the alarm for a release that happened EARLY.
 *
 * The cron already flips an off-slot release live, but did so silently, so a
 * video going public days before its slot looked identical to one going public
 * on time. That matters commercially: an early release opens the Content ID
 * window before the operator expects the video to exist (one video on the
 * reporting channel is already globally blocked by such a claim), and it strands
 * the first days of ingest. `graceMs` ignores the seconds-scale slop between
 * YouTube's flip and the cron's read. Pure.
 */
export function earlyReleaseAlarm(input: {
  scheduledFor: Date | string | null | undefined;
  publishedAt: Date;
  graceMs?: number;
}): { early: boolean; hoursEarly: number; daysEarly: number } {
  const grace = input.graceMs ?? PUBLISHED_AT_DRIFT_TOLERANCE_MS;
  const slotMs = input.scheduledFor != null ? new Date(input.scheduledFor).getTime() : NaN;
  if (Number.isNaN(slotMs)) return { early: false, hoursEarly: 0, daysEarly: 0 };
  const earlyMs = slotMs - input.publishedAt.getTime();
  if (earlyMs <= grace) return { early: false, hoursEarly: 0, daysEarly: 0 };
  return {
    early: true,
    hoursEarly: Math.round((earlyMs / 3_600_000) * 10) / 10,
    daysEarly: Math.round((earlyMs / 86_400_000) * 10) / 10,
  };
}

export type SuspiciousPublications = {
  /** ideaIds with more than one published/scheduled production — the duplicate-publish
   * smell. #87: `scheduled` included so duplicate PENDING productions for one idea
   * (a retry that minted a second production) are caught, not just published ones. */
  duplicateIdeaClusters: { ideaId: string; title: string; productionIds: string[] }[];
  /** published OR scheduled productions whose publication row has no providerVideoId —
   * an upload that never completed (#87: the stuck-at-"scheduled" case get_diagnostics
   * used to miss because it only looked at status="published"). */
  uploadsWithoutVideoId: { productionId: string; title: string; status: string }[];
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

  // Published/scheduled productions grouped by idea → clusters of >1 (dup smell).
  const statusFilter = inArray(productions.status, [...UPLOAD_EXPECTED_STATUSES]);
  const pubProds = await db
    .select({ productionId: productions.id, ideaId: productions.ideaId, title: ideas.title })
    .from(productions)
    .innerJoin(ideas, eq(productions.ideaId, ideas.id))
    .where(chan ? and(statusFilter, chan) : statusFilter);
  const byIdea = new Map<string, { title: string; productionIds: string[] }>();
  for (const p of pubProds) {
    const e = byIdea.get(p.ideaId) ?? { title: p.title, productionIds: [] };
    e.productionIds.push(p.productionId);
    byIdea.set(p.ideaId, e);
  }
  const duplicateIdeaClusters = [...byIdea.entries()]
    .filter(([, v]) => v.productionIds.length > 1)
    .map(([ideaId, v]) => ({ ideaId, title: v.title, productionIds: v.productionIds }));

  // Published/scheduled productions whose publication has no providerVideoId — a
  // stuck/failed upload (#87). Reports status so a scheduled-vs-published stall is
  // distinguishable.
  const missing = await db
    .select({ productionId: productions.id, title: ideas.title, status: productions.status })
    .from(publications)
    .innerJoin(productions, eq(publications.productionId, productions.id))
    .innerJoin(ideas, eq(productions.ideaId, ideas.id))
    .where(
      chan
        ? and(statusFilter, isNull(publications.providerVideoId), chan)
        : and(statusFilter, isNull(publications.providerVideoId)),
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
    uploadsWithoutVideoId: missing,
    duplicateVideoIds,
  };
}
