/**
 * The data models.
 *
 * Every shape here was written against a REAL response from the running
 * FastAPI (Curry 2016-17 for the tracked case, Jokic 2009-10 for the
 * pre-tracking case), not from reading the Python and inferring. Several
 * fields below would have been wrong if they had been guessed, and each of
 * those carries a comment saying so -- a type that lies is worse than no
 * type, because it stops you checking.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** An NBA player id as stats.nba.com issues them, e.g. 201939 (Curry). */
export type PlayerId = number;

/** A season in the NBA's own notation: "2016-17". */
export type SeasonId = string;

/**
 * Where a payload came from. A closed set, confirmed by reading every call
 * site of nba_source._meta -- both pass the literal "live", and the cache
 * path overwrites it with "cache" afterwards. Nothing else can appear.
 *
 * This is a UNION OF LITERAL TYPES: the type is not "string" but "one of
 * exactly these two strings". Misspell it as "cached" and the compiler
 * stops you, which is the whole reason to prefer it over `string` when the
 * set really is closed.
 *
 * Worth caring about here: it tells the worker whether it did any real work
 * or merely re-read a file that was already warm.
 */
export type PayloadSource = "live" | "cache";

/**
 * NOT a literal union, deliberately.
 *
 * The obvious guess is `"Regular Season" | "Playoffs"`. That would be wrong:
 * config.py reads it from the SHOTIQ_SEASON_TYPE environment variable with
 * "Regular Season" merely as the default, so the value is open-ended and
 * whoever runs the container decides it. Pinning a union here would compile
 * cleanly and then misdescribe reality the first time someone set that
 * variable.
 *
 * The rule this illustrates: only write a literal union when you have
 * checked that the set is genuinely closed.
 */
export type SeasonType = string;

// ---------------------------------------------------------------------------
// /api/shots
// ---------------------------------------------------------------------------

/**
 * Verified closed: every one of Curry's 1,443 attempts is one of these two,
 * and the value is derived from the NBA's own 2PT/3PT classification.
 */
export type ShotType = "2PT" | "3PT";

/**
 * One field-goal attempt.
 *
 * `readonly` throughout. These objects are decoded from JSON that arrived
 * over the wire and describe something that already happened -- there is no
 * such thing as legitimately editing a shot. The modifier costs nothing at
 * runtime (it is erased like everything else) and makes an accidental
 * `shot.made = true` inside a mapping function a compile error rather than a
 * corrupted result nobody notices.
 */
export interface ShotRecord {
  /** "0021600003-19" -- game id and event number. A string, not a number. */
  readonly id: string;
  /** ISO date, "2016-10-25". */
  readonly gameDate: string;
  /** Three-letter opponent code, "SAS". */
  readonly opponent: string;
  readonly isHome: boolean;
  /** 1-4 in regulation and 5, 6, ... in overtime. NOT a 1|2|3|4 union: both
   *  5 and 6 appear in the single season checked. */
  readonly period: number;
  /** Game clock as displayed, "9:02". */
  readonly clock: string;
  readonly secondsLeftInPeriod: number;
  /** Free text from the NBA, e.g. "Jump Shot". Open set -- there are dozens. */
  readonly actionType: string;
  readonly shotType: ShotType;

  /**
   * Nullable, and this is NOT a rare edge case to wave away.
   *
   * The NBA's feed carries attempts with no location attached. In the one
   * season measured: zone, zoneArea, zoneRange, distanceFt, locX and locY
   * are null on 1 shot of 1,443 -- but angleDeg is null on 317 of them,
   * 22% of the season. Typing angleDeg as `number` would have compiled
   * perfectly and then produced NaN through a fifth of the data.
   *
   * This is the payoff from strictNullChecks: every one of these forces a
   * decision at the point of use instead of an undefined at runtime.
   */
  readonly zone: string | null;
  readonly zoneArea: string | null;
  readonly zoneRange: string | null;
  readonly distanceFt: number | null;
  readonly angleDeg: number | null;
  readonly locX: number | null;
  readonly locY: number | null;

  readonly made: boolean;
}

/**
 * A league-wide baseline for one zone, used to say whether a player is above
 * or below average there.
 *
 * The null-zone row is real and present -- one of the 21 rows has null for
 * all three zone fields. That is the unlabelled bucket the Python and JS
 * aggregators both drop on purpose. It is typed honestly here rather than
 * pretended away, because the worker's job is to carry the payload
 * faithfully; deciding what to drop belongs to the code that computes.
 */
