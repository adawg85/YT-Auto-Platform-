"use client";

import { useState, useTransition } from "react";
import { assistantAction } from "./actions";
import { IconAssistant, IconSend } from "@/components/icons";

type Turn = { role: "you" | "assistant"; text: string };

const SUGGESTIONS = [
  "What's pending for review?",
  "Show open alerts",
  "Run analytics ingest",
  "Scan trends",
  "How are my channels doing?",
];

/**
 * Conversational agent control (spec §5.6): instructions resolve to tool
 * calls against the platform's action API. Every mutation lands in the same
 * audit rows as the cockpit buttons.
 */
export default function AssistantPage() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [pending, startTransition] = useTransition();

  const send = (raw?: string) => {
    const message = (raw ?? input).trim();
    if (!message || pending) return;
    setInput("");
    setTurns((t) => [...t, { role: "you", text: message }]);
    startTransition(async () => {
      try {
        const reply = await assistantAction(message);
        setTurns((t) => [...t, { role: "assistant", text: reply }]);
      } catch (e) {
        setTurns((t) => [
          ...t,
          { role: "assistant", text: `Something went wrong: ${e instanceof Error ? e.message : String(e)}` },
        ]);
      }
    });
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Assistant</h1>
          <p className="page-sub">
            Run the platform in plain language — every action is logged to the same audit trail as the buttons.
          </p>
        </div>
      </div>

      <div className="panel">
        {turns.length === 0 ? (
          <div className="placeholder" style={{ padding: "56px 24px" }}>
            <div className="pic">
              <IconAssistant />
            </div>
            <h2>What do you want to do?</h2>
            <p>Ask about your channels or tell the platform what to run. Try one of these:</p>
            <div className="sugg" style={{ justifyContent: "center", marginTop: 16 }}>
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)} disabled={pending}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="chat">
            {turns.map((t, i) => (
              <div key={i} className={`bubble ${t.role === "you" ? "me" : "bot"}`}>
                <span className="who">{t.role === "you" ? "You" : "Assistant"}</span>
                {t.text}
              </div>
            ))}
            {pending && (
              <div className="bubble bot muted" aria-live="polite">
                Thinking…
              </div>
            )}
          </div>
        )}
      </div>

      <div className="composer">
        <input
          type="text"
          placeholder="e.g. Generate ideas for Everyday Physics"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <button className="btn" onClick={() => send()} disabled={pending || !input.trim()} style={{ height: 40 }}>
          <IconSend /> Send
        </button>
      </div>
    </>
  );
}
