"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@/components/ui/dialog";
import { IconSparkle } from "@/components/icons";
import { refineChannelCharacterAction } from "../style-actions";

/**
 * "Refine…" on a character card (2026-07-14 operator ask): comments go to the
 * image model WITH the current image as the edit reference, and the canonical
 * description is revised to match — look and prompts stay in sync.
 */
export function CharacterRefine({ channelId, characterId, name }: { channelId: string; characterId: string; name: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (pending) return;
    setOpen(false);
    setNote("");
    setError(null);
  };

  const run = () =>
    startTransition(async () => {
      setError(null);
      const res = await refineChannelCharacterAction(channelId, characterId, note);
      if ("error" in res) {
        setError(res.error);
        return;
      }
      router.refresh();
      setOpen(false);
      setNote("");
    });

  return (
    <>
      <button type="button" className="btn ghost sm" style={{ padding: "2px 8px", fontSize: 11 }} onClick={() => setOpen(true)}>
        Refine…
      </button>
      <Dialog open={open} onClose={close} title={`Refine — ${name}`}>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          Your comments go to the image model together with the current image as the reference —
          the character stays the same person, your changes apply, and the canonical look
          description updates to match so future videos render the new look.
        </p>
        <label className="field-label" htmlFor={`char-refine-${characterId}`}>
          Changes to make
        </label>
        <textarea
          id={`char-refine-${characterId}`}
          rows={3}
          placeholder='e.g. "Swap the blazer for a red lab coat, add safety goggles pushed up on the forehead."'
          value={note}
          onChange={(ev) => setNote(ev.target.value)}
          disabled={pending}
        />
        <div className="actions" style={{ marginTop: 12 }}>
          <button type="button" className="btn" disabled={pending || !note.trim()} onClick={run}>
            <IconSparkle /> Regenerate
          </button>
          <button type="button" className="btn ghost" disabled={pending} onClick={close}>
            Cancel
          </button>
          {pending && (
            <span className="muted" style={{ fontSize: 12.5 }}>
              Reworking the reference sheet…
            </span>
          )}
        </div>
        {error && <div className="err">{error}</div>}
      </Dialog>
    </>
  );
}