export interface LeagueAverage {
  readonly zone: string | null;
  readonly zoneArea: string | null;
  readonly zoneRange: string | null;
  readonly fga: number;
  readonly fgm: number;
  readonly fgPct: number;
}

export interface ShotsMeta {
  readonly playerId: PlayerId;
  readonly player: string;
  readonly season: SeasonId;
  readonly seasonType: SeasonType;
  readonly hasTracking: boolean;
  readonly source: PayloadSource;
  /** ISO-8601 with offset: "2026-08-15T12:29:11+00:00". */
  readonly fetchedAt: string;
  /** Null when the season returned no shots at all -- nba_source reads it
   *  from raw_shots[0], which does not exist for an empty result. */
  readonly team: string | null;
  readonly attempts: number;
  readonly made: number;
  readonly fgPct: number;
}

export interface ShotsPayload {
  readonly meta: ShotsMeta;
  readonly shots: readonly ShotRecord[];
  readonly leagueAverages: readonly LeagueAverage[];
}

// ---------------------------------------------------------------------------
// /api/splits
// ---------------------------------------------------------------------------

/**
 * The five split categories the API always returns. Always all five keys,
 * even for a season that predates tracking -- there the arrays are empty
 * rather than the keys being absent, which is a friendlier contract and
 * worth typing as the certainty it is.
 */
export type SplitCategory =
  | "shotClock"
  | "defenderDistance"
  | "dribbles"
  | "touchTime"
  | "general";

/** One row of a split table: "with a defender 4-6 feet away, he shot ...". */
export interface SplitRow {
  /**
   * Nullable, and the null carries meaning. One of the seven shot-clock rows
   * has a null label -- the unlabelled bucket that both aggregators drop,
   * because a row you cannot name cannot be described to a reader (or to an
   * LLM) without inventing a name for it.
   */
  readonly label: string | null;
  readonly sortOrder: number | null;
  readonly games: number;
  /** Share of the player's attempts falling in this row, 0-1. */
  readonly frequency: number;
  readonly fgm: number;
  readonly fga: number;
  readonly fgPct: number;
  readonly efgPct: number;
  readonly fg2m: number;
  readonly fg2a: number;
  readonly fg2Pct: number;
  readonly fg3m: number;
  readonly fg3a: number;
  /**
   * Nullable where the other rates are not, and it is not an oversight in
   * the API: a rate with zero attempts is null, never 0. Zero would claim
   * the player tried and missed every time; null says he never tried. One
   * row in the season measured has fg3a of 0 and fg3Pct of null.
   */
  readonly fg3Pct: number | null;
}

/**
 * A MAPPED TYPE: "for every key K in SplitCategory, a readonly array of
 * SplitRow". It means the same as writing the five keys out by hand, except
 * that adding a sixth category to SplitCategory updates this automatically
 * instead of leaving a gap nobody notices.
 */
export type SplitsByCategory = {
  readonly [K in SplitCategory]: readonly SplitRow[];
};

export interface SplitsMeta {
  readonly playerId: PlayerId;
  readonly player: string;
  readonly season: SeasonId;
  readonly seasonType: SeasonType;
  readonly hasTracking: boolean;
  readonly source: PayloadSource;
  readonly fetchedAt: string;
  /** Null for a pre-tracking season, where there is no games count to give. */
  readonly games: number | null;
}

/**
 * The whole splits response.
 *
 * `overall` is nullable and that is the single most important thing on this
 * page. Asking for a season before 2013-14 returns overall: null with all
 * five split arrays empty -- verified against Jokic 2009-10, not assumed.
 * Typing it as SplitRow would compile and then throw
 * "Cannot read properties of null" the first time anyone requested an old
 * season. Because it is `| null`, TypeScript now refuses to let any code
 * read overall.fgPct without handling the null first.
 */
export interface SplitsPayload {
  readonly meta: SplitsMeta;
  readonly overall: SplitRow | null;
  readonly splits: SplitsByCategory;
}

// ---------------------------------------------------------------------------
// Our own types: the job and its outcome
// ---------------------------------------------------------------------------

/** What a caller posts to ask for a player-season to be warmed. */
export interface WarmJobData {
  readonly playerId: PlayerId;
  readonly season: SeasonId;
  /**
   * Optional -- the `?` means the property may be absent entirely, which is
   * different from being present and undefined. Off by default because the
   * summary costs money; a caller has to ask for it deliberately. Same
   * fail-closed reasoning as SHOTIQ_SUMMARY_LIVE on the Python side.
   */
  readonly includeSummary?: boolean;
}

