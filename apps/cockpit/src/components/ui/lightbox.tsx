"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { IconExpand, IconX } from "../icons";

/** Full-size image overlay: ESC or click-out to close (BACKLOG #20 lightbox). */
export function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={alt} onClick={onClose}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} onClick={(e) => e.stopPropagation()} />
      <button type="button" className="icon-btn lightbox-close" aria-label="Close" onClick={onClose}>
        <IconX />
      </button>
    </div>,
    document.body,
  );
}

/**
 * An image that expands to a full-size lightbox on click. Drop-in for pipeline
 * image surfaces (beat visuals, thumbnails, briefs) — the wrapper button keeps
 * the surrounding CSS working because the <img> stays a descendant.
 */
export function ZoomImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        type="button"
        className={className ? `zoomable ${className}` : "zoomable"}
        onClick={() => setOpen(true)}
        aria-label={`Expand: ${alt}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} />
      </button>
      {open && <Lightbox src={src} alt={alt} onClose={close} />}
    </>
  );
}

/**
 * A small expand affordance for images whose click already means something
 * else (e.g. the thumbnail picker, where clicking selects). Opens the lightbox
 * without triggering the parent label/button.
 */
export function ZoomButton({ src, alt }: { src: string; alt: string }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        type="button"
        className="icon-btn zoom-btn"
        aria-label={`Expand: ${alt}`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <IconExpand />
      </button>
      {open && <Lightbox src={src} alt={alt} onClose={close} />}
    </>
  );
}
