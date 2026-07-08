"use client";

import { useState } from "react";
import { updateCharterObjectivesAction } from "../editorial-actions";

/**
 * Editable charter objectives/targets (BACKLOG #17). The charter drafter's
 * targets (e.g. "reach 10k subscribers and 4000 watch hours in 12 months") were
 * read-only text; the operator can now edit them (one per line) and persist.
 */
export function CharterObjectives({
  channelId,
  objectives,
}: {
  channelId: string;
  objectives: string[];
}) {
  const [editing, setEditing] = useState(false);

  if (!editing) {
    return (
      <div>
        <ul className="muted" style={{ margin: "0.4rem 0", paddingLeft: "1.1rem" }}>
          {objectives.length ? (
            objectives.map((o) => <li key={o}>{o}</li>)
          ) : (
            <li>No objectives set yet.</li>
          )}
        </ul>
        <button type="button" className="btn ghost" onClick={() => setEditing(true)}>
          Edit targets
        </button>
      </div>
    );
  }

  return (
    <form
      action={updateCharterObjectivesAction.bind(null, channelId)}
      onSubmit={() => setEditing(false)}
      style={{ margin: "0.4rem 0" }}
    >
      <textarea
        name="objectives"
        rows={Math.max(4, objectives.length + 1)}
        defaultValue={objectives.join("\n")}
        style={{ width: "100%" }}
      />
      <p className="muted" style={{ fontSize: 12, margin: "4px 0 8px" }}>
        One target per line — e.g. &ldquo;Reach 25,000 subscribers in 12 months&rdquo;. Make them as
        aggressive as you like.
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" className="btn">
          Save targets
        </button>
        <button type="button" className="btn ghost" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
