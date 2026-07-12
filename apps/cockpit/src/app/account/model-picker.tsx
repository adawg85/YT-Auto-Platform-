"use client";

import { useState, useTransition } from "react";
import { IconCheck, IconRefresh } from "@/components/icons";
import { deleteSecretAction, saveSecretAction } from "./actions";

const VENDORS = ["anthropic", "openai", "google", "glm", "qwen", "kimi", "openrouter"] as const;
type Vendor = (typeof VENDORS)[number];

/** Suggested model ids per vendor (datalist hints; any value is accepted). */
const SUGGESTIONS: Record<Vendor, string[]> = {
  anthropic: ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"],
  openai: ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4.1-mini"],
  google: ["gemini-2.5-flash-lite"],
  glm: ["glm-4.6"],
  qwen: ["qwen-max", "qwen-plus"],
  kimi: ["kimi-k2-turbo-preview"],
  openrouter: ["qwen/qwen-max", "anthropic/claude-opus-4.8", "google/gemini-2.5-flash-lite"],
};

export type TierCard = {
  tier: "cheap" | "agentic" | "frontier" | "escalation";
  secretName: string;
  label: string;
  description: string;
  /** vendor:modelId currently in effect (resolved by the router) */
  resolved: string;
  /** the stored LLM_MODEL_* override, if the operator set one */
  override: string | null;
  /** optional tiers (escalation): no override means the tier is disabled */
  off?: boolean;
  encryptionReady: boolean;
};

function splitRef(ref: string): { vendor: Vendor; modelId: string } {
  const i = ref.indexOf(":");
  if (i > 0) {
    const v = ref.slice(0, i) as Vendor;
    if ((VENDORS as readonly string[]).includes(v)) return { vendor: v, modelId: ref.slice(i + 1) };
  }
  return { vendor: "openrouter", modelId: ref };
}

function TierRow({ card }: { card: TierCard }) {
  const start = card.off
    ? { vendor: "anthropic" as Vendor, modelId: "claude-opus-4-8" }
    : splitRef(card.override ?? card.resolved);
  const [vendor, setVendor] = useState<Vendor>(start.vendor);
  const [modelId, setModelId] = useState(start.modelId);
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    if (!modelId.trim()) return;
    setError(null);
    setSaved(false);
    startTransition(async () => {
      try {
        const fd = new FormData();
        fd.set("name", card.secretName);
        fd.set("value", `${vendor}:${modelId.trim()}`);
        await saveSecretAction(fd);
        setSaved(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  };

  const reset = () =>
    startTransition(async () => {
      try {
        await deleteSecretAction(card.secretName);
        setSaved(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h3>{card.label}</h3>
        {card.off ? (
          <span className="chip">Off — optional</span>
        ) : (
          <span className="chip good">
            <span className="d" />
            Active: {card.resolved}
          </span>
        )}
      </div>
      <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          {card.description}
          {card.override ? (
            <>
              {" "}
              <span className="mono">Override set: {card.override}</span>
            </>
          ) : (
            <> Using the built-in default.</>
          )}
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select
            value={vendor}
            onChange={(e) => setVendor(e.target.value as Vendor)}
            disabled={!card.encryptionReady}
            style={{ height: 36 }}
          >
            {VENDORS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <input
            list={`models-${card.tier}`}
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            placeholder="model id"
            disabled={!card.encryptionReady}
            style={{ minWidth: 220, height: 36 }}
          />
          <datalist id={`models-${card.tier}`}>
            {SUGGESTIONS[vendor].map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <button className="btn ghost sm" onClick={save} disabled={pending || !card.encryptionReady} style={{ height: 36 }}>
            {saved ? (
              <>
                <IconCheck /> Saved
              </>
            ) : (
              "Save"
            )}
          </button>
          {card.override && (
            <button className="btn ghost sm" onClick={reset} disabled={pending} style={{ height: 36 }}>
              <IconRefresh /> Reset to default
            </button>
          )}
        </div>
        {error && <p className="badge red" style={{ margin: 0 }}>{error}</p>}
      </div>
    </div>
  );
}

export function ModelPicker({ cards }: { cards: TierCard[] }) {
  return (
    <div>
      {cards.map((c) => (
        <TierRow key={c.tier} card={c} />
      ))}
      <div className="callout warn">
        <span>
          Model refs are vendor-prefixed (e.g. <span className="mono">qwen:qwen-max</span>,{" "}
          <span className="mono">anthropic:claude-opus-4-8</span>,{" "}
          <span className="mono">openrouter:qwen/qwen-max</span>). If you pick a vendor whose direct
          key isn&apos;t saved, the router falls back to the equivalent OpenRouter slug when an
          OpenRouter key exists — otherwise it drops to the built-in default. Changes apply within
          ~15 seconds, no redeploy.
        </span>
      </div>
    </div>
  );
}
