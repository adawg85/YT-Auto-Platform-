"use client";

import { useState, useTransition } from "react";
import type { WizardPatch, WizardChatTurn } from "@ytauto/agents";
import { IconSparkle, IconSend, IconChevronDown } from "@/components/icons";
import { wizardAssistantAction } from "../editorial-actions";

/**
 * Persistent setup co-pilot: a collapsible dock pinned to the bottom of the
 * channel wizard. It chats conversationally and can push field edits (`patch`)
 * straight into the wizard's draft via `onApplyPatch`, so the operator can say
 * "make the mission punchier" and watch the field change.
 */
export function WizardAssistant({
  step,
  fields,
  onApplyPatch,
}: {
  step: string;
  fields: WizardPatch;
  onApplyPatch: (patch: WizardPatch) => void;
}) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<WizardChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const send = () => {
    const message = input.trim();
    if (!message || pending) return;
    setError(null);
    const nextHistory: WizardChatTurn[] = [...history, { role: "operator", text: message }];
    setHistory(nextHistory);
    setInput("");
    startTransition(async () => {
      const res = await wizardAssistantAction({ step, fields, history, message });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      if (res.patch && Object.keys(res.patch).length > 0) onApplyPatch(res.patch);
      setHistory([...nextHistory, { role: "assistant", text: res.reply }]);
    });
  };

  return (
    <div
      style={{
        position: "sticky",
        bottom: 16,
        marginTop: 24,
        zIndex: 20,
      }}
    >
      {open ? (
        <div className="panel" style={{ boxShadow: "var(--shadow-lg, 0 12px 32px rgba(0,0,0,.28))" }}>
          <div
            className="panel-head"
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
          >
            <h3 style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <IconSparkle /> Setup co-pilot
            </h3>
            <button className="btn ghost sm" onClick={() => setOpen(false)} aria-label="Collapse">
              <IconChevronDown />
            </button>
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div
              style={{
                maxHeight: 240,
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {history.length === 0 && (
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                  Ask me to refine anything on this step — e.g. &ldquo;make the mission punchier&rdquo;,
                  &ldquo;suggest 5 authoritative domains&rdquo;, or &ldquo;switch to long-form&rdquo;. I&apos;ll
                  edit the fields directly.
                </p>
              )}
              {history.map((t, i) => (
                <div
                  key={i}
                  style={{
                    alignSelf: t.role === "operator" ? "flex-end" : "flex-start",
                    maxWidth: "85%",
                    padding: "8px 11px",
                    borderRadius: 10,
                    fontSize: 13.5,
                    lineHeight: 1.45,
                    background: t.role === "operator" ? "var(--accent-soft)" : "var(--surface-2)",
                    border: "1px solid var(--border)",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {t.text}
                </div>
              ))}
              {pending && (
                <div className="muted" style={{ fontSize: 13 }}>
                  Thinking…
                </div>
              )}
            </div>
            {error && <p className="badge red" style={{ margin: 0 }}>{error}</p>}
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder="Message the co-pilot…"
                style={{ flex: 1 }}
              />
              <button className="btn" onClick={send} disabled={pending || !input.trim()}>
                <IconSend />
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button className="btn" onClick={() => setOpen(true)}>
            <IconSparkle /> Setup co-pilot
          </button>
        </div>
      )}
    </div>
  );
}
