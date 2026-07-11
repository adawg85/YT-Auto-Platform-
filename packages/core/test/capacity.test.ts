import { describe, expect, it } from "vitest";
import { capacityStatus } from "../src/capacity";

const GB = 1024 ** 3;

describe("capacityStatus (#21.7)", () => {
  it("ok below 70%", () => {
    const s = capacityStatus({ usedBytes: 5 * GB, quotaGb: 10, cacheHitRatio: 0.99 });
    expect(s.level).toBe("ok");
    expect(s.message).toBeNull();
  });
  it("warns at 70% storage", () => {
    const s = capacityStatus({ usedBytes: 7.2 * GB, quotaGb: 10, cacheHitRatio: 0.99 });
    expect(s.level).toBe("warning");
    expect(s.message).toContain("72%");
  });
  it("critical at 85%", () => {
    const s = capacityStatus({ usedBytes: 8.6 * GB, quotaGb: 10, cacheHitRatio: 0.99 });
    expect(s.level).toBe("critical");
  });
  it("low cache-hit ratio warns even with plenty of storage", () => {
    const s = capacityStatus({ usedBytes: 1 * GB, quotaGb: 10, cacheHitRatio: 0.90 });
    expect(s.level).toBe("warning");
    expect(s.message).toContain("RAM");
  });
  it("null cache ratio (fresh db) never trips the RAM warning", () => {
    const s = capacityStatus({ usedBytes: 1 * GB, quotaGb: 10, cacheHitRatio: null });
    expect(s.level).toBe("ok");
  });
});
