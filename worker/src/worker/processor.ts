import type { Job } from "bullmq";

import type { WarmCache } from "../cache/warmCache.js";
import type { ShotiqClient } from "../fetchers/shotiqClient.js";
import type { WarmJobData, WarmResult } from "../types/models.js";

export interface ProcessorDeps {
  readonly client: ShotiqClient;
  readonly cache: WarmCache;
  /** Injected so a test can assert on duration without waiting for one. */
  readonly now?: () => number;
}

/**
 * The function that does one job.
 *
 * Its signature is the contract BullMQ enforces:
 * `(job: Job<WarmJobData, WarmResult>) => Promise<WarmResult>`. Because the
 * queue was declared with those same two type arguments, a processor that
 * returned the wrong shape -- or read `job.data.player` instead of
 * `job.data.playerId` -- is a compile error rather than a runtime surprise
 * in a container nobody is watching.
 *
 * Everything it needs is injected. There is no import of a Redis client or a
 * base URL here, which is what lets the unit tests run the real logic
 * against a fake upstream, with no network and no container.
 *
 * NOTHING IN HERE CATCHES. That is deliberate and is the single easiest
 * thing to get wrong.
 *
 * A processor signals failure by THROWING. BullMQ catches it, records the
 * reason, and decides whether to retry. A processor that catches its own
 * error and returns `{ status: "failed" }` instead has told BullMQ the job
 * SUCCEEDED -- it completes, no retry is scheduled, and the failure is
 * visible only to whoever reads the result. The instinct to handle errors
 * where they happen is exactly wrong at this boundary.
 *
 * Which is why WarmResult's "failed" member is never produced here. It is
 * built by the store when reading a job BullMQ has already marked failed,
 * from failedReason and attemptsMade -- the real record of what happened,
 * rather than a claim this function makes about itself.
 */
export function createWarmProcessor(deps: ProcessorDeps) {
  const { client, cache, now = Date.now } = deps;

  return async function processWarmJob(
    job: Job<WarmJobData, WarmResult>,
  ): Promise<WarmResult> {
    const startedAt = now();
    const { playerId, season } = job.data;

    // Idempotency, part two -- and a different question from the one the
    // queue answers.
    //
    // The job id stops the same work being QUEUED twice. This stops it being
    // DONE twice, which is a separate guarantee and the one that matters
    // under at-least-once delivery: if a worker dies after finishing the
    // fetch but before BullMQ records the job as complete, the job is
    // redelivered and runs again. Without this check, that redelivery spends
    // another 90-second fetch and another LLM call to produce a result that
    // is already sitting in the cache.
    //
    // "At-least-once" is the honest description of nearly every queue,
    // BullMQ included. Exactly-once delivery is not really available; what
    // is available is at-least-once delivery plus an idempotent consumer,
    // and this branch is the idempotent consumer.
    const existing = await cache.read(playerId, season);
    if (existing !== null) {
      return {
        status: "skipped",
        playerId,
        season,
        reason: `already warm, cached at ${existing.warmedAt}`,
      };
    }

    // Both fetches at once rather than one after the other.
    //
    // They are independent, and each can take up to 90 seconds against
    // stats.nba.com, so awaiting them in sequence would make the job take as
    // long as the sum rather than the slower of the two. Promise.all is the
    // whole difference between concurrent and merely asynchronous, and it is
    // a fair interview question: `await a(); await b();` is sequential
    // despite both being async.
    //
    // Promise.all is also correctly typed: the tuple that comes back is
    // [ShotsPayload, SplitsPayload], not an array of the union, so
    // destructuring gives each variable its own type with no cast.
    //
    // It rejects as soon as EITHER rejects, which is what we want -- there
    // is nothing useful to cache with half the data. Note the other half
    // keeps running in the background; that is harmless here because the
    // failure will be retried, but it is worth knowing rather than assuming
    // the loser is cancelled.
    const [shots, splits] = await Promise.all([
      client.getShots(playerId, season),
      client.getSplits(playerId, season),
    ]);

    await cache.write(playerId, season, {
      shots,
      splits,
      warmedAt: new Date(now()).toISOString(),
    });

    // Reporting what the upstream ACTUALLY did rather than what was asked
    // for. If both payloads came from the Python service's own file cache,
    // this job did nothing slow, and a run of "cache"/"cache" results is the
    // signal that the queue is warming things nobody needed.
    return {
      status: "warmed",
      playerId,
      season,
      shotsSource: shots.meta.source,
      splitsSource: splits.meta.source,
      shotCount: shots.shots.length,
      hasTracking: shots.meta.hasTracking,
      durationMs: now() - startedAt,
    };
  };
}
