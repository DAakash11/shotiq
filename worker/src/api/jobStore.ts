/**
 * A stand-in for the queue.
 *
 * Deliberately a plain Map, and deliberately temporary -- step 4 replaces it
 * with BullMQ and Redis. It exists so the HTTP layer can be built and tested
 * against a real interface before any of that lands, which keeps the two
 * concerns separable: if a request misbehaves after step 4, the fault is in
 * the queue wiring, because the routes were already proven against this.
 *
 * Everything wrong with it is instructive, and is exactly the argument for
 * the queue:
 *
 *   - The Map lives in one process's heap. Two API replicas would each have
 *     their own and neither would see the other's jobs.
 *   - A restart loses every job, with no record that they existed.
 *   - Nothing ever consumes from it, so a job sits at "queued" forever.
 *
 * The deduplication below, however, is real, and it survives the swap: the
 * job id is derived from the player and season, so asking twice for the same
 * subject collides by construction rather than by luck.
 */

import type { JobRecord, WarmJobData } from "../types/models.js";
import { warmJobId } from "../queue/jobId.js";

/**
 * What happened when a job was submitted.
 *
 * Another discriminated union, and it earns its keep at the HTTP layer: the
 * two cases deserve different status codes, and having the compiler force
 * the caller to consider both is how that stays true when the code changes.
 */
export type SubmitOutcome =
  | { readonly kind: "accepted"; readonly job: JobRecord }
  | { readonly kind: "duplicate"; readonly job: JobRecord };

/**
 * Every method returns a Promise, including the in-memory implementation's,
 * where nothing is actually asynchronous.
 *
 * That is the point. The interface has to describe the SLOWEST plausible
 * implementation, not the one that happens to exist first. Redis is a
 * network hop, so the real store cannot answer synchronously -- and if this
 * interface were synchronous, swapping it in would break every call site at
 * once, late, in code that had been written assuming an immediate answer.
 *
 * Async is contagious in exactly this way: a function that awaits something
 * must itself be async, and so must its caller, all the way up. Deciding
 * that boundary early costs nothing; discovering it late is a refactor.
 *
 * `Promise<T>` is a generic type -- the T is what the promise eventually
 * produces. `Promise<JobRecord | undefined>` says "later, either a record or
 * nothing", which is a different claim from `Promise<JobRecord> | undefined`
 * ("either a promise, or nothing at all, right now"). Reading that
 * distinction correctly is most of learning to type async code.
 */
export interface SubmitOptions {
  /**
   * Force the work to happen again.
   *
   * Deliberately NOT part of WarmJobData. It describes how this submission
   * should be handled, not what the job is -- and if it were job data it
   * would change the payload without changing the job id, so a refresh
   * request and a normal one would deduplicate into each other.
   */
  readonly refresh?: boolean;
}

export interface JobStore {
  submit(data: WarmJobData, options?: SubmitOptions): Promise<SubmitOutcome>;
  get(jobId: string): Promise<JobRecord | undefined>;
  size(): Promise<number>;
  /** Releases whatever the implementation holds. A no-op for the Map. */
  close(): Promise<void>;
}

/**
 * A factory function rather than a module-level Map.
 *
 * Module state is shared by every importer, so tests would leak jobs into
 * one another and pass or fail depending on the order they ran in. A factory
 * gives each test its own store, which is the difference between a suite you
 * can trust and one you rerun until it goes green.
 */
export function createInMemoryJobStore(): JobStore {
  const jobs = new Map<string, JobRecord>();

  return {
    // `async` on a method that awaits nothing is not waste: it makes the
    // return type Promise<SubmitOutcome> automatically, so this satisfies
    // the interface without every return statement being wrapped in
    // Promise.resolve by hand.
    async submit(data: WarmJobData, options?: SubmitOptions): Promise<SubmitOutcome> {
      const jobId = warmJobId(data.playerId, data.season);

      if (options?.refresh === true) {
        jobs.delete(jobId);
      }

      const existing = jobs.get(jobId);
      if (existing !== undefined) {
        return { kind: "duplicate", job: existing };
      }

      const job: JobRecord = {
        jobId,
        state: "queued",
        data,
        acceptedAt: new Date().toISOString(),
        result: null,
      };
      jobs.set(jobId, job);
      return { kind: "accepted", job };
    },

    async get(jobId: string): Promise<JobRecord | undefined> {
      return jobs.get(jobId);
    },

    async size(): Promise<number> {
      return jobs.size;
    },

    async close(): Promise<void> {
      jobs.clear();
    },
  };
}
