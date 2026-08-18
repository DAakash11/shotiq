import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Redis } from "ioredis";

import { createBullJobStore } from "./bullJobStore.js";
import { createRedisConnection } from "./connection.js";
import { createWarmQueue } from "./warmQueue.js";
import type { WarmQueue } from "./warmQueue.js";

/**
 * Database 15, not the default 0.
 *
 * These tests obliterate the queue between cases, and doing that against the
 * database a developer is running the service on would delete their jobs
 * mid-session. Redis numbers its databases, so /15 is a separate key space
 * on the same server -- isolation without a second container.
 */
const TEST_REDIS_URL =
  process.env["TEST_REDIS_URL"] ?? "redis://127.0.0.1:6379/15";

let connection: Redis;
let queue: WarmQueue;

beforeAll(async () => {
  connection = createRedisConnection(TEST_REDIS_URL);

  // Connect explicitly rather than letting the first command do it lazily.
  // If Redis is not running, this throws HERE, with a message naming the
  // connection, instead of surfacing as a confusing timeout inside whichever
  // test happened to run first.
  await connection.connect();

  queue = createWarmQueue(connection);
});

afterEach(async () => {
  // obliterate() removes the queue and every job in it, and flushdb clears
  // the claim: markers alongside them -- those live outside the queue's own
  // key space, so obliterate does not touch them, and a marker surviving
  // into the next test would make a fresh submission report itself as a
  // duplicate. Safe only because this is database 15, used by nothing else.
  //
  // Cleaning up AFTER each test rather than before means a failed run leaves
  // nothing behind for the next one to trip over.
  await queue.obliterate({ force: true });
  await connection.flushdb();
});

afterAll(async () => {
  await queue.close();
  await connection.quit();
});

describe("the queue really is Redis", () => {
  it("stores a submitted job where another client can see it", async () => {
    const store = createBullJobStore(queue, connection);

    const outcome = await store.submit({ playerId: 201939, season: "2016-17" });
    expect(outcome.kind).toBe("accepted");

    // Read through a SEPARATE store object built on the same queue. The
    // in-memory implementation could never pass this: its Map was private to
    // one closure, so a second store saw nothing. Passing here is the whole
    // difference -- the state lives in Redis, not in a process.
    const other = createBullJobStore(queue, connection);
    const found = await other.get("warm:201939:2016-17");

    expect(found).toBeDefined();
    expect(found?.jobId).toBe("warm:201939:2016-17");
    expect(found?.data).toEqual({ playerId: 201939, season: "2016-17" });
    expect(found?.state).toBe("queued");
  });

  it("survives the process that created it", async () => {
    const store = createBullJobStore(queue, connection);
    await store.submit({ playerId: 203999, season: "2021-22" });

    // A brand new connection and queue, as a restarted container would have.
    // Everything held in memory by the first one is gone by construction.
    const secondConnection = createRedisConnection(TEST_REDIS_URL);
    await secondConnection.connect();
    const secondQueue = createWarmQueue(secondConnection);

    try {
      const found = await createBullJobStore(secondQueue, secondConnection).get(
        "warm:203999:2021-22",
      );

      // The single most important assertion in this file. This is the
      // failure recovery the whole design is for: a crash mid-queue loses
      // nothing, because nothing was ever only in the process.
      expect(found?.jobId).toBe("warm:203999:2021-22");
    } finally {
      await secondQueue.close();
      await secondConnection.quit();
    }
  });

  it("returns undefined for a job that was never submitted", async () => {
    const store = createBullJobStore(queue, connection);
    expect(await store.get("warm:1:2016-17")).toBeUndefined();
  });
});

describe("idempotency, against the real thing", () => {
  it("collapses a repeat submission into the existing job", async () => {
    const store = createBullJobStore(queue, connection);
    const data = { playerId: 201939, season: "2016-17" };

    const first = await store.submit(data);
    const second = await store.submit(data);

    expect(first.kind).toBe("accepted");
    expect(second.kind).toBe("duplicate");
    expect(second.job.jobId).toBe(first.job.jobId);
    expect(await store.size()).toBe(1);
  });

  it("holds when the same job is submitted concurrently", async () => {
    /**
     * The test the in-memory store could not honestly pass.
     *
     * Its submit() did a `get` and then a `set` with nothing awaited in
     * between, so it was safe only because Node runs one callback at a time
     * -- luck, not design. Two API replicas, or one await landing between
     * those lines, and both callers find nothing and both create a job.
     *
     * Promise.all fires all ten without waiting for each other, so the
     * check-then-write windows overlap. BullMQ resolves this inside a Lua
     * script that Redis runs atomically, which is why exactly one job
     * exists at the end rather than somewhere between one and ten.
     */
    const store = createBullJobStore(queue, connection);
    const data = { playerId: 1628983, season: "2025-26" };

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => store.submit(data)),
    );

    expect(await store.size()).toBe(1);

    const ids = new Set(outcomes.map((outcome) => outcome.job.jobId));
    expect(ids).toEqual(new Set(["warm:1628983:2025-26"]));

    // EXACTLY one caller is told it created the job. Not "at most one" --
    // the job was certainly created, so someone must own having done it, and
    // the other nine must be told it already existed or their 202 claims
    // work they did not cause.
    //
    // This assertion failed on the first implementation, which used
    // getJob-then-add and told all ten they had created it. Redis SET NX is
    // what makes it exact.
    const accepted = outcomes.filter((outcome) => outcome.kind === "accepted");
    expect(accepted).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === "duplicate")).toHaveLength(9);
  });

  it("treats a different player or season as different work", async () => {
    const store = createBullJobStore(queue, connection);

    await store.submit({ playerId: 201939, season: "2016-17" });
    await store.submit({ playerId: 201939, season: "2015-16" });
    await store.submit({ playerId: 2544, season: "2016-17" });

    expect(await store.size()).toBe(3);
  });
});
