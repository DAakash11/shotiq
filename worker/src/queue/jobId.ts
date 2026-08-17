/**
 * The idempotency key.
 *
 * Every job this service runs is "warm player X, season Y", and running it
 * twice produces the same cache entry at twice the cost -- against an
 * upstream that is slow (up to 90s to reach stats.nba.com) and an LLM call
 * that is metered. So the job's identity has to be derived from what the job
 * IS, never from when it was requested. Given a deterministic id, BullMQ
 * will refuse to enqueue a second job under an id it already holds, and the
 * duplicate collapses into the first at the moment of submission rather than
 * being detected later by the worker.
 *
 * A timestamp or a UUID here would defeat that entirely: two requests for
 * the same player and season would look like two different jobs, which is
 * the single most common way a queue ends up doing double work.
 */

/** An NBA player id as stats.nba.com issues them, e.g. 201939 (Curry). */
export type PlayerId = number;

/** A season in the NBA's own notation: "2016-17". */
export type SeasonId = string;

/**
 * Namespaces our keys inside Redis, which is a shared key space. Without a
 * prefix, a job id could collide with an unrelated key set by any other
 * user of the same Redis instance.
 */
export const JOB_ID_PREFIX = "warm";

/** "2016-17" -- four digits, hyphen, two digits. */
const SEASON_PATTERN = /^\d{4}-\d{2}$/;

/**
 * A type guard. The `value is SeasonId` return type is a promise to the
 * compiler: if this returns true, treat the argument as a SeasonId from
 * here on. Inside an `if`, TypeScript narrows `unknown` down to a usable
 * type -- which is why the parameter is `unknown` and not `any`.
 *
 * The distinction matters. `any` switches type-checking off for that value
 * and lets every subsequent mistake through silently. `unknown` says "I do
 * not know what this is", and the compiler then refuses every operation on
 * it until something like this function has proven what it is. `unknown` is
 * the correct type for anything arriving from outside the program.
 */
export function isSeasonId(value: unknown): value is SeasonId {
  return typeof value === "string" && SEASON_PATTERN.test(value);
}

/**
 * Builds the deterministic job id for a player-season.
 *
 * Deliberately mirrors the naming the Python side already uses for its cache
 * files (`shots-201939-2016-17.json`), so the same two facts identify the
 * same unit of work on both sides of the stack.
 */
export function warmJobId(playerId: PlayerId, season: SeasonId): string {
  return `${JOB_ID_PREFIX}:${playerId}:${season}`;
}
