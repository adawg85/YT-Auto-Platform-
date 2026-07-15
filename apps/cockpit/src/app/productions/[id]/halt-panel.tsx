"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@/components/ui";
import { haltProductionAction, type HaltDiscard } from "../../actions";
import { IconAlertTriangle, IconInbox } from "@/components/icons";

type Artifact = { key: HaltDiscard; label: string; detail: string };

/**
 * Halt a production from any stage and hand its idea back to the greenlightable
 * pool. The operator ticks which produced artifacts to keep on the draft; the
 * unticked ones are discarded. Kept artifacts stay attached for a future resume.
 */
export function HaltPanel({
  productionId,
  artifacts,
}: {
  productionId: string;
  artifacts: Artifact[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [keep, setKeep] = useState<Record<string, boolean>>(
    () => Object.fromEntries(artifacts.map((a) => [a.key, true])),
  );
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const confirm = () => {
    setError(null);
    const discard = artifacts.map((a) => a.key).filter((k) => !keep[k]);
    startTransition(async () => {
      try {
        await haltProductionAction(productionId, discard);
        setOpen(false);
        router.push("/ideas");
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  };

  return (
    <>
      <button type="button" className="btn ghost danger-ink" onClick={() => setOpen(true)}>
        <IconInbox /> Halt &amp; return to ideas
      </button>

      <Dialog
        open={open}
        onClose={() => !pending && setOpen(false)}
        title="Halt production"
        footer={
          <>
            <button type="button" className="btn ghost" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="button" className="btn danger" disabled={pending} onClick={confirm}>
              {pending ? "Halting…" : "Halt & return idea"}
            </button>
          </>
        }
      >
        <p className="muted" style={{ margin: "0 0 12px", fontSize: 13 }}>
          Stops this production wherever it is and returns its idea to the greenlightable pool. The
          production is kept as a draft — pick which artifacts to keep on it. Anything unticked is
          discarded.
        </p>

        {artifacts.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {artifacts.map((a) => (
              <label
                key={a.key}
                className="card"
                style={{ display: "flex", gap: 10, alignItems: "center", cursor: "pointer", padding: "10px 12px" }}
              >
                <input
                  type="checkbox"
                  checked={keep[a.key] ?? true}
                  onChange={(e) => setKeep((k) => ({ ...k, [a.key]: e.target.checked }))}
                />
                <span>
                  <span style={{ fontWeight: 600 }}>Keep {a.label}</span>
                  <span className="muted" style={{ display: "block", fontSize: 12 }}>
                    {a.detail}
                    {a.key === "images" && (
                      <>
                        {" "}Kept images are reused on re-run — to pick up a new style guide or
                        character, untick this (or use &ldquo;Retry from visuals&rdquo;).
                      </>
                    )}
                  </span>
                </span>
              </label>
            ))}
          </div>
        ) : (
          <div className="callout">
            <IconAlertTriangle />
            <span>Nothing produced yet — the idea just returns to the pool.</span>
          </div>
        )}

        {error && <div className="err" style={{ marginTop: 12 }}>{error}</div>}
      </Dialog>
    </>
  );
}
