import { Queue } from "bullmq";
import type { Redis } from "ioredis";

import type { WarmJobData, WarmResult } from "../types/models.js";

/**
 * The queue name. A plain string, but it is a CONTRACT: the producer and the
 * consumer must agree on it exactly, and a typo produces a queue nobody
 * consumes from, with jobs piling up and no error anywhere. Exported and
 * imported by both sides rather than written twice.
 */
export const WARM_QUEUE_NAME = "warm";

/**
 * `Queue<WarmJobData, WarmResult, string>` -- the generic arguments are the
 * data going in, the result coming back, and the job-name type.
 *
 * This is the payoff that made BullMQ worth choosing over a hand-rolled
 * queue, and it is worth being able to explain. In a distributed system the
 * classic failure is a producer and a consumer that disagree about the
 * message shape: the API starts sending `{ player }`, the worker still reads
 * `{ playerId }`, and nothing complains until jobs start failing in
 * production for reasons the logs describe badly.
 *
 * Because both sides are typed from the SAME WarmJobData in the same repo,
 * that disagreement becomes a compile error. It is one of the few places
 * where TypeScript catches a genuinely distributed bug rather than a local
 * one -- and it only works because the queue is generic. An untyped
 * `queue.add(name, anything)` would accept the mismatch happily.
 *
 * The limit is worth being honest about: this holds because one repository
 * owns both ends. Across separate services in different languages, the
 * compiler cannot help and the contract needs a schema both sides validate.
 */
export type WarmQueue = Queue<WarmJobData, WarmResult, string>;

export function createWarmQueue(connection: Redis): WarmQueue {
  return new Queue<WarmJobData, WarmResult, string>(WARM_QUEUE_NAME, {
    connection,

    defaultJobOptions: {
      // Three attempts total, not three retries. BullMQ counts the first
      // run, so this is one try and two more.
      //
      // Three is chosen against the actual failure being defended against:
      // Gemini returning 503 and stats.nba.com rate-limiting, both of which
      // are transient and usually clear within seconds. More attempts would
      // not fix a genuinely broken upstream, and each one costs a 90-second
      // timeout — ten attempts against a dead service is fifteen minutes of
      // a worker slot spent to reach the same conclusion.
      attempts: 3,

      backoff: {
        // Exponential, not fixed. A fixed delay means every client that
        // failed together retries together, forever — the same synchronised
        // wave hitting an upstream that is already struggling. Doubling
        // spreads the load out as failures persist.
        //
        // 2s, then 4s. Long enough for a 503 to clear, short enough that a
        // recoverable job is not sitting idle for minutes.
        type: "exponential",
        delay: 2000,

        // Jitter is the part people leave out, and it is what actually
        // breaks the synchronisation. Exponential backoff alone still has
        // every failed job waiting the SAME 2s and retrying in lockstep --
        // a thundering herd, just a politer one. Randomising the delay by
        // ±30% scatters them.
        jitter: 0.3,
      },

      // Completed jobs are KEPT, which is a deliberate choice with a
      // consequence attached.
      //
      // Keeping them is what makes GET /jobs/:id work after the job has
      // finished -- the record and its result live in the completed set, and
      // removing them on completion would mean a caller who polls a moment
      // too late gets a 404 for work that succeeded.
      //
      // But because identity comes from jobId, a kept job also BLOCKS
      // re-adding the same player-season: BullMQ refuses an id that already
      // exists. So the retention window is also the re-warm window, and the
      // two cannot be set independently. An hour is a reasonable cache life
      // for season-to-date shooting data.
      //
      // The caveat, from BullMQ's own documentation rather than assumed:
      // eviction is best-effort and evaluated when another job finishes.
      // There is no background timer, so on a quiet queue a job can outlive
      // its age and keep blocking. Step 6 adds an explicit refresh path that
      // removes the job first, rather than pretending the age is exact.
      removeOnComplete: { age: 3600, count: 500 },

      // Failures are kept longer and in smaller number: they are the ones
      // worth reading, and a failed job that vanishes takes its stack trace
      // with it.
      removeOnFail: { age: 86_400, count: 100 },
    },
  });
}
