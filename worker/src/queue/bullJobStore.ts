import type { Job } from "bullmq";
import type { Redis } from "ioredis";

import type { JobStore, SubmitOutcome } from "../api/jobStore.js";
import type {
  JobRecord,
  JobState,
  WarmJobData,
  WarmResult,
} from "../types/models.js";
import type { WarmQueue } from "./warmQueue.js";
import { warmJobId } from "./jobId.js";

/**
 * BullMQ's own states, mapped onto ours.
 *
 * BullMQ distinguishes several kinds of not-yet-running -- waiting, delayed,
 * prioritised, waiting-children -- which matter to the queue and not at all
 * to a caller polling for a result. Collapsing them into "queued" keeps the
 * public API stable if BullMQ adds another one.
 *
 * The `default` branch is deliberate rather than lazy. getState() returns a
 * plain string union from a library, so an upgrade can add a member; falling
 * back to "queued" means an unrecognised state reads as "not finished yet",
 * which is the safe reading. Throwing would turn a library upgrade into an
 * outage, and asserting exhaustiveness with `never` -- the right tool when
 * WE own the union, and used in step 6 for exactly that -- is the wrong tool
 * when somebody else does.
 */
function toJobState(bullState: string): JobState {
  switch (bullState) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "active":
      return "active";
    default:
      return "queued";
  }
}

async function toJobRecord(job: Job<WarmJobData, WarmResult>): Promise<JobRecord> {
  const state = toJobState(await job.getState());

  return {
    // `job.id` is typed `string | undefined` because BullMQ allows an id to
    // be absent in some flows. Ours never is -- we always pass one -- but
    // the type describes the library's full range, not our usage, so the
    // fallback is required rather than defensive noise.
    jobId: job.id ?? warmJobId(job.data.playerId, job.data.season),
    state,
    data: job.data,
    acceptedAt: new Date(job.timestamp).toISOString(),

    // returnvalue is whatever the processor resolved with, and is undefined
    // until then. Normalised to null so the field is always present and the
    // JSON shape does not change between polls.
    //
    // A failed job has no returnvalue at all -- the processor threw, so it
    // never returned anything. The "failed" member of WarmResult is
    // therefore assembled HERE, from what BullMQ actually recorded, rather
    // than being something the processor claims about itself. Otherwise a
    // caller polling a failed job would get result: null and no idea why.
    result: state === "failed" ? failureResult(job) : (job.returnvalue ?? null),
  };
}

function failureResult(job: Job<WarmJobData, WarmResult>): WarmResult {
  return {
    status: "failed",
    playerId: job.data.playerId,
    season: job.data.season,
    // failedReason is BullMQ's record of the thrown error's message.
    error: job.failedReason ?? "unknown failure",
    // attemptsMade is what makes a first failure distinguishable from an
    // exhausted retry budget in the logs, which is the difference between
    // "flaky upstream" and "this will never work".
    attempt: job.attemptsMade,
  };
}

/**
 * The real store: same interface as the Map, backed by Redis.
 *
 * Everything the in-memory version could not do, this does for free, and
 * each is worth naming because they are the reasons the queue exists:
 * the jobs outlive the process, several API replicas share one view of them,
 * and something else entirely can consume them.
 */
/**
 * How long the "who created this" marker lives. Deliberately the same 3600
 * seconds as removeOnComplete's age, so the marker and the job it describes
 * expire together rather than one outliving the other.
 */
const CLAIM_TTL_SECONDS = 3600;

export function createBullJobStore(
  queue: WarmQueue,
  connection: Redis,
): JobStore {
  return {
    async submit(data: WarmJobData): Promise<SubmitOutcome> {
      const jobId = warmJobId(data.playerId, data.season);

      // Passing a jobId that already exists makes BullMQ return the EXISTING
      // job rather than creating a second one or throwing, and it decides
      // that inside a Lua script Redis runs atomically. So this single call
      // is what guarantees one job per player-season even when several API
      // replicas submit at the same instant.
      const job = await queue.add("warm", data, { jobId });

      // Telling the caller WHICH of them created it is a separate problem,
      // and getting it wrong is what the concurrency test caught.
      //
      // The obvious implementation -- getJob() first, and if nothing comes
      // back call it accepted -- is check-then-act, and it is a race. Ten
      // concurrent submissions all find nothing, all call add(), and all are
      // told they created the job. Exactly one job existed, so the important
      // guarantee held, but nine callers got a 202 and deduplicated:false
      // for work they did not cause. The bug was invisible sequentially and
      // obvious the moment ten requests overlapped.
      //
      // SET NX is the atomic answer: set this key only if it does not exist.
      // Redis performs the test and the write as one operation, so exactly
      // one caller can ever be told "OK" no matter how many arrive together.
      //
      // Worth being precise about what this key is and is not. The JOB is
      // the source of truth for what exists; this marker only records who
      // got there first. If the two ever diverge -- the marker expiring
      // while the job lives on past its best-effort eviction -- the cost is
      // a 202 where a 200 belonged. Informational, never duplicated work.
      const claimed = await connection.set(
        `claim:${jobId}`,
        new Date().toISOString(),
        "EX",
        CLAIM_TTL_SECONDS,
        "NX",
      );

      // toJobRecord re-reads the state rather than assuming "queued". By the
      // time this runs a worker may already have picked the job up, and
      // reporting a state we guessed instead of one we read is how a status
      // endpoint starts lying.
      const record = await toJobRecord(job);

      return claimed === "OK"
        ? { kind: "accepted", job: record }
        : { kind: "duplicate", job: record };
    },

    async get(jobId: string): Promise<JobRecord | undefined> {
      const job = await queue.getJob(jobId);
      return job === undefined ? undefined : await toJobRecord(job);
    },

    async size(): Promise<number> {
      // Counts every state a job can sit in, so this means "jobs known to
      // the queue" rather than "jobs waiting", which is what the tests
      // asserting deduplication actually need.
      const counts = await queue.getJobCounts();
      return Object.values(counts).reduce((total, n) => total + n, 0);
    },

    async close(): Promise<void> {
      await queue.close();
    },
  };
}
