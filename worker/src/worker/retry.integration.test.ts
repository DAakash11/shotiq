import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Worker } from "bullmq";
import type { Redis } from "ioredis";

import { createBullJobStore } from "../queue/bullJobStore.js";
import { createDeadLetterQueue, DEAD_LETTER_QUEUE_NAME } from "../queue/deadLetterQueue.js";
import type { DeadLetterQueue } from "../queue/deadLetterQueue.js";
import { createRedisConnection } from "../queue/connection.js";
import { createWarmCache } from "../cache/warmCache.js";
import { createWarmProcessor } from "./processor.js";
import { createWarmQueue, WARM_QUEUE_NAME } from "../queue/warmQueue.js";
import { deadLetterIfFinished } from "./failureHandler.js";
import { UpstreamError } from "../fetchers/shotiqClient.js";
import type { ShotiqClient } from "../fetchers/shotiqClient.js";
import type { WarmQueue } from "../queue/warmQueue.js";
import type {
  ShotsPayload,
  SplitsPayload,
  WarmJobData,
  WarmResult,
} from "../types/models.js";

const TEST_REDIS_URL =
  process.env["TEST_REDIS_URL"] ?? "redis://127.0.0.1:6379/15";

const shots = {
  meta: {
    playerId: 201939,
    player: "Stephen Curry",
    season: "2016-17",
    seasonType: "Regular Season",
    hasTracking: true,
    source: "live",
    fetchedAt: "2026-08-18T00:00:00+00:00",
    team: "Golden State Warriors",
    attempts: 1443,
    made: 675,
    fgPct: 0.468,
  },
  shots: [],
  leagueAverages: [],
} satisfies ShotsPayload;

const splits = {
  meta: {
    playerId: 201939,
    player: "Stephen Curry",
    season: "2016-17",
    seasonType: "Regular Season",
    hasTracking: true,
    source: "live",
    fetchedAt: "2026-08-18T00:00:00+00:00",
    games: 79,
  },
  overall: null,
  splits: {
    shotClock: [],
    defenderDistance: [],
    dribbles: [],
    touchTime: [],
    general: [],
  },
} satisfies SplitsPayload;

let queueConnection: Redis;
let workerConnection: Redis;
let queue: WarmQueue;
let deadLetters: DeadLetterQueue;
let worker: Worker<WarmJobData, WarmResult> | null = null;

beforeEach(async () => {
  queueConnection = createRedisConnection(TEST_REDIS_URL);
  workerConnection = createRedisConnection(TEST_REDIS_URL);
  await queueConnection.connect();
  await workerConnection.connect();
  queue = createWarmQueue(queueConnection);
  deadLetters = createDeadLetterQueue(queueConnection);
});

afterEach(async () => {
  if (worker !== null) {
    await worker.close();
    worker = null;
  }
  await queue.obliterate({ force: true });
  await deadLetters.obliterate({ force: true });
  await queueConnection.flushdb();
  await queue.close();
  await deadLetters.close();
  await queueConnection.quit();
  await workerConnection.quit();
});

/**
 * The test overrides the production retry policy with a 20ms fixed backoff.
 *
 * The real settings are 2s exponential with 30% jitter, which is right for
 * an upstream that 503s and wrong for a test suite: two retries would take
 * the better part of eight seconds, every run, to prove something that has
 * nothing to do with the delay. What is under test is the MECHANISM --
 * that a failure is retried, that the attempt count climbs, that success on
 * a later attempt completes the job. The specific delays are a policy
 * decision covered by reading warmQueue.ts, not by waiting for them.
 */
async function enqueueWithFastRetries(
  data: WarmJobData,
  attempts: number,
): Promise<void> {
  await queue.add("warm", data, {
    jobId: `warm:${data.playerId}:${data.season}`,
    attempts,
    backoff: { type: "fixed", delay: 20 },
  });
}

function startWorker(client: ShotiqClient): Worker<WarmJobData, WarmResult> {
  return new Worker<WarmJobData, WarmResult>(
    WARM_QUEUE_NAME,
    createWarmProcessor({ client, cache: createWarmCache(queueConnection) }),
    { connection: workerConnection, concurrency: 1 },
  );
}

/** Resolves when the job reaches a terminal state, rejecting rather than hanging. */
function settled(w: Worker<WarmJobData, WarmResult>): Promise<"completed" | "failed"> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("job never settled")), 10_000);
    w.once("completed", () => {
      clearTimeout(timer);
      resolve("completed");
    });
    // Only the FINAL failure resolves this. Intermediate failures fire the
    // same event, so the handler checks whether attempts remain -- otherwise
    // the first of three failures would end the test.
    w.on("failed", (job, error) => {
      if (job === undefined) return;
      const allowed = job.opts.attempts ?? 1;
      if (error.name === "UnrecoverableError" || job.attemptsMade >= allowed) {
        clearTimeout(timer);
        resolve("failed");
      }
    });
  });
}

