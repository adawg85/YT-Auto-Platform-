"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@/components/ui";
import { generateThumbnailStudioAction, refineThumbnailAction } from "../../actions";
import { THUMB_FORMATS, composeThumbnailPrompt, type ThumbSpec } from "./thumbnail-compose";

type Ref = { value: string; label: string; description?: string };

/**
 * Thumbnail studio (2026-07-15 operator ask): pick a best-practice FORMAT,
 * toggle the TITLE text (auto-shortened, editable), inject a character/scene
 * reference, and see the exact composed prompt — mirrors the brand-art dialog.
 */
export function ThumbnailStudio({
  productionId,
  references,
  title,
  titleAuto,
  isLong,
  styleBlock,
  imageStyle,
}: {
  productionId: string;
  references: Ref[];
  title: string;
  titleAuto: string;
  isLong: boolean;
  styleBlock: string | null;
  imageStyle: string | null;
}) {
  const router = useRouter();
  const [format, setFormat] = useState<string>("subject_text");
  const [includeTitle, setIncludeTitle] = useState(true);
  const [titleText, setTitleText] = useState(titleAuto);
  const [refSel, setRefSel] = useState("none");
  const [extra, setExtra] = useState("");
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const charRef = refSel.startsWith("char:") ? references.find((r) => r.value === refSel) : undefined;
  const preview = useMemo(() => {
    const spec: ThumbSpec = {
      title,
      angle: "",
      isLong,
      format,
      includeTitle,
      titleText: includeTitle ? titleText : null,
      character: charRef
        ? { name: charRef.label.replace(/^Character:\s*/, ""), description: charRef.description ?? "" }
        : null,
      sceneRef: refSel.startsWith("scene:"),
      styleBlock,
      imageStyle,
      extra,
    };
    return composeThumbnailPrompt(spec);
  }, [title, isLong, format, includeTitle, titleText, charRef, refSel, styleBlock, imageStyle, extra]);

  const run = () => {
    setError(null);
    setMsg(null);
    startTransition(async () => {
      const opts: Parameters<typeof generateThumbnailStudioAction>[1] = {
        format,
        includeTitle,
        ...(includeTitle && titleText.trim() ? { titleText: titleText.trim() } : {}),
        ...(extra.trim() ? { extra: extra.trim() } : {}),
      };
      if (refSel.startsWith("char:")) opts.characterId = refSel.slice(5);
      else if (refSel.startsWith("scene:")) opts.sceneId = refSel.slice(6);
      const res = await generateThumbnailStudioAction(productionId, opts);
      if (res.error) {
        setError(res.error);
        return;
      }
      setMsg(res.warning ? `⚠ ${res.warning}` : "Added a new thumbnail below.");
      router.refresh();
    });
  };

  return (
    <div style={{ marginTop: 14 }}>
      <span className="field-label">Design a new thumbnail</span>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
        {THUMB_FORMATS.map((f) => (
          <button
            key={f.value}
            type="button"
            className={`btn ghost sm${format === f.value ? " on" : ""}`}
            aria-pressed={format === f.value}
            onClick={() => setFormat(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, cursor: "pointer" }}>
          <input type="checkbox" checked={includeTitle} onChange={(e) => setIncludeTitle(e.target.checked)} />
          Title text
        </label>
        {includeTitle && (
          <input
            type="text"
            value={titleText}
            onChange={(e) => setTitleText(e.target.value)}
            placeholder="Overlay words (1–3)"
            style={{ height: 30, fontSize: 13, flex: "1 1 180px", minWidth: 140 }}
          />
        )}
      </div>

      {references.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <label className="field-label" htmlFor="thumb-ref">
            Include a reference{" "}
            <span className="muted" style={{ fontWeight: 500 }}>— a character featured, or a scene for palette</span>
          </label>
          <select id="thumb-ref" value={refSel} onChange={(e) => setRefSel(e.target.value)} style={{ height: 34 }}>
            <option value="none">None</option>
            {references.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <div style={{ marginTop: 10 }}>
        <label className="field-label" htmlFor="thumb-extra">
          Extra direction <span className="muted" style={{ fontWeight: 500 }}>— optional</span>
        </label>
        <textarea
          id="thumb-extra"
          rows={2}
          placeholder="e.g. glowing neon sign at night, electric blue and magenta, dramatic rim light"
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
        />
      </div>

      <details style={{ marginTop: 8 }}>
        <summary className="muted" style={{ cursor: "pointer", fontSize: 12.5 }}>
          Final prompt — exactly what goes to the image model
        </summary>
        <p
          className="muted"
          style={{
            margin: "6px 0 0",
            fontSize: 12,
            whiteSpace: "pre-wrap",
            maxHeight: 150,
            overflowY: "auto",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "6px 8px",
          }}
        >
          {preview}
        </p>
      </details>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
        <button type="button" className="btn" disabled={pending} onClick={run}>
          {pending ? "Generating…" : "Generate thumbnail"}
        </button>
        {msg && <span className="muted" style={{ fontSize: 12.5 }}>{msg}</span>}
      </div>
      {error && <div className="err">{error}</div>}
    </div>
  );
}

/**
 * Per-candidate "Tweak" — small edits on a chosen thumbnail (nano edit path),
 * optionally injecting a character. Adds a new candidate to compare.
 */
export function ThumbnailTweak({
  productionId,
  thumbnailId,
  references,
}: {
  productionId: string;
  thumbnailId: string;
  references: Ref[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [changes, setChanges] = useState("");
  const [charSel, setCharSel] = useState("none");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const characters = references.filter((r) => r.value.startsWith("char:"));

  const run = () =>
    startTransition(async () => {
      setError(null);
      setWarning(null);
      const res = await refineThumbnailAction(productionId, thumbnailId, {
        changes: changes.trim(),
        ...(charSel.startsWith("char:") ? { characterId: charSel.slice(5) } : {}),
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      if (res.warning) setWarning(res.warning);
      setDone(true);
      router.refresh();
    });

  return (
    <>
      <button
        type="button"
        className="btn ghost sm"
        style={{ padding: "2px 8px", fontSize: 11 }}
        onClick={(e) => {
          // inside the pick <label> — don't also toggle its radio
          e.preventDefault();
          e.stopPropagation();
          setChanges("");
          setCharSel("none");
          setError(null);
          setWarning(null);
          setDone(false);
          setOpen(true);
        }}
      >
        Tweak
      </button>
      <Dialog open={open} onClose={() => !pending && setOpen(false)} title="Tweak this thumbnail">
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label className="field-label" htmlFor={`tw-${thumbnailId}`}>
              What to change{" "}
              <span className="muted" style={{ fontWeight: 500 }}>— small edits; everything else stays the same</span>
            </label>
            <textarea
              id={`tw-${thumbnailId}`}
              rows={3}
              placeholder="e.g. brighter neon, bigger text, move the subject left"
              value={changes}
              onChange={(e) => setChanges(e.target.value)}
            />
          </div>
          {characters.length > 0 && (
            <div>
              <label className="field-label" htmlFor={`tw-char-${thumbnailId}`}>
                Add a character <span className="muted" style={{ fontWeight: 500 }}>— optional</span>
              </label>
              <select id={`tw-char-${thumbnailId}`} value={charSel} onChange={(e) => setCharSel(e.target.value)} style={{ height: 34 }}>
                <option value="none">None</option>
                {characters.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" className="btn" disabled={pending || !changes.trim()} onClick={run}>
              {pending ? "Generating…" : "Tweak"}
            </button>
            <button type="button" className="btn ghost" disabled={pending} onClick={() => setOpen(false)}>
              Close
            </button>
            {done && !pending && !warning && <span style={{ fontSize: 13 }}>Added a new candidate below.</span>}
          </div>
          {warning && <div className="err" style={{ background: "var(--warn-bg, #fff7ed)" }}>⚠ {warning}</div>}
          {error && <div className="err">{error}</div>}
        </div>
      </Dialog>
    </>
  );
}
