"use client";

import { useMemo, useState, useTransition } from "react";
import { Dialog } from "@/components/ui";
import { composeBrandArtPrompt, type BrandArtSpec } from "../brand-prompts";

/**
 * Shared generate dialog for channel brand art (logo + banner). v2
 * (2026-07-15 operator ask): the standard choices are TICKS — channel name,
 * tagline, background clear/styled, match the style guide — with a small
 * free-text field for direction, and the final prompt is COMPOSED by the
 * same pure function the server uses, previewed live. References are used
 * IN the art (character = one element, scene = palette/mood, current =
 * rework) — never AS the art; the old free-prompt flow re-prefixed a cast
 * character's whole description and the logo became the character.
 */
export type BrandArtOpts = {
  mode?: "generate" | "refine";
  changes?: string;
  includeName?: boolean;
  tagline?: string;
  background?: "clear" | "styled" | "keep";
  alignStyle?: boolean;
  extra?: string;
  characterId?: string;
  sceneId?: string;
  useCurrent?: boolean;
};

export function BrandArtDialog({
  open,
  onClose,
  title,
  surface,
  mode = "generate",
  channelName,
  niche,
  imageStyle,
  styleBlock,
  taglineDefault,
  currentUrl,
  references,
  generate,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  surface: "logo" | "banner";
  /** "refine" = small edits on the CURRENT art (always the base image) */
  mode?: "generate" | "refine";
  channelName: string;
  niche: string;
  /** wizard-era free text — fallback style when no guide / align off */
  imageStyle: string | null;
  /** ACTIVE style guide block; null when no guide is active */
  styleBlock: string | null;
  /** last-used tagline (persisted on the DNA) */
  taglineDefault: string | null;
  /** current logo/banner, offered as the "rework" reference */
  currentUrl: string | null;
  references: { value: string; label: string; description?: string }[];
  generate: (opts: BrandArtOpts) => Promise<{ url: string; prompt: string } | { error: string }>;
  onDone: (url: string) => void;
}) {
  const refine = mode === "refine";
  const [changes, setChanges] = useState("");
  const [includeName, setIncludeName] = useState(false);
  const [useTagline, setUseTagline] = useState(false);
  const [tagline, setTagline] = useState(taglineDefault ?? "");
  const [background, setBackground] = useState<"clear" | "styled" | "keep">(
    refine ? "keep" : surface === "logo" ? "clear" : "styled",
  );
  const [alignStyle, setAlignStyle] = useState(!refine);
  const [extra, setExtra] = useState("");
  const [refSel, setRefSel] = useState("none");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // live preview — the SAME composer the server runs, so this is exact
  const preview = useMemo(() => {
    const charRef = refSel.startsWith("char:") ? references.find((r) => r.value === refSel) : undefined;
    const spec: BrandArtSpec = {
      surface,
      name: channelName,
      niche,
      mode,
      changes,
      includeName,
      tagline: useTagline ? tagline : null,
      background,
      alignStyle,
      imageStyle,
      styleBlock,
      character: charRef
        ? { name: charRef.label.replace(/^Character:\s*/, ""), description: charRef.description ?? "" }
        : null,
      sceneRef: refSel.startsWith("scene:"),
      currentRef: refSel === "current",
      extra,
    };
    return composeBrandArtPrompt(spec);
  }, [surface, mode, changes, channelName, niche, includeName, useTagline, tagline, background, alignStyle, imageStyle, styleBlock, refSel, references, extra]);

  const run = () => {
    setError(null);
    setDone(false);
    startTransition(async () => {
      const opts: BrandArtOpts = {
        mode,
        ...(refine && changes.trim() ? { changes: changes.trim() } : {}),
        includeName,
        ...(useTagline && tagline.trim() ? { tagline: tagline.trim() } : {}),
        background,
        alignStyle,
        ...(extra.trim() ? { extra: extra.trim() } : {}),
      };
      if (refSel === "current") opts.useCurrent = true;
      else if (refSel.startsWith("char:")) opts.characterId = refSel.slice(5);
      else if (refSel.startsWith("scene:")) opts.sceneId = refSel.slice(6);
      const res = await generate(opts);
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setDone(true);
      onDone(res.url);
    });
  };

  const check = (checked: boolean, set: (v: boolean) => void, label: string, id: string) => (
    <label htmlFor={id} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, cursor: "pointer" }}>
      <input id={id} type="checkbox" checked={checked} onChange={(e) => set(e.target.checked)} />
      {label}
    </label>
  );

  return (
    <Dialog open={open} onClose={() => !pending && onClose()} title={title}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {currentUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={currentUrl}
            alt="Current art"
            style={{
              width: surface === "banner" ? "100%" : 96,
              maxHeight: surface === "banner" ? 180 : 96,
              objectFit: surface === "banner" ? "cover" : "contain",
              aspectRatio: surface === "banner" ? "16 / 9" : "1 / 1",
              borderRadius: 10,
              border: "1px solid var(--border)",
            }}
          />
        )}

        {refine && (
          <div>
            <label className="field-label" htmlFor="ba-changes">
              What to change{" "}
              <span className="muted" style={{ fontWeight: 500 }}>
                — small edits; everything you don&apos;t mention stays the same
              </span>
            </label>
            <textarea
              id="ba-changes"
              rows={3}
              placeholder="e.g. make the pendulum brass instead of silver, thicken the outline"
              value={changes}
              onChange={(e) => setChanges(e.target.value)}
            />
          </div>
        )}

        <div>
          <span className="field-label">{refine ? "Add" : "Include"}</span>
          <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", marginTop: 2 }}>
            {check(includeName, setIncludeName, "Channel name", "ba-name")}
            {check(useTagline, setUseTagline, "Tagline", "ba-tag")}
            {useTagline && (
              <input
                type="text"
                placeholder="e.g. Physics you can feel"
                value={tagline}
                onChange={(e) => setTagline(e.target.value)}
                style={{ height: 30, fontSize: 13, flex: "1 1 180px", minWidth: 140 }}
              />
            )}
          </div>
        </div>

        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <span className="field-label">Background</span>
            <div className="seg" style={{ marginTop: 2 }}>
              {refine && (
                <button type="button" className={background === "keep" ? "on" : ""} onClick={() => setBackground("keep")}>
                  Keep
                </button>
              )}
              <button type="button" className={background === "clear" ? "on" : ""} onClick={() => setBackground("clear")}>
                Clear
              </button>
              <button type="button" className={background === "styled" ? "on" : ""} onClick={() => setBackground("styled")}>
                Styled
              </button>
            </div>
          </div>
          {styleBlock && (
            <div style={{ paddingTop: 18 }}>
              {check(alignStyle, setAlignStyle, "Match style guide", "ba-style")}
            </div>
          )}
        </div>

        <div>
          <label className="field-label" htmlFor="ba-ref">
            {refine ? "Add to the art" : "Use in the art"}{" "}
            <span className="muted" style={{ fontWeight: 500 }}>— an element inside the design, never the whole image</span>
          </label>
          <select id="ba-ref" value={refSel} onChange={(e) => setRefSel(e.target.value)} style={{ height: 34 }}>
            <option value="none">{refine ? "Nothing — just the edits above" : "Nothing — fresh generation"}</option>
            {!refine && currentUrl && (
              <option value="current">Current image — rework it, keep the composition</option>
            )}
            {references.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>

        {!refine && (
          <div>
            <label className="field-label" htmlFor="ba-extra">
              Extra direction <span className="muted" style={{ fontWeight: 500 }}>— optional</span>
            </label>
            <textarea
              id="ba-extra"
              rows={2}
              placeholder="e.g. pendulum motif front and center, warm amber accent"
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
            />
          </div>
        )}

        <details>
          <summary style={{ cursor: "pointer", fontSize: 12.5 }} className="muted">
            Final prompt — exactly what goes to the image model
          </summary>
          <p
            id={`ba-preview-${surface}`}
            className="muted"
            style={{
              margin: "6px 0 0",
              fontSize: 12,
              whiteSpace: "pre-wrap",
              maxHeight: 160,
              overflowY: "auto",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "6px 8px",
            }}
          >
            {preview}
          </p>
        </details>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn"
            disabled={pending || (refine && !changes.trim())}
            title={refine && !changes.trim() ? "Describe what to change first" : undefined}
            onClick={run}
          >
            {pending ? "Generating…" : refine ? "Refine" : "Generate"}
          </button>
          <button type="button" className="btn ghost" disabled={pending} onClick={onClose}>
            Close
          </button>
          {done && !pending && (
            <span style={{ fontSize: 13 }}>Generated and set — adjust and go again, or close.</span>
          )}
        </div>
        {error && <div className="err">{error}</div>}
      </div>
    </Dialog>
  );
}
