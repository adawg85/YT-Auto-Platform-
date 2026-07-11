"use client";

import { useState } from "react";
import { Disclosure, Stepper, Switch, Tile, TileGroup } from "@/components/ui";

/** Living reference for the #20 polish primitives (they're stateful, so the
 * demo is a small client island on the otherwise-server /design-system page). */
export function PolishPrimitivesDemo() {
  const [tile, setTile] = useState("a");
  const [on, setOn] = useState(true);
  const [n, setN] = useState(2);
  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <TileGroup>
          <Tile
            selected={tile === "a"}
            onSelect={() => setTile("a")}
            art={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="8" y="3" width="8" height="18" rx="2" />
              </svg>
            }
            title="Tile"
            subtitle="one-line consequence of picking it"
          />
          <Tile
            selected={tile === "b"}
            onSelect={() => setTile("b")}
            art={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="3" y="6" width="18" height="12" rx="2" />
              </svg>
            }
            title="Another tile"
            subtitle="tiles replace selects + segmented controls"
          />
        </TileGroup>
      </div>
      <Switch checked={on} onChange={setOn} label="Switch" hint="toggle-first replacement for checkboxes" />
      <Stepper
        label="Stepper"
        hint="numbers always carry a unit"
        value={n}
        onChange={setN}
        min={0}
        max={12}
        format={(v) => `${v} wk`}
      />
      <Disclosure summary="Disclosure — detail one click away">
        <span className="muted" style={{ fontSize: 12.5 }}>
          Explanations, advanced fields and long lists live behind one of these instead of sitting
          on the page.
        </span>
      </Disclosure>
    </div>
  );
}
