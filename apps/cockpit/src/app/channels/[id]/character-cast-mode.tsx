"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { setCharacterCastModeAction } from "../style-actions";

/**
 * Per-character casting frequency (2026-07-15 mascot channels): how often the
 * pipeline puts this character in a shot. "Every scene" forces them into every
 * generated shot (mascot); "Auto" leaves it to the agent (presenter bias);
 * "Off" never casts them.
 */
export function CharacterCastMode({
  channelId,
  characterId,
  value,
}: {
  channelId: string;
  characterId: string;
  value: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <label style={{ display: "inline-flex", gap: 4, alignItems: "center", fontSize: 11 }} className="muted">
      Appears:
      <select
        value={value}
        disabled={pending}
        style={{ height: 26, fontSize: 11 }}
        onChange={(e) =>
          startTransition(async () => {
            await setCharacterCastModeAction(channelId, characterId, e.target.value);
            router.refresh();
          })
        }
      >
        {/* values mirror core CHARACTER_CAST_MODES — inlined because this is a
            client component and core's barrel pulls node:crypto */}
        <option value="off">Off</option>
        <option value="auto">Auto</option>
        <option value="25">25% of shots</option>
        <option value="50">50% of shots</option>
        <option value="75">75% of shots</option>
        <option value="always">Every scene</option>
      </select>
    </label>
  );
}
