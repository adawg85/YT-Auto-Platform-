"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { syncPublicationFromYouTubeAction } from "../../actions";
import { IconUpload } from "@/components/icons";

/**
 * "I published this myself" (2026-08-05).
 *
 * Uploading by hand is a legitimate, recurring path: an unverified channel
 * can't take a custom thumbnail through the API, and a long-form upload can die
 * on the worker. Before this, a production in that state had a publication row
 * with no providerVideoId and simply sat at `scheduled` forever — invisible to
 * analytics, flagged by get_diagnostics as a stuck upload, and recoverable only
 * through the sync_publication_from_youtube MCP tool.
 *
 * Paste the link and the record reattaches: YouTube's real publishedAt is
 * pulled (never a stale future slot), the video is marked live, and analytics
 * ingest is re-triggered so the missed window is collected.
 */
export function ExternalUploadPanel({ productionId }: { productionId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const submit = () => {
    setMsg(null);
    setErr(null);
    startTransition(async () => {
      const res = await syncPublicationFromYouTubeAction(productionId, value);
      if (res.error) {
        setErr(res.error);
        return;
      }
      setMsg(res.note ?? "Linked.");
      setValue("");
      router.refresh();
    });
  };

  return (
    <div className="card" style={{ marginTop: 10 }}>
      <h3 style={{ margin: "0 0 4px", fontSize: 14 }}>Published it yourself?</h3>
      <p className="muted" style={{ margin: "0 0 10px", fontSize: 12.5 }}>
        If you uploaded this video to YouTube by hand, paste its link here. The platform will
        attach it, take YouTube&apos;s real publish date, and start collecting analytics — so it
        stops sitting here as an unfinished upload.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="text"
          value={value}
          disabled={pending}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim() && !pending) submit();
          }}
          placeholder="https://www.youtube.com/watch?v=…"
          style={{ flex: 1, minWidth: 240 }}
          aria-label="YouTube video link"
        />
        <button
          type="button"
          className="btn sm"
          disabled={pending || !value.trim()}
          onClick={submit}
        >
          <IconUpload /> {pending ? "Linking…" : "Link this video"}
        </button>
      </div>
      {err && (
        <p className="muted" style={{ margin: "8px 0 0", fontSize: 12.5, color: "var(--crit)" }}>
          {err}
        </p>
      )}
      {msg && <p className="muted" style={{ margin: "8px 0 0", fontSize: 12.5 }}>{msg}</p>}
    </div>
  );
}
