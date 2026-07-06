import { EventSchemas, Inngest } from "inngest";

type GateDecision = "approved" | "rejected" | "revise";

type Events = {
  "production/greenlit": {
    data: { productionId: string };
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
  /** research one episode: sources → memory → claims → verify → brief → idea */
  "editorial/episode.research.requested": {
    data: { episodeId: string };
  };
  /** operator briefing (build #5.2): compose a check-in now (force skips cadence) */
  "editorial/briefing.requested": {
    data: { channelId?: string; force?: boolean };
  };
};

export const inngest = new Inngest({
  id: "yt-auto-platform",
  schemas: new EventSchemas().fromRecord<Events>(),
});

export type { Events };
