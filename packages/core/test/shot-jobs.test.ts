import { describe, expect, it } from "vitest";
import {
  SHOT_JOB_QUEUED_STALL_MS,
  SHOT_JOB_RUNNING_STALL_MS,
  isShotJobStalled,
  partitionShotJobs,
  type ShotJobLike,
} from "../src/shot-jobs";

const NOW = 1_700_000_000_000;
const ago = (ms: number) => new Date(NOW - ms);

const job = (over: Partial<ShotJobLike> = {}): ShotJobLike => ({
  productionId: "p1",
  op: "clip",
  status: "queued",
  createdAt: ago(0),
  startedAt: null,
  ...over,
});

describe("isShotJobStalled", () => {
  it("a finished job is never stalled", () => {
    for (const status of ["done", "failed", "cancelled"]) {
      expect(isShotJobStalled(job({ status, createdAt: ago(10 * 60 * 60 * 1000) }), [], NOW)).toBe(false);
    }
  });

  it("a fresh queued job is live", () => {
    expect(isShotJobStalled(job({ createdAt: ago(60_000) }), [], NOW)).toBe(false);
  });

  it("a running job is live until it goes quiet past the ceiling", () => {
    const running = (age: number) => job({ status: "running", startedAt: ago(age) });
    expect(isShotJobStalled(running(SHOT_JOB_RUNNING_STALL_MS - 1000), [], NOW)).toBe(false);
    expect(isShotJobStalled(running(SHOT_JOB_RUNNING_STALL_MS + 1000), [], NOW)).toBe(true);
  });

  it("a running row with no startedAt still ages out on createdAt", () => {
    const broken = job({ status: "running", startedAt: null, createdAt: ago(SHOT_JOB_RUNNING_STALL_MS + 1000) });
    expect(isShotJobStalled(broken, [], NOW)).toBe(true);
  });

  // the deep-queue case: clips are serialised one-at-a-time per production, so
  // a long wait behind a live run is EXPECTED and must never read as stalled.
  it("an old queued job behind a live running sibling is not stalled", () => {
    const old = job({ createdAt: ago(SHOT_JOB_QUEUED_STALL_MS * 3) });
    const runner = job({ status: "running", startedAt: ago(60_000) });
    expect(isShotJobStalled(old, [old, runner], NOW)).toBe(false);
  });

  // the reported bug: the first clip landed, the rest died in the queue when the
  // worker redeployed. Nothing is running, so the leftovers are abandoned.
  it("an old queued job with nothing running on its production is stalled", () => {
    const old = job({ createdAt: ago(SHOT_JOB_QUEUED_STALL_MS + 1000) });
    expect(isShotJobStalled(old, [old], NOW)).toBe(true);
  });

  it("a stalled runner does not shelter the jobs queued behind it", () => {
    const old = job({ createdAt: ago(SHOT_JOB_QUEUED_STALL_MS * 3) });
    const deadRunner = job({ status: "running", startedAt: ago(SHOT_JOB_RUNNING_STALL_MS * 2) });
    expect(isShotJobStalled(old, [old, deadRunner], NOW)).toBe(true);
  });

  it("a running sibling on a DIFFERENT production does not shelter it", () => {
    const old = job({ createdAt: ago(SHOT_JOB_QUEUED_STALL_MS + 1000) });
    const elsewhere = job({ productionId: "p2", status: "running", startedAt: ago(60_000) });
    expect(isShotJobStalled(old, [old, elsewhere], NOW)).toBe(true);
  });
});

describe("partitionShotJobs", () => {
  it("keeps a live queue whole and separates only the abandoned rows", () => {
    const runner = job({ status: "running", startedAt: ago(60_000) });
    const waiting = job({ createdAt: ago(SHOT_JOB_QUEUED_STALL_MS * 2) });
    const abandoned = job({ productionId: "p2", createdAt: ago(SHOT_JOB_QUEUED_STALL_MS * 2) });
    const finished = job({ status: "done" });
    const { live, stalled } = partitionShotJobs([runner, waiting, abandoned, finished], NOW);
    expect(live).toEqual([runner, waiting]);
    expect(stalled).toEqual([abandoned]);
  });
});
