import { describe, expect, it } from "vitest";
import {
  SHORTS_CLAIM_BLOCK_THRESHOLD_SEC,
  publishesShorts,
  shortsClaimRisk,
} from "../src/shorts-claim-risk";

// The real assets this came from (#132).
const APHELION = { name: "Aphelion", contentIdRegistered: true, shortsBlocked: true, shortsBlockedNote: "Blocked 23NcugzXe_E on 2026-08-27.\nsecond line ignored" };
const REVERIE = { name: "Reverie", contentIdRegistered: true, shortsBlocked: false };
const UNREGISTERED = { name: "Some CC0 bed", contentIdRegistered: false, shortsBlocked: false };

describe("shortsClaimRisk", () => {
  it("LONG-FORM is never touched — a claim there monetises, it does not block", () => {
    for (const track of [APHELION, REVERIE, UNREGISTERED]) {
      expect(shortsClaimRisk({ contentFormat: "long", durationSec: 1800, track })).toBeNull();
    }
  });

  it("an OBSERVED Shorts block is a hard refusal on a shorts channel", () => {
    const risk = shortsClaimRisk({ contentFormat: "short", durationSec: 155, track: APHELION });
    expect(risk?.level).toBe("block");
    expect(risk?.reason).toContain("Aphelion");
    // the recorded evidence travels with the refusal, first line only
    expect(risk?.reason).toContain("Blocked 23NcugzXe_E on 2026-08-27.");
    expect(risk?.reason).not.toContain("second line ignored");
  });

  it("blocks regardless of duration — the track is known bad, don't gamble", () => {
    expect(shortsClaimRisk({ contentFormat: "short", durationSec: 30, track: APHELION })?.level).toBe("block");
    expect(shortsClaimRisk({ contentFormat: "short", durationSec: null, track: APHELION })?.level).toBe("block");
  });

  // The control that stopped this becoming a blanket ban on the whole catalogue:
  // Reverie published fine the day after the Phoenix cap.
  it("a registered-but-working track only WARNS — it must stay usable", () => {
    const risk = shortsClaimRisk({ contentFormat: "short", durationSec: 155, track: REVERIE });
    expect(risk?.level).toBe("warn");
    expect(risk?.reason).toContain("Reverie");
  });

  it("no claim fires at or under the 60s threshold", () => {
    expect(shortsClaimRisk({ contentFormat: "short", durationSec: SHORTS_CLAIM_BLOCK_THRESHOLD_SEC, track: REVERIE })).toBeNull();
    expect(shortsClaimRisk({ contentFormat: "short", durationSec: SHORTS_CLAIM_BLOCK_THRESHOLD_SEC + 1, track: REVERIE })?.level).toBe("warn");
  });

  it("an unknown duration on a shorts channel still warns", () => {
    expect(shortsClaimRisk({ contentFormat: "short", durationSec: null, track: REVERIE })?.level).toBe("warn");
  });

  it("an unregistered track carries no risk at all", () => {
    expect(shortsClaimRisk({ contentFormat: "short", durationSec: 155, track: UNREGISTERED })).toBeNull();
  });

  it("'both' channels publish Shorts, so they are covered", () => {
    expect(publishesShorts("both")).toBe(true);
    expect(publishesShorts("short")).toBe(true);
    expect(publishesShorts("long")).toBe(false);
    expect(publishesShorts(null)).toBe(false);
    expect(shortsClaimRisk({ contentFormat: "both", durationSec: 155, track: APHELION })?.level).toBe("block");
  });
});
