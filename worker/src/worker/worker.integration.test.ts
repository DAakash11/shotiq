import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Worker } from "bullmq";
import type { Redis } from "ioredis";

import { createBullJobStore } from "../queue/bullJobStore.js";
import { createRedisConnection } from "../queue/connection.js";
import { createWarmCache } from "../cache/warmCache.js";
import { createWarmProcessor } from "./processor.js";
import { createWarmQueue, WARM_QUEUE_NAME } from "../queue/warmQueue.js";
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

/**
 * The HTTP client is faked while Redis and BullMQ are real.
 *
 * That split is the point of an integration test rather than an end-to-end
 * one. What is under test is the queue mechanics -- delivery, completion,
 * failure recording -- and those are Redis behaviours a mock could only
 * pretend to have. The upstream is somebody else's service, and reaching it
 * would make the suite slow, flaky, and dependent on stats.nba.com being up,
 * which is exactly the offline rule the Python suite already enforces.
 */
const okClient: ShotiqClient = {
  getShots: async () => shots,
  getSplits: async () => splits,
};

let queueConnection: Redis;
let workerConnection: Redis;
let queue: WarmQueue;
let worker: Worker<WarmJobData, WarmResult> | null = null;

beforeEach(async () => {
  // Two connections, because BullMQ requires the worker to have its own: a
  // worker blocks inside a command waiting for the next job, and a Redis
  // client runs one command at a time, so anything sharing that client would
  // queue behind a wait designed never to return until there is work.
  queueConnection = createRedisConnection(TEST_REDIS_URL);
  workerConnection = createRedisConnection(TEST_REDIS_URL);
  await queueConnection.connect();
  await workerConnection.connect();

  queue = createWarmQueue(queueConnection);
});

afterEach(async () => {
  if (worker !== null) {
    await worker.close();
    worker = null;
  }
  await queue.obliterate({ force: true });
  await queueConnection.flushdb();
  await queue.close();
  await queueConnection.quit();
  await workerConnection.quit();
});

/**
 * Waits for one job to reach a terminal state.
 *
 * Polling with a sleep would be slower and flakier; the worker's own events
 * fire the moment BullMQ records the outcome. The timeout rejects rather
 * than hanging, so a broken worker fails the test with a message instead of
 * stalling the suite until Vitest gives up.
 */
function onceSettled(
  w: Worker<WarmJobData, WarmResult>,
): Promise<{ ok: boolean; result?: WarmResult; error?: Error }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("job never settled")), 10_000);

    w.once("completed", (_job, result) => {
      clearTimeout(timer);
      resolve({ ok: true, result });
    });
    // Only a TERMINAL failure resolves this. Once step 6 gave the queue
    // attempts: 3, the same event fires for every intermediate failure too,
    // and resolving on the first one asserted against a job that was
    // actually sitting in delayed waiting to retry -- which is how this test
    // started reporting "queued" where it expected "failed".
    w.on("failed", (job, error) => {
      if (job === undefined) return;
      const allowed = job.opts.attempts ?? 1;
      if (error.name === "UnrecoverableError" || job.attemptsMade >= allowed) {
        clearTimeout(timer);
        resolve({ ok: false, error });
      }
    });
  });
}

describe("a job submitted to the queue is actually executed", () => {
  it("runs the processor and records the result", async () => {
    const cache = createWarmCache(queueConnection);
    const store = createBullJobStore(queue, queueConnection);

    worker = new Worker<WarmJobData, WarmResult>(
      WARM_QUEUE_NAME,
      createWarmProcessor({ client: okClient, cache }),
      { connection: workerConnection, concurrency: 2 },
    );

    const settled = onceSettled(worker);
    await store.submit({ playerId: 201939, season: "2016-17" });
    const outcome = await settled;

    expect(outcome.ok).toBe(true);
    expect(outcome.result).toMatchObject({
      status: "warmed",
      playerId: 201939,
      season: "2016-17",
      shotsSource: "live",
    });

    // The full round trip: the same record the HTTP API would return to
    // someone polling GET /jobs/:id.
    const record = await store.get("warm:201939:2016-17");
    expect(record?.state).toBe("completed");
    expect(record?.result).toMatchObject({ status: "warmed" });

    // And the payloads are where a reader would look for them.
    expect(await cache.read(201939, "2016-17")).not.toBeNull();
  });

  it("skips the work when the subject is already cached", async () => {
    const cache = createWarmCache(queueConnection);
    await cache.write(201939, "2016-17", {
      shots,
      splits,
      warmedAt: "2026-08-18T00:00:00.000Z",
    });

    // A client that fails if it is called at all, which turns "should not
    // fetch" from a comment into an assertion.
    const forbidden: ShotiqClient = {
      getShots: async () => {
        throw new Error("upstream must not be called for a cached subject");
      },
      getSplits: async () => {
        throw new Error("upstream must not be called for a cached subject");
      },
    };

    worker = new Worker<WarmJobData, WarmResult>(
      WARM_QUEUE_NAME,
      createWarmProcessor({ client: forbidden, cache }),
      { connection: workerConnection, concurrency: 2 },
    );

    const settled = onceSettled(worker);
    await createBullJobStore(queue, queueConnection).submit({
      playerId: 201939,
      season: "2016-17",
    });
    const outcome = await settled;

    expect(outcome.ok).toBe(true);
    expect(outcome.result).toMatchObject({ status: "skipped" });
  });
});

describe("failure is recorded rather than swallowed", () => {
  it("marks the job failed and reports why through the store", async () => {
    const failing: ShotiqClient = {
      getShots: async () => {
        throw new UpstreamError("upstream responded 503", 503, "/api/shots");
      },
      getSplits: async () => splits,
    };

    const store = createBullJobStore(queue, queueConnection);
    worker = new Worker<WarmJobData, WarmResult>(
      WARM_QUEUE_NAME,
      createWarmProcessor({
        client: failing,
        cache: createWarmCache(queueConnection),
      }),
      { connection: workerConnection, concurrency: 2 },
    );

    const settled = onceSettled(worker);
    await store.submit({ playerId: 201939, season: "2016-17" });
    const outcome = await settled;

    expect(outcome.ok).toBe(false);
    expect(outcome.error?.message).toContain("503");

    // The part that matters for the API: a caller polling a failed job gets
    // a reason, not result: null. The processor threw and returned nothing,
    // so this record is assembled from what BullMQ stored.
    const record = await store.get("warm:201939:2016-17");
    expect(record?.state).toBe("failed");
    expect(record?.result).toMatchObject({
      status: "failed",
      error: expect.stringContaining("503") as unknown as string,
      // Three, not one: a 503 is retryable, so the job used its whole budget
      // before giving up. That is the retry policy working.
      attempt: 3,
    });
  });
});
