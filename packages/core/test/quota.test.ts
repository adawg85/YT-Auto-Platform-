import { describe, expect, it } from "vitest";
import { nextQuotaReset, quotaWindowStart, youtubeDailyQuota } from "../src/quota";

describe("youtube quota windows", () => {
  it("window starts at 08:00 UTC of the current day when past it", () => {
    const now = new Date("2026-07-03T12:00:00Z");
    expect(quotaWindowStart(now).toISOString()).toBe("2026-07-03T08:00:00.000Z");
    expect(nextQuotaReset(now).toISOString()).toBe("2026-07-04T08:00:00.000Z");
  });

  it("window starts the previous day when before 08:00 UTC", () => {
    const now = new Date("2026-07-03T05:00:00Z");
    expect(quotaWindowStart(now).toISOString()).toBe("2026-07-02T08:00:00.000Z");
    expect(nextQuotaReset(now).toISOString()).toBe("2026-07-03T08:00:00.000Z");
  });

  it("reset is always in the future", () => {
    const now = new Date();
    expect(nextQuotaReset(now).getTime()).toBeGreaterThan(now.getTime());
  });

  it("quota is env-overridable", () => {
    expect(youtubeDailyQuota({} as NodeJS.ProcessEnv)).toBe(10000);
    expect(youtubeDailyQuota({ YOUTUBE_DAILY_QUOTA: "50000" } as unknown as NodeJS.ProcessEnv)).toBe(50000);
  });
});
