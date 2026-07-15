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
  // default ON (2026-07-15): the common case is "make my videos use this look
  // now" — leaving distills as inactive drafts was the top confusion source
  const [activate, setActivate] = useState(true);
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<{ kind: "queued" | "error"; text: string } | null>(null);

  const run = () =>
    startTransition(async () => {
      setStatus(null);
      const res = await requestStyleDistill(channelId, {
        notes: notes.trim() || undefined,
        autoActivate: activate,
      });
      if (res.error) {
        setStatus({ kind: "error", text: res.error });
        return;
      }
      setStatus({
        kind: "queued",
        text: activate
          ? "Queued — distilling on the worker. It activates automatically when done (about a minute), so the next production uses it."
          : "Queued — distilling on the worker. The new draft appears under Style versions in about a minute; activate it to use it.",
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
      <label style={{ display: "flex", gap: 6, alignItems: "center", margin: "8px 0 0", fontSize: 12.5, cursor: "pointer" }}>
        <input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} disabled={pending} />
        Activate when done <span className="muted">— productions use it immediately</span>
      </label>
      {status && (
        <p className={status.kind === "error" ? "chip crit" : "muted"} style={{ margin: "8px 0 0", fontSize: 12.5 }}>
          {status.kind === "error" && <span className="d" />}
          {status.text}
        </p>
      )}
    </div>
  );
}