/**
 * A DISCRIMINATED UNION, and the reason to reach for one.
 *
 * Every member has a `status` field whose type is a distinct literal, so
 * `status` is the discriminant. Inside `if (result.status === "warmed")`
 * TypeScript narrows the whole object to that one member and lets you read
 * `durationMs`; in the "failed" branch it lets you read `error` and REFUSES
 * `durationMs`, because that field does not exist there.
 *
 * The alternative -- one flat interface with every field optional -- would
 * compile just as well and describe an object that cannot exist, where a
 * result could carry both an error and a duration, or neither. A
 * discriminated union makes the illegal states unrepresentable, which is
 * the phrase worth having ready in an interview.
 */
export type WarmResult =
  | {
      readonly status: "warmed";
      readonly playerId: PlayerId;
      readonly season: SeasonId;
      /** Whether the upstream actually went to the network. */
      readonly shotsSource: PayloadSource;
      readonly splitsSource: PayloadSource;
      readonly shotCount: number;
      readonly hasTracking: boolean;
      readonly durationMs: number;
    }
  | {
      readonly status: "skipped";
      readonly playerId: PlayerId;
      readonly season: SeasonId;
      /** Why nothing was done -- e.g. already warm within the TTL. */
      readonly reason: string;
    }
  | {
      readonly status: "failed";
      readonly playerId: PlayerId;
      readonly season: SeasonId;
      readonly error: string;
      /** Which attempt this was, so a retry is distinguishable from a
       *  first failure in the logs. */
      readonly attempt: number;
    };

/**
 * A type guard for the pre-tracking case.
 *
 * Note what it does NOT do: narrow on `payload.meta.hasTracking`. TypeScript
 * narrows a union by a discriminant on the object itself, not by a property
 * one level down, so checking meta.hasTracking would read as proof to a
 * human and mean nothing to the compiler. Checking `overall` directly is
 * both the honest test and the one that actually narrows.
 */
export function hasTrackingData(
  payload: SplitsPayload,
): payload is SplitsPayload & { readonly overall: SplitRow } {
  return payload.overall !== null;
}

/**
 * EXHAUSTIVENESS CHECKING, and the reason `never` exists.
 *
 * `never` is the type with no possible values. Nothing can be assigned to
 * it. That sounds useless and is the whole trick: put a parameter of type
 * `never` at the end of a switch over a union, and the code only compiles if
 * every member has already been handled — because only then is the remaining
 * type genuinely empty.
 *
 * Add a fourth member to WarmResult and this stops compiling, in every
 * switch that forgot it, with the error naming exactly which type it could
 * not narrow away. That is a compiler-generated to-do list, and it is one of
 * the few things a type system does that no test can: a test can only check
 * cases someone thought to write.
 *
 * The `throw` is unreachable by construction. It exists for the runtime the
 * types are not present in — a JSON payload from an older version, say — and
 * because a function must still do something if control ever reaches there.
 */
export function assertNever(value: never): never {
  throw new Error(`unhandled case: ${JSON.stringify(value)}`);
}

/**
 * A human-readable line for a result, used in worker logs.
 *
 * Exists mainly to give the exhaustiveness check somewhere real to live: a
 * new WarmResult member breaks this function, so nobody can add one without
 * deciding how it should read in the logs.
 */
export function describeWarmResult(result: WarmResult): string {
  switch (result.status) {
    case "warmed":
      return `warmed ${result.shotCount} shots in ${result.durationMs}ms (${result.shotsSource}/${result.splitsSource})`;
    case "skipped":
      return `skipped: ${result.reason}`;
    case "failed":
      return `failed on attempt ${result.attempt}: ${result.error}`;
    default:
      // If a member is ever added, `result` is not `never` here and this
      // line is a compile error rather than a branch nobody wrote.
      return assertNever(result);
  }
}

// ---------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------

/**
 * The states a job moves through. Named to match BullMQ's own vocabulary so
 * that step 4 can hand these values straight through instead of translating
 * between two sets of words that mean the same thing.
 */
export type JobState = "queued" | "active" | "completed" | "failed";

/** What GET /jobs/:id reports back. */
export interface JobRecord {
  readonly jobId: string;
  readonly state: JobState;
  readonly data: WarmJobData;
  /** ISO-8601, when the job was first accepted. */
  readonly acceptedAt: string;
  /** Present only once the job has finished, either way. */
  readonly result: WarmResult | null;
}
