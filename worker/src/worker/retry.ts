import { UnrecoverableError } from "bullmq";

import { UpstreamError } from "../fetchers/shotiqClient.js";

/**
 * Deciding which failures are worth retrying.
 *
 * A retry policy that retries EVERYTHING is barely better than none. Asking
 * again for a player id that does not exist fails identically on every
 * attempt, so three tries with backoff spends roughly six seconds and two
 * extra upstream requests to reach the conclusion the first response already
 * gave. Worse, those attempts occupy a worker slot that real work is queued
 * behind.
 *
 * So failures are split in two:
 *
 *   RETRYABLE   -- the request was fine and the other side failed or was
 *                  slow. 5xx, timeouts, connection refused. Trying again is
 *                  genuinely likely to work, and this is the case the whole
 *                  backoff policy exists for: Gemini 503s and
 *                  stats.nba.com rate limiting.
 *
 *   PERMANENT   -- the request itself is wrong and will be wrong forever.
 *                  4xx, or a response that is not the shape we require.
 *                  Retrying is pure waste.
 *
 * BullMQ's mechanism for the second is UnrecoverableError: throwing one
 * marks the job failed IMMEDIATELY, skipping every remaining attempt,
 * regardless of what `attempts` says.
 */

/**
 * Translates an error into the one BullMQ should see.
 *
 * Note this CATCHES nothing -- it is handed an error and returns one, and
 * the caller does the rethrowing. That distinction matters given the rule
 * that a processor must never catch: catching in order to SWALLOW is the
 * mistake, because BullMQ then records a success. Catching in order to
 * TRANSLATE and immediately rethrow is not the same thing, and it is the
 * only way to tell BullMQ "do not bother retrying this one".
 *
 * The original error is preserved as `cause`, so the stack that actually
 * explains the failure is not lost in translation.
 */
export function toQueueError(error: unknown): Error {
  // `unknown` rather than `Error`, because JavaScript can throw anything --
  // a string, a number, undefined. Typing this parameter as Error would be
  // a claim the language does not support, and `error.message` on a thrown
  // string is undefined at the exact moment you need it most.
  if (error instanceof UpstreamError) {
    if (!error.isRetryable) {
      // UnrecoverableError takes a message only -- no options bag, so the
      // usual `{ cause }` argument is a compile error rather than a silently
      // ignored one. Assigned afterwards instead, because losing the
      // original stack would leave BullMQ's failedReason as the only record
      // of what actually went wrong.
      const permanent = new UnrecoverableError(
        `${error.message} (${error.url}) -- not retryable`,
      );
      permanent.cause = error;
      return permanent;
    }
    return error;
  }

  if (error instanceof Error) return error;

  // Something that was not an Error was thrown. Wrapping it means the
  // failure still has a readable message in BullMQ's failedReason rather
  // than the string "[object Object]".
  return new Error(`non-error thrown: ${JSON.stringify(error)}`);
}
