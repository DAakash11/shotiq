import { defineConfig } from "vitest/config";

/**
 * The integration suite: real Redis, real BullMQ, no mocks.
 *
 * These are the tests that can prove the things the unit suite cannot even
 * express -- that a job outlives the process that created it, and that two
 * concurrent submissions produce one job rather than two. Both are claims
 * about Redis, and a fake Redis would only prove the fake behaves.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],

    // One file at a time. These share a single Redis database, so running
    // them in parallel would let one file's cleanup delete another's jobs
    // and produce failures that move around between runs.
    fileParallelism: false,

    // BullMQ's first operations pay for connecting and loading its Lua
    // scripts, which is slower than any unit test and occasionally slower
    // than Vitest's 5s default on a cold container.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
