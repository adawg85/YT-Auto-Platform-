"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setCharacterCastModeAction, setCharacterCastTargetAction } from "../style-actions";

/**
 * Per-character casting frequency. How often the pipeline puts this character
 * in a shot:
 *  - "Every scene" — forces them into every generated shot (mascot)
 *  - "Smart %" — lands on ~N% of shots, chosen by importance (hero/named/opener
 *    beats first; diagrams and establishing filler stay character-free and ride
 *    the cheaper bulk engine — the credit-saving default, 2026-07-16)
 *  - "Auto" — leaves it to the agent (presenter bias); "Off" — never casts
 */
export function CharacterCastMode({
  channelId,
  characterId,
  value,
  target,
}: {
  channelId: string;
  characterId: string;
  value: string;
  target?: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [pct, setPct] = useState(target ?? 55);

  const saveTarget = (n: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(n)));
    setPct(clamped);
    startTransition(async () => {
      await setCharacterCastTargetAction(channelId, characterId, clamped);
      router.refresh();
    });
  };

  return (
    <div style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
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
          <option value="smart">Smart %</option>
          <option value="25">25% of shots</option>
          <option value="50">50% of shots</option>
          <option value="75">75% of shots</option>
          <option value="always">Every scene</option>
        </select>
      </label>
      {value === "smart" && (
        <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 11 }} className="muted">
          <input
            type="range"
            min={10}
            max={100}
            step={5}
            value={pct}
            disabled={pending}
            onChange={(e) => setPct(Number(e.target.value))}
            onPointerUp={(e) => saveTarget(Number((e.target as HTMLInputElement).value))}
            onKeyUp={(e) => saveTarget(Number((e.target as HTMLInputElement).value))}
            style={{ width: 96 }}
          />
          <span style={{ fontVariantNumeric: "tabular-nums", minWidth: 30 }}>{pct}%</span>
        </label>
      )}
    </div>
  );
}
