"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { assistantAction } from "../../assistant/actions";
import { IconAssistant, IconSend } from "@/components/icons";

type Turn = { role: "you" | "assistant"; text: string };

/**
 * Talk-to-the-agent on the plan/charter (BACKLOG #17). A compact chat scoped to
 * this channel — the agent can read/edit the charter targets and kick off the
 * planner via runControl tools. Refreshes the page after each turn so any change
 * (e.g. new objectives) shows immediately.
 */
export function PlanAssistant({ channelId, channelName }: { channelId: string; channelName: string }) {
  const router = useRouter();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const send = (raw?: string) => {
    const message = (raw ?? input).trim();
    if (!message || pending) return;
    setInput("");
    setTurns((t) => [...t, { role: "you", text: message }]);
    startTransition(async () => {
      try {
        const reply = await assistantAction(`[Channel: ${channelName} — channelId ${channelId}] ${message}`);
        setTurns((t) => [...t, { role: "assistant", text: reply }]);
        router.refresh(); // a tool may have changed the charter/plan
      } catch (e) {
        setTurns((t) => [
          ...t,
          { role: "assistant", text: `Error: ${e instanceof Error ? e.message : String(e)}` },
        ]);
      }
    });
  };

  if (!open) {
    return (
      <button type="button" className="btn ghost" style={{ marginTop: 16 }} onClick={() => setOpen(true)}>
        <IconAssistant /> Ask the agent about this plan
      </button>
    );
  }

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="panel-head">
        <h3>Plan assistant</h3>
        <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      <div className="panel-body">
        {turns.length > 0 && (
          <div className="chat" style={{ marginBottom: 12 }}>
            {turns.map((t, i) => (
              <div key={i} className={`bubble ${t.role === "you" ? "me" : "bot"}`}>
                <span className="who">{t.role === "you" ? "You" : "Agent"}</span>
                {t.text}
              </div>
            ))}
            {pending && <div className="bubble bot muted">Thinking…</div>}
          </div>
        )}
        <div className="sugg" style={{ marginBottom: 8 }}>
          {["Make the targets more aggressive", "Plan the next series now", "Summarise this plan"].map((s) => (
            <button key={s} type="button" onClick={() => send(s)} disabled={pending}>
              {s}
            </button>
          ))}
        </div>
        <div className="composer">
          <input
            type="text"
            placeholder="e.g. Change the target to 25k subscribers in 12 months"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
          />
          <button
            type="button"
            className="btn"
            onClick={() => send()}
            disabled={pending || !input.trim()}
            style={{ height: 40 }}
          >
            <IconSend /> Send
          </button>
        </div>
      </div>
    </div>
  );
}
