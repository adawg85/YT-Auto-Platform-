import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUBCHANNEL_PUBLISH_TARGET,
  pickAuthChannelId,
  subchannelAuthChannelId,
  subchannelChannelFields,
  subchannelPublishTarget,
} from "../src/subchannel";

describe("subchannel publish-auth model", () => {
  describe("pickAuthChannelId", () => {
    it("resolves to self when the pointer is null (normal channel — unchanged)", () => {
      expect(pickAuthChannelId({ id: "ch_a", youtubeAuthChannelId: null })).toBe("ch_a");
    });

    it("resolves to the parent when the pointer is set (Mode 1)", () => {
      expect(pickAuthChannelId({ id: "sub_1", youtubeAuthChannelId: "ch_parent" })).toBe(
        "ch_parent",
      );
    });

    it("treats a self-referential pointer as own-auth (no loop)", () => {
      expect(pickAuthChannelId({ id: "ch_a", youtubeAuthChannelId: "ch_a" })).toBe("ch_a");
    });

    it("ignores a blank/whitespace pointer", () => {
      expect(pickAuthChannelId({ id: "ch_a", youtubeAuthChannelId: "   " })).toBe("ch_a");
    });
  });

  describe("subchannelAuthChannelId", () => {
    it("parent-youtube stores the parent id", () => {
      expect(
        subchannelAuthChannelId({ parentChannelId: "ch_parent", publishTarget: "parent-youtube" }),
      ).toBe("ch_parent");
    });

    it("own-youtube stores null (uses its own token)", () => {
      expect(
        subchannelAuthChannelId({ parentChannelId: "ch_parent", publishTarget: "own-youtube" }),
      ).toBeNull();
    });
  });

  describe("subchannelPublishTarget", () => {
    it("reads parent-youtube back from a parent pointer", () => {
      expect(subchannelPublishTarget({ id: "sub_1", youtubeAuthChannelId: "ch_parent" })).toBe(
        "parent-youtube",
      );
    });

    it("reads own-youtube back from a null pointer", () => {
      expect(subchannelPublishTarget({ id: "sub_1", youtubeAuthChannelId: null })).toBe(
        "own-youtube",
      );
    });

    it("a self pointer reads as own-youtube", () => {
      expect(subchannelPublishTarget({ id: "sub_1", youtubeAuthChannelId: "sub_1" })).toBe(
        "own-youtube",
      );
    });
  });

  describe("subchannelChannelFields", () => {
    it("defaults to parent-youtube (Shorts native to one channel)", () => {
      expect(DEFAULT_SUBCHANNEL_PUBLISH_TARGET).toBe("parent-youtube");
      expect(subchannelChannelFields({ parentChannelId: "ch_parent" })).toEqual({
        contentFormat: "short",
        derivedFromChannelId: "ch_parent",
        youtubeAuthChannelId: "ch_parent",
      });
    });

    it("own-youtube yields a separate-channel subchannel (null auth pointer)", () => {
      expect(
        subchannelChannelFields({ parentChannelId: "ch_parent", publishTarget: "own-youtube" }),
      ).toEqual({
        contentFormat: "short",
        derivedFromChannelId: "ch_parent",
        youtubeAuthChannelId: null,
      });
    });

    it("round-trips through subchannelPublishTarget", () => {
      const fields = subchannelChannelFields({ parentChannelId: "ch_parent" });
      expect(
        subchannelPublishTarget({ id: "sub_1", youtubeAuthChannelId: fields.youtubeAuthChannelId }),
      ).toBe("parent-youtube");
    });
  });
});
