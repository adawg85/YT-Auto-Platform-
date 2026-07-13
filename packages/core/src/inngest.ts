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
      kind: "script_review" | "profile_review" | "visuals_review" | "thumbnail_review";
      decision: GateDecision;
      notes: string;
      /** optional ISO timestamp: publish no earlier than this (final gate only) */
      scheduledFor?: string;
      /** operator's thumbnail pick at the final gate */
      selectedThumbnailId?: string;
      /** profile_review gates (2026-07-12): the operator's per-video profile
       * (the AI proposal as-is or with edits); the worker re-validates it via
       * resolveProductionProfile so garbage can never reach the pipeline */
      editedProfile?: Record<string, unknown>;
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
  /** auto-score: score every unscored idea for a channel (fired after generation/seeding) */
  "ideas/autoscore.requested": {
    data: { channelId?: string };
  };
  /** BACKLOG #21.7: manual trigger for the data-retention janitor + capacity check */
  "ops/janitor.requested": {
    data: { [k: string]: never };
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
  /** BACKLOG #23.1 gap-fill: an episode was cut (research) or its production
   * failed — propose one replacement episode for the vacated tentative slot */
  "editorial/gapfill.requested": {
    data: { channelId: string; seriesId: string; episodeId: string };
  };
  /** operator hit "Stop research" on the Plan tab: cancels in-flight planning
   * + episode research for this channel (matched via cancelOn data.channelId) */
  /** operator force-accepted an episode's research (2026-07-12): cancel THAT
   * episode's in-flight research chain only — never the whole channel's */
  "editorial/episode.research.halt": {
    data: { episodeId: string; channelId: string };
  };
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
  /** #21.2.5 eval harness: run the golden set against the models listed on
   * the eval_runs row (the row is created first so the run is resumable) */
  "eval/run.requested": {
    data: { runId: string };
  };
  /** #21.5 learning loop: run the channel retro now (cadence bypassed when
   * channelId given — an explicit operator ask) */
  "learning/retro.requested": {
    data: { channelId?: string };
  };
};

export const inngest = new Inngest({
  id: "yt-auto-platform",
  schemas: new EventSchemas().fromRecord<Events>(),
});

export type { Events };