describe("retries", () => {
  it("retries a transient failure and succeeds on a later attempt", async () => {
    // Fails twice with a 503, then works -- the shape of a real Gemini or
    // stats.nba.com outage, and the exact case the retry policy exists for.
    let calls = 0;
    const flaky: ShotiqClient = {
      getShots: async () => {
        calls += 1;
        if (calls <= 2) {
          throw new UpstreamError("upstream responded 503", 503, "/api/shots");
        }
        return shots;
      },
      getSplits: async () => splits,
    };

    worker = startWorker(flaky);
    const done = settled(worker);
    await enqueueWithFastRetries({ playerId: 201939, season: "2016-17" }, 3);

    expect(await done).toBe("completed");
    expect(calls).toBe(3);

    const record = await createBullJobStore(queue, queueConnection).get(
      "warm:201939:2016-17",
    );
    expect(record?.state).toBe("completed");
    expect(record?.result).toMatchObject({ status: "warmed" });
  });

  it("gives up after the attempt budget and records the last failure", async () => {
    let calls = 0;
    const broken: ShotiqClient = {
      getShots: async () => {
        calls += 1;
        throw new UpstreamError("upstream responded 503", 503, "/api/shots");
      },
      getSplits: async () => splits,
    };

    worker = startWorker(broken);
    const done = settled(worker);
    await enqueueWithFastRetries({ playerId: 201939, season: "2016-17" }, 3);

    expect(await done).toBe("failed");
    expect(calls).toBe(3);

    const record = await createBullJobStore(queue, queueConnection).get(
      "warm:201939:2016-17",
    );
    expect(record?.result).toMatchObject({ status: "failed", attempt: 3 });
  });

  it("does not retry a permanent failure, however many attempts remain", async () => {
    /**
     * The behaviour that makes the retry policy worth having rather than
     * merely present. A 404 fails identically on every attempt, so three
     * tries spend two extra upstream requests and a worker slot to reach the
     * answer the first response already gave.
     *
     * `calls` being 1 with an attempt budget of 3 is the whole assertion.
     */
    let calls = 0;
    const notFound: ShotiqClient = {
      getShots: async () => {
        calls += 1;
        throw new UpstreamError("upstream responded 404", 404, "/api/shots");
      },
      getSplits: async () => splits,
    };

    worker = startWorker(notFound);
    const done = settled(worker);
    await enqueueWithFastRetries({ playerId: 1, season: "2016-17" }, 3);

    expect(await done).toBe("failed");
    expect(calls).toBe(1);
  });
});

describe("dead-lettering", () => {
  it("buries an exhausted job and leaves a retryable one alone", async () => {
    const broken: ShotiqClient = {
      getShots: async () => {
        throw new UpstreamError("upstream responded 503", 503, "/api/shots");
      },
      getSplits: async () => splits,
    };

    worker = startWorker(broken);

    // Wire the real failure handler, exactly as the entrypoint does.
    const dispositions: string[] = [];
    worker.on("failed", (job, error) => {
      if (job === undefined) return;
      void deadLetterIfFinished(deadLetters, job, error).then((d) => {
        dispositions.push(d.kind);
      });
    });

    const done = settled(worker);
    await enqueueWithFastRetries({ playerId: 201939, season: "2016-17" }, 3);
    await done;

    // Give the fire-and-forget writes a moment to land.
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Two intermediate failures were left alone; only the last was buried.
    expect(dispositions).toEqual(["will-retry", "will-retry", "exhausted"]);

    const buried = await deadLetters.getJobs(["waiting", "delayed", "completed"]);
    expect(buried).toHaveLength(1);
    expect(buried[0]?.data).toMatchObject({
      jobId: "warm:201939:2016-17",
      attemptsMade: 3,
    });
    expect(buried[0]?.data.error).toContain("503");
  });

  it("buries a permanent failure immediately, with attempts unused", async () => {
    const notFound: ShotiqClient = {
      getShots: async () => {
        throw new UpstreamError("upstream responded 404", 404, "/api/shots");
      },
      getSplits: async () => splits,
    };

    worker = startWorker(notFound);
    const dispositions: string[] = [];
    worker.on("failed", (job, error) => {
      if (job === undefined) return;
      void deadLetterIfFinished(deadLetters, job, error).then((d) => {
        dispositions.push(d.kind);
      });
    });

    const done = settled(worker);
    await enqueueWithFastRetries({ playerId: 1, season: "2016-17" }, 3);
    await done;
    await new Promise((resolve) => setTimeout(resolve, 300));

    // "permanent", not "exhausted", and after ONE attempt out of three.
    // Classifying on attemptsMade alone would have called this "will-retry"
    // and never buried it.
    expect(dispositions).toEqual(["permanent"]);
    expect(await deadLetters.getJobs(["waiting", "delayed", "completed"])).toHaveLength(1);
  });

  it("uses a queue of its own, not the warm queue", async () => {
    expect(DEAD_LETTER_QUEUE_NAME).not.toBe(WARM_QUEUE_NAME);
  });
});

describe("refresh", () => {
  it("re-runs a subject that is already warm", async () => {
    const cache = createWarmCache(queueConnection);
    const store = createBullJobStore(queue, queueConnection, cache);

    let fetches = 0;
    const counting: ShotiqClient = {
      getShots: async () => {
        fetches += 1;
        return shots;
      },
      getSplits: async () => splits,
    };

    worker = startWorker(counting);

    const first = settled(worker);
    await store.submit({ playerId: 201939, season: "2016-17" });
    await first;
    expect(fetches).toBe(1);

    // Without refresh, the job id still exists and the payload is cached, so
    // nothing happens at all.
    const repeat = await store.submit({ playerId: 201939, season: "2016-17" });
    expect(repeat.kind).toBe("duplicate");
    expect(fetches).toBe(1);

    // With refresh, all three pieces of state are cleared -- job, claim
    // marker and cached payload -- so the work genuinely runs again.
    // Clearing only the job would produce a fresh job that instantly
    // reported "skipped", which looks like refresh doing nothing.
    const second = settled(worker);
    const refreshed = await store.submit(
      { playerId: 201939, season: "2016-17" },
      { refresh: true },
    );
    expect(refreshed.kind).toBe("accepted");

    await second;
    expect(fetches).toBe(2);
  });
});
