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

export interface JobStore {
  submit(data: WarmJobData): SubmitOutcome;
  get(jobId: string): JobRecord | undefined;
  size(): number;
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
    submit(data: WarmJobData): SubmitOutcome {
      const jobId = warmJobId(data.playerId, data.season);

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

    get(jobId: string): JobRecord | undefined {
      return jobs.get(jobId);
    },

    size(): number {
      return jobs.size;
    },
  };
}
