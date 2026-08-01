import { describe, expect, it } from "vitest";
import { isTerminalUploadLimit } from "../src/upload-errors";

describe("isTerminalUploadLimit", () => {
  it("matches the real YouTube 400 uploadLimitExceeded payload", () => {
    const msg =
      'YouTube upload init failed (400): { "error": { "code": 400, "message": ' +
      '"The user has exceeded the number of videos they may upload.", "errors": [ { ' +
      '"message": "The user has exceeded the number of videos they may upload.", ' +
      '"domain": "youtube.video", "reason": "uploadLimitExceeded" } ] } }';
    expect(isTerminalUploadLimit(msg)).toBe(true);
  });

  it("matches on the reason code alone, case-insensitively", () => {
    expect(isTerminalUploadLimit("reason: UPLOADLIMITEXCEEDED")).toBe(true);
  });

  it("does NOT match a transient/generic upload failure (must stay retriable)", () => {
    expect(isTerminalUploadLimit("upload failed: socket hang up")).toBe(false);
    expect(isTerminalUploadLimit("500 internal error")).toBe(false);
    expect(isTerminalUploadLimit("")).toBe(false);
  });

  it("does not conflate with API quota exhaustion (a different, gated error)", () => {
    // quotaExceeded is handled by the quota gate, not this halt path.
    expect(isTerminalUploadLimit("The request cannot be completed: quotaExceeded")).toBe(false);
  });
});
