/**
 * The worker entrypoint: the second process, built from the same image as
 * the API and differing only in the command Compose gives it.
 *
 * Two processes rather than one, for two reasons worth being able to state.
 * They scale independently -- a backlog needs more workers, not more API --
 * and a job that exhausts memory or wedges takes down a consumer rather than
 * the endpoint everyone is talking to. The shared codebase is what keeps the
 * types honest across the split.
 */

import { Worker } from "bullmq";
import type { Job } from "bullmq";
import pino from "pino";

import { createRedisConnection } from "../queue/connection.js";
import { createShotiqClient } from "../fetchers/shotiqClient.js";
import { createWarmCache } from "../cache/warmCache.js";
import { createWarmProcessor } from "./processor.js";
import { loadConfig } from "../config.js";
import { WARM_QUEUE_NAME } from "../queue/warmQueue.js";
import { createDeadLetterQueue } from "../queue/deadLetterQueue.js";
import { deadLetterIfFinished } from "./failureHandler.js";
import type { WarmJobData, WarmResult } from "../types/models.js";
import { describeWarmResult } from "../types/models.js";

const config = loadConfig();
const log = pino({ level: config.logLevel });

/**
 * A connection of its own, NOT the one the API uses.
 *
 * BullMQ requires this, and the reason is the same one behind
 * maxRetriesPerRequest: null. A worker sits inside a blocking command
 * waiting for the next job, and a Redis connection executes one command at a
 * time -- so anything else sharing that client would queue up behind a wait
 * that is designed not to return until there is work. Sharing produces a
 * service that mysteriously stops responding, with nothing in the logs.
 */
const connection = createRedisConnection(config.redisUrl);
await connection.connect();

// The dead-letter queue shares the worker's connection: it is written to
// only on failure, so it never competes with the blocking wait for jobs in
// any meaningful way.
const deadLetters = createDeadLetterQueue(connection);

const processor = createWarmProcessor({
  client: createShotiqClient(config.shotiqApiUrl, config.upstreamTimeoutMs),
  cache: createWarmCache(connection),
});

const worker = new Worker<WarmJobData, WarmResult>(
  WARM_QUEUE_NAME,
  processor,
  {
    connection,

    // Two at a time, and the limit is about the upstream rather than this
    // process. stats.nba.com rate-limits aggressively, and the point of
    // warming a cache is to be a good citizen against it -- twenty parallel
    // fetches would get this project blocked, which is the opposite of
    // helpful. Two also sits comfortably inside the Docker VM's memory.
    concurrency: 2,
  },
);

/**
 * Event handlers, not because logging is nice, but because a worker has no
 * other way to say anything. Nobody is holding a request open waiting for
 * it, so an unobserved failure is genuinely silent.
 */
worker.on("completed", (job: Job<WarmJobData, WarmResult>, result: WarmResult) => {
  // describeWarmResult is the switch carrying the `never` exhaustiveness
  // check, so a new WarmResult member cannot be added without deciding how
  // it reads here.
  log.info({ jobId: job.id }, describeWarmResult(result));
});

worker.on("failed", (job: Job<WarmJobData, WarmResult> | undefined, error: Error) => {
  // `job` is possibly undefined, and the type says so honestly: a job can
  // fail before BullMQ has finished loading it, in which case there is
  // nothing to name. strictNullChecks forces this to be handled rather than
  // producing "cannot read properties of undefined" inside the error
  // handler -- the worst possible place for a second error.
  if (job === undefined) {
    log.error({ err: error }, "a job failed before it could be loaded");
    return;
  }

  // The decision itself lives in failureHandler.ts so it can be tested
  // without starting this process. Here we only act on it.
  //
  // Fire-and-forget with an explicit catch, NOT an unawaited promise. This
  // handler cannot be async -- BullMQ does not await event listeners, so
  // returning a promise means nothing waits for it and a rejection becomes
  // an unhandled rejection that can take the process down. Catching keeps a
  // failed dead-letter write from turning one lost job into a dead worker.
  void deadLetterIfFinished(deadLetters, job, error)
    .then((disposition) => {
      if (disposition.kind === "will-retry") {
        log.warn(
          { jobId: job.id, attempt: disposition.attempt, of: disposition.of, err: error },
          "job failed, will retry",
        );
        return;
      }
      log.error(
        { jobId: job.id, attempt: disposition.attempt, kind: disposition.kind, err: error },
        "job finished failed, dead-lettered",
      );
    })
    .catch((dlqError: unknown) => {
      log.error({ err: dlqError }, "failed to write to the dead-letter queue");
    });
});

// Fires when the worker's Redis connection breaks. Logged rather than
// exited: ioredis reconnects, and killing the process on a blip would turn
// a recoverable hiccup into a restart loop.
worker.on("error", (error: Error) => {
  log.error({ err: error }, "worker error");
});

log.info(
  { queue: WARM_QUEUE_NAME, concurrency: 2, upstream: config.shotiqApiUrl },
  "worker started",
);

/**
 * Graceful shutdown, and it matters more here than in the API.
 *
 * worker.close() stops taking NEW jobs and waits for the ones in flight to
 * finish. Killed mid-job instead, the job is not lost -- BullMQ redelivers
 * it once its lock expires, which is at-least-once delivery doing its job --
 * but the work already done is thrown away, and on a 90-second fetch that is
 * a minute and a half spent twice for nothing.
 *
 * Docker allows ten seconds before SIGKILL. A job can legitimately take
 * longer than that, so this is a best effort rather than a guarantee, and
 * the cache check at the top of the processor is what makes the redelivered
 * job cheap when it is not enough.
 */
async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, "shutting down, waiting for in-flight jobs");
  try {
    await worker.close();
    await connection.quit();
    process.exit(0);
  } catch (error) {
    log.error({ err: error }, "failed to shut down cleanly");
    process.exit(1);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
