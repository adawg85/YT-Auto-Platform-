"use client";

import { useState, useTransition } from "react";
import { Badge, Button, Card, EmptyState, Input } from "@/components/ui";
import { IconAssistant } from "@/components/icons";
import { assistantAction } from "./actions";

type Turn = { role: "you" | "assistant"; text: string };

/**
 * Conversational agent control (spec §5.6): instructions resolve to tool
 * calls against the platform's action API. Every mutation lands in the same
 * audit rows as the cockpit buttons.
 */
export default function AssistantPage() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [pending, startTransition] = useTransition();

  const send = () => {
    const message = input.trim();
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
          { role: "assistant", text: `Error: ${e instanceof Error ? e.message : String(e)}` },
        ]);
      }
    });
  };

  return (
    <div>
      <h1>Assistant</h1>
      <p className="muted">
        Natural-language control over the platform: try “what&apos;s pending for review?”,
        “show open alerts”, “run analytics ingest”, “scan trends”, or “how are my channels doing?”.
        Actions are logged to the agent audit trail.
      </p>

      <Card style={{ minHeight: 200 }}>
        {turns.length === 0 && !pending ? (
          <EmptyState
            icon={<IconAssistant />}
            title="No messages yet"
            description="Ask the assistant to review gates, show alerts, or run analytics ingest to get started."
          />
        ) : (
          <>
            {turns.map((t, i) => (
              <p key={i} style={{ whiteSpace: "pre-wrap" }}>
                <Badge tone={t.role === "you" ? "accent" : "good"}>{t.role}</Badge> {t.text}
              </p>
            ))}
            {pending && <p className="muted">assistant is working…</p>}
          </>
        )}
      </Card>

      <div style={{ display: "flex", gap: 8 }}>
        <Input
          placeholder="Tell the platform what to do…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <Button onClick={send} disabled={pending} loading={pending}>
          Send
        </Button>
      </div>
    </div>
  );
}
