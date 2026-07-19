"use client";

import { useRef, useState, useTransition } from "react";
import { saveScriptBeatsAction } from "../../actions";
import { IconFileText, IconCheck } from "@/components/icons";

/**
 * Direct script editing at the review gate (2026-07-19 operator: "I should be
 * able to edit each segment myself, not just ask the LLM"). Each beat is an
 * editable field — click in, rewrite, Save. Visuals/imagePrompts are preserved
 * server-side; the pipeline re-reads the draft on approval so edits ship.
 */
type EditBeat = { type: string; text: string; estSec: number | null };

function beatLabel(type: string): string {
  return type === "cta" ? "CTA" : type.charAt(0).toUpperCase() + type.slice(1);
}

export function ScriptEditor({
  productionId,
  beats: initial,
}: {
  productionId: string;
  beats: EditBeat[];
}) {
  const [texts, setTexts] = useState<string[]>(initial.map((b) => b.text));
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const original = useRef(initial.map((b) => b.text));

  const dirty = texts.some((t, i) => t !== original.current[i]);
  const words = texts.join(" ").split(/\s+/).filter(Boolean).length;

  const save = () =>
    startTransition(async () => {
      setError(null);
      setSaved(false);
      const res = await saveScriptBeatsAction(productionId, texts);
      if (res.error) setError(res.error);
      else {
        original.current = [...texts];
        setSaved(true);
      }
    });

  const reset = () => {
    setTexts([...original.current]);
    setSaved(false);
    setError(null);
  };

  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-head">
        <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <IconFileText /> Edit the script
        </h3>
      </div>
      <div className="panel-body">
        <p className="muted" style={{ margin: "0 0 12px", fontSize: 12.5 }}>
          Click into any segment and rewrite it directly, or use “Request revision” below to have the
          writer redo it. Saving rebuilds the voiceover + render to match your new words; your images
          are kept and re-timed — they’re only redrawn if the edit changes the number of shots.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {initial.map((b, i) => (
            <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <span className="chip" style={{ flex: "none", marginTop: 6 }}>{beatLabel(b.type)}</span>
              <AutoTextarea
                value={texts[i] ?? ""}
                onChange={(v) => {
                  setSaved(false);
                  setTexts((prev) => prev.map((t, j) => (j === i ? v : t)));
                }}
              />
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
          <button type="button" className="btn" disabled={pending || !dirty} onClick={save}>
            <IconCheck /> {pending ? "Saving…" : "Save script edits"}
          </button>
          {dirty && !pending && (
            <button type="button" className="btn ghost" onClick={reset}>
              Discard changes
            </button>
          )}
          <span className="muted" style={{ fontSize: 12, marginLeft: "auto" }}>
            {words} words · ~{Math.round(words / 2.5)}s
          </span>
          {saved && !dirty && (
            <span className="muted" style={{ fontSize: 12.5 }}>
              Saved — approve below to use this version.
            </span>
          )}
          {error && <span className="err">{error}</span>}
        </div>
      </div>
    </div>
  );
}

/** A textarea that grows to fit its content, styled to read like the script. */
function AutoTextarea({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const grow = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  return (
    <textarea
      ref={(el) => {
        ref.current = el;
        grow(el);
      }}
      value={value}
      onChange={(e) => {
        onChange(e.target.value);
        grow(e.target);
      }}
      rows={1}
      style={{
        width: "100%",
        resize: "none",
        overflow: "hidden",
        lineHeight: 1.5,
        fontSize: 14,
        padding: "6px 8px",
      }}
    />
  );
}
