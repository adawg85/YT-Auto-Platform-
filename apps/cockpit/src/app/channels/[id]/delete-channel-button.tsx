"use client";

import { useState, useTransition } from "react";
import { Dialog } from "@/components/ui";
import { deleteChannelAction } from "../actions";

/**
 * Danger-zone delete with a confirm modal (the app's first real use of the
 * Dialog primitive). The server action deletes every child row and redirects
 * to /channels, so a success just navigates away.
 */
export function DeleteChannelButton({
  channelId,
  channelName,
}: {
  channelId: string;
  channelName: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const confirm = () => {
    setError(null);
    startTransition(async () => {
      try {
        await deleteChannelAction(channelId);
      } catch (e) {
        // a redirect throws a Next control-flow signal we must not swallow
        if (e && typeof e === "object" && "digest" in e && String((e as { digest?: string }).digest).startsWith("NEXT_REDIRECT")) {
          throw e;
        }
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  };

  return (
    <>
      <button className="btn ghost danger-ink" onClick={() => setOpen(true)}>
        Delete channel
      </button>
      <Dialog
        open={open}
        onClose={() => (pending ? null : setOpen(false))}
        title="Delete this channel?"
        footer={
          <>
            <button className="btn ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </button>
            <button className="btn danger" onClick={confirm} disabled={pending}>
              {pending ? "Deleting…" : "Delete permanently"}
            </button>
          </>
        }
      >
        <p>
          <strong>{channelName}</strong> and everything under it — charter, DNA, ideas, productions,
          publications, sources, briefings and history — will be permanently deleted. This cannot be
          undone.
        </p>
        {error && <p className="badge red">{error}</p>}
      </Dialog>
    </>
  );
}
