"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { requestStyleDistill } from "../style-actions";

/**
 * Distill form with visible feedback (2026-07-14): distillation queues onto
 * the worker, so the old silent form-post looked like "nothing happened".
 * Now the button shows queued/error states explicitly.
 */
export function DistillForm({ channelId, disabled }: { channelId: string; disabled: boolean }) {
  const router = useRouter();
  const [notes, setNotes] = useState("");
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<{ kind: "queued" | "error"; text: string } | null>(null);

  const run = () =>
    startTransition(async () => {
      setStatus(null);
      const res = await requestStyleDistill(channelId, { notes: notes.trim() || undefined });
      if (res.error) {
        setStatus({ kind: "error", text: res.error });
        return;
      }
      setStatus({
        kind: "queued",
        text: "Queued — distilling on the worker. The new version appears under Style versions in about a minute.",
      });
      setNotes("");
      router.refresh();
    });

  return (
    <div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional steer (e.g. 'lean darker and more cinematic')"
          style={{ flex: 1, height: 36 }}
          disabled={pending}
        />
        <button type="button" className="btn sm" style={{ height: 36 }} disabled={disabled || pending} onClick={run}>
          {pending ? "Queueing…" : "Distill from examples"}
        </button>
      </div>
      {status && (
        <p className={status.kind === "error" ? "chip crit" : "muted"} style={{ margin: "8px 0 0", fontSize: 12.5 }}>
          {status.kind === "error" && <span className="d" />}
          {status.text}
        </p>
      )}
    </div>
  );
}
