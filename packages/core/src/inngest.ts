import { EventSchemas, Inngest } from "inngest";

type GateDecision = "approved" | "rejected" | "revise";

type Events = {
  "production/greenlit": {
    data: {
      productionId: string;
      /**
       * Re-fire nonce. The pipeline's idempotency key is productionId+attempt,
       * so force-forward can resume the SAME production (fresh ulid) while
       * duplicate greenlight clicks (constant "0") still dedupe.
       */
      attempt: string;
    };
  };
  "production/gate.decided": {
    data: {
      productionId: string;
      gateId: string;
      kind: "script_review" | "thumbnail_review";
      decision: GateDecision;
      notes: string;
      /** optional ISO timestamp: publish no earlier than this (final gate only) */
      scheduledFor?: string;
      /** operator's thumbnail pick at the final gate */
      selectedThumbnailId?: string;
    };
  };
  "trend/scan.requested": {
    data: { channelId?: string };
  };
  "production/failed": {
    data: { productionId: string; step: string; reason: string };
  };
  /** operator halted a running production; the pipeline cancels on this */
  "production/halt": {
    data: { productionId: string };
  };
  "production/published": {
    data: { productionId: string; publicationId: string };
  };
  "analytics/ingest.requested": {
    data: { channelId?: string };
  };
  "analysis/requested": {
    data: { publicationId: string };
  };
  "market/scan.requested": {
    data: { channelId?: string; niche?: string };
  };
  /** editorial engine (build #5): plan/refresh series for charter channels */
  "editorial/plan.requested": {
    data: { channelId?: string };
  };
  /** research one episode: sources → memory → claims → verify → brief → idea.
   * channelId rides along so research can be concurrency-capped and cancelled
   * per channel (see episode-research cancelOn / concurrency). */
  "editorial/episode.research.requested": {
    data: { episodeId: string; channelId?: string };
  };
  /** operator hit "Stop research" on the Plan tab: cancels in-flight planning
   * + episode research for this channel (matched via cancelOn data.channelId) */
  "editorial/research.halt": {
    data: { channelId: string };
  };
  /** operator briefing (build #5.2): compose a check-in now (force skips cadence) */
  "editorial/briefing.requested": {
    data: { channelId?: string; force?: boolean };
  };
  /** BACKLOG #6: derive Shorts from a published long-form master into its
   * linked Shorts channel */
  "editorial/derive-shorts.requested": {
    data: { masterProductionId: string };
  };
  /** BACKLOG #6: publish one derived clip on its staggered schedule */
  "production/publish-clip.requested": {
    data: { productionId: string; scheduledFor: string };
  };
};

export const inngest = new Inngest({
  id: "yt-auto-platform",
  schemas: new EventSchemas().fromRecord<Events>(),
});

export type { Events };
