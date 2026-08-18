import { Queue } from "bullmq";
import type { Redis } from "ioredis";

import type { WarmJobData } from "../types/models.js";

export const DEAD_LETTER_QUEUE_NAME = "warm-dead";

/**
 * What lands in the dead-letter queue: the original job, plus why it is
 * here. The reason is the point -- a dead job with no explanation is just a
 * job nobody can act on.
 */
export interface DeadLetter {
  readonly data: WarmJobData;
  readonly jobId: string;
  readonly error: string;
  readonly attemptsMade: number;
  readonly failedAt: string;
}

export type DeadLetterQueue = Queue<DeadLetter, void, string>;

/**
 * The dead-letter queue: where jobs go when retrying has stopped helping.
 *
 * Worth being straight about what this adds, because BullMQ already keeps
 * failed jobs in a `failed` set with their reason, and for many projects
 * that IS the dead-letter store. Adding a queue is not free.
 *
 * What it buys, and why it is here:
 *
 *   - It separates "failed and will be retried" from "failed and is
 *     finished". Both sit in the same failed set otherwise, and the
 *     difference is the one an operator actually cares about -- only the
 *     second needs a human.
 *   - It is a QUEUE, so something can consume it: alerting, a daily digest,
 *     or a replay job once the upstream is fixed. A set is a place to look;
 *     a queue is a place to react.
 *   - It survives the failed set's retention window. Failed jobs are evicted
 *     by age and count; a poison job that nobody noticed for a day should
 *     not disappear because a hundred others failed after it.
 *
 * "Poison job" is the term worth knowing: one that fails every time it is
 * delivered, and without somewhere to put it, can be retried forever and
 * starve the queue behind it.
 */
export function createDeadLetterQueue(connection: Redis): DeadLetterQueue {
  return new Queue<DeadLetter, void, string>(DEAD_LETTER_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      // Never retried. These are jobs that already exhausted their retries
      // or were permanently rejected -- running them again is the one thing
      // we know does not work.
      attempts: 1,

      // Kept for a week, and far longer than anything else here, because
      // this is the record a person reads on Monday about something that
      // broke on Saturday.
      removeOnComplete: { age: 604_800 },
      removeOnFail: { age: 604_800 },
    },
  });
}
