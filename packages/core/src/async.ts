/**
 * Small async utilities. `withTimeout` bounds a promise so a slow/hanging
 * dependency (a live external API call) can't stall the caller indefinitely.
 *
 * Motivation (ticket 01KYVE4AAY…/#88): a read-only MCP tool that the Claude app
 * AUTO-RUNS without a per-call approval must always return promptly — if its one
 * live external call (e.g. get_channel_analytics → YouTube Analytics) hangs, the
 * host's auto-run has nothing to fall back to. Bounding the external call lets the
 * tool degrade to its stored-snapshot path instead of hanging.
 */

/** Error thrown by {@link withTimeout} when the wrapped promise doesn't settle in time. */
export class TimeoutError extends Error {
  constructor(ms: number, label?: string) {
    super(`${label ? `${label} ` : ""}timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Resolve with `promise`'s value if it settles within `ms`, otherwise reject
 * with a {@link TimeoutError}. The underlying promise is NOT cancelled (JS has no
 * cancellation) — the timer just stops the CALLER from waiting on it. The timer is
 * always cleared so a fast-settling promise leaves no dangling handle.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label?: string): Promise<T> {
  if (!(ms > 0)) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms, label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}
