import { describe, expect, it } from "vitest";
import { TimeoutError, withTimeout } from "../src/async";

describe("withTimeout", () => {
  it("resolves with the value when the promise settles in time", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000)).resolves.toBe(42);
  });

  it("rejects with a TimeoutError when the promise hangs past the deadline", async () => {
    const hang = new Promise<number>(() => {}); // never settles
    await expect(withTimeout(hang, 10, "channel analytics")).rejects.toBeInstanceOf(TimeoutError);
  });

  it("propagates the underlying rejection when it loses the race", async () => {
    const boom = Promise.reject(new Error("provider down"));
    await expect(withTimeout(boom, 1000)).rejects.toThrow("provider down");
  });

  it("supports the graceful-fallback pattern: a hang degrades to the fallback value", async () => {
    const hang = new Promise<string>(() => {});
    const value = await withTimeout(hang, 10).catch(() => "fallback");
    expect(value).toBe("fallback");
  });

  it("returns the promise unchanged when ms is non-positive (no timer armed)", async () => {
    await expect(withTimeout(Promise.resolve("x"), 0)).resolves.toBe("x");
  });
});
