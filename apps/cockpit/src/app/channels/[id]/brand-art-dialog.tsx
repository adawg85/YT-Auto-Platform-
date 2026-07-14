"use client";

import { useState, useTransition } from "react";
import { Dialog } from "@/components/ui";

/**
 * Shared generate dialog for channel brand art (logo + banner, 2026-07-14
 * operator ask): shows the EXACT prompt (prefilled, editable in place) and a
 * Reference select that can anchor the art on a channel character, a style
 * test scene, or the current image — mirroring the production swap dialog so
 * brand art can stay consistent with the channel's cast and look.
 */
export type BrandArtOpts = {
  prompt?: string;
  characterId?: string;
  sceneId?: string;
  useCurrent?: boolean;
};

export function BrandArtDialog({
  open,
  onClose,
  title,
  currentUrl,
  defaultPrompt,
  references,
  wide = false,
  generate,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** current logo/banner, offered as the "keep composition" reference */
  currentUrl: string | null;
  defaultPrompt: string;
  references: { value: string; label: string }[];
  /** 16:9 preview (banner) instead of the square logo preview */
  wide?: boolean;
  generate: (opts: BrandArtOpts) => Promise<{ url: string; prompt: string } | { error: string }>;
  onDone: (url: string) => void;
}) {
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [refSel, setRefSel] = useState("none");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const run = () => {
    setError(null);
    setDone(false);
    startTransition(async () => {
      const opts: BrandArtOpts = { prompt: prompt.trim() || undefined };
      if (refSel === "current") opts.useCurrent = true;
      else if (refSel.startsWith("char:")) opts.characterId = refSel.slice(5);
      else if (refSel.startsWith("scene:")) opts.sceneId = refSel.slice(6);
      const res = await generate(opts);
      if ("error" in res) {
        setError(res.error);
        return;
      }
      // keep the FINAL prompt (character description included) for the next round
      setPrompt(res.prompt);
      setDone(true);
      onDone(res.url);
    });
  };

  return (
    <Dialog open={open} onClose={() => !pending && onClose()} title={title}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {currentUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={currentUrl}
            alt="Current art"
            style={{
              width: wide ? "100%" : 120,
              maxHeight: wide ? 220 : 120,
              objectFit: wide ? "cover" : "contain",
              aspectRatio: wide ? "16 / 9" : "1 / 1",
              borderRadius: 10,
              border: "1px solid var(--border)",
            }}
          />
        )}
        <div>
          <label className="field-label" htmlFor="brand-prompt">
            Prompt{" "}
            <span className="muted" style={{ fontWeight: 500 }}>
              — this exact text goes to the image model; edit it freely
            </span>
          </label>
          <textarea
            id="brand-prompt"
            rows={5}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>
        <div>
          <label className="field-label" htmlFor="brand-ref">
            Reference{" "}
            <span className="muted" style={{ fontWeight: 500 }}>— one per generation</span>
          </label>
          <select id="brand-ref" value={refSel} onChange={(e) => setRefSel(e.target.value)} style={{ height: 34 }}>
            <option value="none">None — fresh generation from the prompt</option>
            {currentUrl && <option value="current">Current image — rework it, keep the composition</option>}
            {references.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          {refSel.startsWith("char:") && (
            <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
              The character&apos;s canonical look leads the prompt and their reference sheet
              conditions the image — the art stays on-model with your cast.
            </p>
          )}
          {refSel.startsWith("scene:") && (
            <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
              The scene image conditions the generation — palette and style carry over.
            </p>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button type="button" className="btn" disabled={pending} onClick={run}>
            {pending ? "Generating…" : "Generate"}
          </button>
          <button type="button" className="btn ghost" disabled={pending} onClick={onClose}>
            Close
          </button>
          {done && !pending && (
            <span style={{ fontSize: 13 }}>Generated and set — tweak the prompt and go again, or close.</span>
          )}
        </div>
        {error && <div className="err">{error}</div>}
      </div>
    </Dialog>
  );
}
