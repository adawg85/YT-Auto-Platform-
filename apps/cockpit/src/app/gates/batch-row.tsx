"use client";

import { useState, useTransition } from "react";
import { Button, Input } from "@/components/ui";
import { IconCheck, IconRevise, IconX } from "@/components/icons";
import { decideGateAction } from "../actions";

/**
 * Batch review (spec §5.6): decide script gates inline from the queue —
 * this is how operator judgment scales across many channels.
 */
export function BatchDecide({ gateId }: { gateId: string }) {
  const [notes, setNotes] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const decide = (decision: "approved" | "rejected" | "revise") => {
    if (decision === "revise" && !notes.trim()) {
      setError("Revise needs notes");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await decideGateAction(gateId, decision, notes);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  };

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <Input
        placeholder="notes (evidence log)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        style={{ width: 180 }}
      />
      <Button
        variant="good"
        size="sm"
        icon={<IconCheck />}
        disabled={pending}
        onClick={() => decide("approved")}
      >
        Approve
      </Button>
      <Button
        variant="warn"
        size="sm"
        icon={<IconRevise />}
        disabled={pending}
        onClick={() => decide("revise")}
      >
        Revise
      </Button>
      <Button
        variant="danger"
        size="sm"
        icon={<IconX />}
        disabled={pending}
        onClick={() => decide("rejected")}
      >
        Reject
      </Button>
      {error && <span style={{ color: "var(--crit)" }}>{error}</span>}
    </div>
  );
}
