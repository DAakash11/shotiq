import type { Job } from "bullmq";

import type { DeadLetterQueue } from "../queue/deadLetterQueue.js";
import type { WarmJobData, WarmResult } from "../types/models.js";

/**
 * What happened to a failed job, as a decision separate from acting on it.
 *
 * Pulled out of the entrypoint because logic that only exists inside an
 * event handler in index.ts cannot be tested without starting the whole
 * process -- and "will this be retried or is it finished?" is exactly the
 * kind of rule that deserves a test.
 */
export type FailureDisposition =
  | { readonly kind: "will-retry"; readonly attempt: number; readonly of: number }
  | { readonly kind: "exhausted"; readonly attempt: number }
  | { readonly kind: "permanent"; readonly attempt: number };

/**
 * Decides whether a failure is the end of the line.
 *
 * Two ways a job can be finished rather than merely failing, and they are
 * genuinely different:
 *
 *   EXHAUSTED -- it used every attempt it was given. The upstream may simply
 *                be down; this is worth alerting on and worth replaying
 *                later.
 *   PERMANENT -- it threw an UnrecoverableError, so BullMQ discarded the
 *                remaining attempts. Replaying it will not help; the request
 *                itself is wrong.
 *
 * Note the permanent case is detected by the error's NAME rather than by
 * comparing attempts. An UnrecoverableError ends a job with attempts still
 * unused, so `attemptsMade >= attempts` is false for it -- reading that
 * alone would classify a permanent failure as "will retry" and neither
 * dead-letter it nor log it as final.
 */
export function classifyFailure(
  job: Job<WarmJobData, WarmResult>,
  error: Error,
): FailureDisposition {
  const attemptsAllowed = job.opts.attempts ?? 1;

  if (error.name === "UnrecoverableError") {
    return { kind: "permanent", attempt: job.attemptsMade };
  }
  if (job.attemptsMade >= attemptsAllowed) {
    return { kind: "exhausted", attempt: job.attemptsMade };
  }
  return {
    kind: "will-retry",
    attempt: job.attemptsMade,
    of: attemptsAllowed,
  };
}

/**
 * Writes a finished-for-good job to the dead-letter queue.
 *
 * Returns whether it wrote anything, so a caller -- or a test -- can tell a
 * retry from a burial without reading logs.
 */
export async function deadLetterIfFinished(
  deadLetters: DeadLetterQueue,
  job: Job<WarmJobData, WarmResult>,
  error: Error,
): Promise<FailureDisposition> {
  const disposition = classifyFailure(job, error);
  if (disposition.kind === "will-retry") return disposition;

  await deadLetters.add("dead", {
    data: job.data,
    jobId: job.id ?? "unknown",
    error: error.message,
    attemptsMade: job.attemptsMade,
    failedAt: new Date().toISOString(),
  });

  return disposition;
}
