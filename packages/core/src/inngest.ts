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
    };
  };
  "production/failed": {
    data: { productionId: string; step: string; reason: string };
  };
  "production/published": {
    data: { productionId: string; publicationId: string };
  };
};

export const inngest = new Inngest({
  id: "yt-auto-platform",
  schemas: new EventSchemas().fromRecord<Events>(),
});

export type { Events };
