import type { Redis } from "ioredis";

import type {
  PlayerId,
  SeasonId,
  ShotsPayload,
  SplitsPayload,
} from "../types/models.js";

/**
 * What a completed job leaves behind: the payloads, ready to serve.
 */
export interface WarmedEntry {
  readonly shots: ShotsPayload;
  readonly splits: SplitsPayload;
  /** ISO-8601, when this was written. */
  readonly warmedAt: string;
}

export interface WarmCache {
  read(playerId: PlayerId, season: SeasonId): Promise<WarmedEntry | null>;
  write(playerId: PlayerId, season: SeasonId, entry: WarmedEntry): Promise<void>;
}

/**
 * Six hours. Long enough that a warmed subject stays warm through any
 * plausible browsing session; short enough that an in-progress season, where
 * the numbers genuinely change after every game, does not go stale for days.
 *
 * Note this is a different clock from the queue's one-hour job retention, and
 * they answer different questions: the job TTL controls how soon the same
 * warm can be REQUESTED again, this controls how long the RESULT is served.
 */
const CACHE_TTL_SECONDS = 6 * 60 * 60;

function cacheKey(playerId: PlayerId, season: SeasonId): string {
  // Same shape as the job id and the Python cache filenames, so one subject
  // is recognisable across all three systems by eye.
  return `warmed:${playerId}:${season}`;
}

export function createWarmCache(connection: Redis): WarmCache {
  return {
    async read(playerId, season) {
      const raw = await connection.get(cacheKey(playerId, season));
      if (raw === null) return null;

      try {
        // JSON.parse returns `any`, which is the one place `any` enters a
        // strict codebase whether you like it or not. Annotating the result
        // as WarmedEntry is a claim, not a check -- and it is an acceptable
        // one here only because this process wrote the value itself.
        // Anything arriving from elsewhere would need the treatment the HTTP
        // boundary gets.
        return JSON.parse(raw) as WarmedEntry;
      } catch {
        // A corrupt or half-written value is treated as a miss rather than
        // an error. The cache is an optimisation; failing a request because
        // the optimisation is broken would be the wrong trade, and the next
        // write repairs it.
        return null;
      }
    },

    async write(playerId, season, entry) {
      // Set the value and its expiry in ONE command. `set` then `expire` is
      // two round trips, and a crash between them leaves a key that never
      // expires -- the classic way a Redis instance quietly fills up.
      await connection.set(
        cacheKey(playerId, season),
        JSON.stringify(entry),
        "EX",
        CACHE_TTL_SECONDS,
      );
    },
  };
}
