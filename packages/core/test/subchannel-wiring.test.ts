import { describe, expect, it } from "vitest";
import {
  validateSubchannelParent,
  subchannelAuthChannelId,
  subchannelPublishTarget,
  DEFAULT_SUBCHANNEL_PUBLISH_TARGET,
} from "../src/subchannel";
import {
  resolveLengthPolicy,
  reviewRuntimeFit,
  MIDROLL_FLOOR_SEC,
  SHORT_CEILING_SEC,
  SHORT_LENGTH_BANDS,
} from "../src/length-policy";
import { lengthPolicyFloorWarnings } from "../src/dna-consistency";

const parentRow = (id: string, derivedFrom: string | null = null) => ({
  id,
  derivedFromChannelId: derivedFrom,
  status: "active",
});

describe("validateSubchannelParent (#104) — the pointer is checked before it's stored", () => {
  it("accepts a real, top-level parent", () => {
    expect(
      validateSubchannelParent({ childId: "sub_1", parentId: "ch_parent", parent: parentRow("ch_parent") }),
    ).toBeNull();
  });

  it("rejects a parent that doesn't exist, and says where to find the id", () => {
    const err = validateSubchannelParent({ childId: "sub_1", parentId: "ch_nope", parent: null });
    expect(err).toMatch(/not a channel/);
    expect(err).toMatch(/list_channels/);
  });

  it("REJECTS nesting — publish-auth resolves one hop, so a chain uploads to the wrong account", () => {
    const err = validateSubchannelParent({
      childId: "sub_2",
      parentId: "sub_1",
      parent: parentRow("sub_1", "ch_parent"),
    });
    expect(err).toMatch(/ITSELF a subchannel/);
    expect(err).toMatch(/one hop/);
  });

  it("rejects a self-referential parent", () => {
    expect(
      validateSubchannelParent({ childId: "ch_a", parentId: "ch_a", parent: parentRow("ch_a") }),
    ).toMatch(/cannot be its own parent/);
  });

  it("rejects turning a channel that HAS subchannels into one", () => {
    expect(
      validateSubchannelParent({
        childId: "ch_mid",
        parentId: "ch_top",
        parent: parentRow("ch_top"),
        childHasChildren: true,
      }),
    ).toMatch(/already has subchannels/);
  });

  it("a parent whose pointer is self-referential is still a valid top-level parent", () => {
    // pickAuthChannelId treats a self-pointer as "no pointer"; validation agrees
    expect(
      validateSubchannelParent({ childId: "sub_1", parentId: "ch_a", parent: parentRow("ch_a", "ch_a") }),
    ).toBeNull();
  });

  it("the default publish target round-trips to the parent's token", () => {
    const auth = subchannelAuthChannelId({
      parentChannelId: "ch_parent",
      publishTarget: DEFAULT_SUBCHANNEL_PUBLISH_TARGET,
    });
    expect(auth).toBe("ch_parent");
    expect(subchannelPublishTarget({ id: "sub_1", youtubeAuthChannelId: auth })).toBe("parent-youtube");
  });
});

describe("short-form length policy (#104) — a Shorts channel has no mid-roll floor", () => {
  it("long-form defaults are unchanged", () => {
    const p = resolveLengthPolicy(null);
    expect(p.floorSec).toBe(MIDROLL_FLOOR_SEC);
    expect(p.ceilingSec).toBe(2400);
  });

  it("a short channel resolves to no floor, a 3-minute ceiling and short bands", () => {
    const p = resolveLengthPolicy(null, { contentFormat: "short" });
    expect(p.floorSec).toBe(0);
    expect(p.ceilingSec).toBe(SHORT_CEILING_SEC);
    expect(p.bands).toEqual(SHORT_LENGTH_BANDS);
  });

  it("THE REPORTED CASE: an inherited 480s floor is dropped, not advised against", () => {
    // the parent's hard 8-min floor copied onto a Shorts subchannel could never be
    // cleared — every Short reported as below the channel's own hard floor
    const p = resolveLengthPolicy({ floorSec: 480 }, { contentFormat: "short" });
    expect(p.floorSec).toBe(0);
    expect(reviewRuntimeFit(p, { runtimeSec: 120, beatCount: 8, words: 350 }).map((a) => a.rule)).not.toContain(
      "below_midroll_floor",
    );
    expect(lengthPolicyFloorWarnings(120, p)).toEqual([]);
  });

  it("a floor deliberately set WITHIN short-form range is kept and still advises", () => {
    const p = resolveLengthPolicy({ floorSec: 30 }, { contentFormat: "short" });
    expect(p.floorSec).toBe(30);
    expect(reviewRuntimeFit(p, { runtimeSec: 20, beatCount: 3, words: 50 }).map((a) => a.rule)).toContain(
      "below_midroll_floor",
    );
  });

  it("a long-form channel still gets the hard floor advisory — nothing was loosened there", () => {
    const p = resolveLengthPolicy(null, { contentFormat: "long" });
    expect(p.floorSec).toBe(MIDROLL_FLOOR_SEC);
    expect(reviewRuntimeFit(p, { runtimeSec: 120, beatCount: 8, words: 350 }).map((a) => a.rule)).toContain(
      "below_midroll_floor",
    );
  });

  it("a 2-minute Short lands inside a declared band, so the band warning stays quiet too", () => {
    const p = resolveLengthPolicy(null, { contentFormat: "short" });
    expect(lengthPolicyFloorWarnings(120, p)).toEqual([]);
  });
});
