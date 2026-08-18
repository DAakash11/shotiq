import { describe, expect, it } from "vitest";

import { describeWarmResult, hasTrackingData } from "./models.js";
import type {
  ShotRecord,
  SplitRow,
  SplitsPayload,
  WarmResult,
} from "./models.js";

/**
 * These fixtures are trimmed copies of REAL responses from the running API,
 * not invented shapes -- Curry 2016-17 for the tracked case and Jokic
 * 2009-10 for the pre-tracking one.
 *
 * `satisfies` rather than `: ShotRecord`. Both check the object against the
 * type, but an annotation also WIDENS the variable to that type, so
 * `curryShot.shotType` would read as `ShotType`. With `satisfies` the check
 * happens and the narrow literal is kept, so it reads as exactly "3PT".
 * Checked, without throwing away what the compiler already knew.
 */
const curryShot = {
  id: "0021600003-19",
  gameDate: "2016-10-25",
  opponent: "SAS",
  isHome: true,
  period: 1,
  clock: "9:02",
  secondsLeftInPeriod: 542,
  actionType: "Jump Shot",
  shotType: "3PT",
  zone: "Above the Break 3",
  zoneArea: "Right Side Center(RC)",
  zoneRange: "24+ ft.",
  distanceFt: 28,
  angleDeg: 26.8,
  locX: 130,
  locY: 257,
  made: false,
} satisfies ShotRecord;

/** The location-less attempt: 1 of 1,443, and angleDeg null on 317 of them. */
const shotWithNoLocation = {
  ...curryShot,
  id: "0021600100-7",
  zone: null,
  zoneArea: null,
  zoneRange: null,
  distanceFt: null,
  angleDeg: null,
  locX: null,
  locY: null,
} satisfies ShotRecord;

const overallRow = {
  label: "Overall",
  sortOrder: 1,
  games: 79,
  frequency: 1.0,
  fgm: 675,
  fga: 1443,
  fgPct: 0.468,
  efgPct: 0.58,
  fg2m: 351,
  fg2a: 654,
  fg2Pct: 0.537,
  fg3m: 324,
  fg3a: 789,
  fg3Pct: 0.411,
} satisfies SplitRow;

/** The unlabelled shot-clock bucket, exactly as the API returns it. */
const unlabelledRow = {
  ...overallRow,
  label: null,
  sortOrder: null,
  fg3a: 0,
  fg3m: 0,
  fg3Pct: null,
} satisfies SplitRow;

const trackedSplits = {
  meta: {
    playerId: 201939,
    player: "Stephen Curry",
    season: "2016-17",
    seasonType: "Regular Season",
    hasTracking: true,
    source: "cache",
    fetchedAt: "2026-08-15T12:29:13+00:00",
    games: 79,
  },
  overall: overallRow,
  splits: {
    shotClock: [unlabelledRow],
    defenderDistance: [],
    dribbles: [],
    touchTime: [],
    general: [],
  },
} satisfies SplitsPayload;

/** Jokic 2009-10: predates tracking, so overall is null and every array empty. */
const untrackedSplits = {
  meta: {
    playerId: 203999,
    player: "Nikola Jokić",
    season: "2009-10",
    seasonType: "Regular Season",
    hasTracking: false,
    source: "live",
    fetchedAt: "2026-08-18T10:48:25+00:00",
    games: null,
  },
  overall: null,
  splits: {
    shotClock: [],
    defenderDistance: [],
    dribbles: [],
    touchTime: [],
    general: [],
  },
} satisfies SplitsPayload;

describe("the models accept the real payload shapes", () => {
  it("accepts a fully located shot", () => {
    expect(curryShot.shotType).toBe("3PT");
  });

  it("accepts an attempt with no location at all", () => {
    // If ShotRecord had typed these as non-nullable, this file would not
    // compile -- which is the actual assertion. The expect below only
    // documents it for a reader running the suite.
    expect(shotWithNoLocation.angleDeg).toBeNull();
  });

  it("accepts a rate that is null because there were no attempts", () => {
    expect(unlabelledRow.fg3a).toBe(0);
    expect(unlabelledRow.fg3Pct).toBeNull();
  });
});

describe("hasTrackingData", () => {
  it("is true for a season with tracking, and narrows overall to non-null", () => {
    expect(hasTrackingData(trackedSplits)).toBe(true);

    if (hasTrackingData(trackedSplits)) {
      // The point of the guard. Outside this block `overall` is
      // `SplitRow | null` and reading .fgPct is a compile error; inside, the
      // compiler has narrowed it to SplitRow and the access is allowed with
      // no `!` and no cast.
      expect(trackedSplits.overall.fgPct).toBeCloseTo(0.468);
    }
  });

  it("is false for a pre-tracking season", () => {
    expect(hasTrackingData(untrackedSplits)).toBe(false);
  });

  it("still returns all five split keys when there is no tracking", () => {
    // The API's contract: empty arrays, never missing keys. Code that reads
    // splits.dribbles can do so unconditionally.
    expect(Object.keys(untrackedSplits.splits).sort()).toEqual([
      "defenderDistance",
      "dribbles",
      "general",
      "shotClock",
      "touchTime",
    ]);
  });
});

describe("describeWarmResult and the never check", () => {
  it("describes every member of the union", () => {
    /**
     * The test is the smaller half of this guarantee, and worth being clear
     * about which half does what.
     *
     * This asserts the three current members read correctly. What it CANNOT
     * do is notice a fourth being added -- a test only covers cases somebody
     * thought to write. The `default: assertNever(result)` branch in
     * describeWarmResult is what covers that: add a member and the file
     * stops compiling, naming the type it could not narrow away.
     *
     * A compiler-generated to-do list, in other words, which is something no
     * test can produce.
     */
    expect(
      describeWarmResult({
        status: "warmed",
        playerId: 201939,
        season: "2016-17",
        shotsSource: "cache",
        splitsSource: "live",
        shotCount: 1443,
        hasTracking: true,
        durationMs: 319,
      }),
    ).toBe("warmed 1443 shots in 319ms (cache/live)");

    expect(
      describeWarmResult({
        status: "skipped",
        playerId: 201939,
        season: "2016-17",
        reason: "already warm",
      }),
    ).toBe("skipped: already warm");

    expect(
      describeWarmResult({
        status: "failed",
        playerId: 201939,
        season: "2016-17",
        error: "upstream 503",
        attempt: 3,
      }),
    ).toBe("failed on attempt 3: upstream 503");
  });

  it("throws if an unknown member reaches it at runtime", () => {
    // The `throw` inside assertNever is unreachable by construction, but the
    // runtime is where types do not exist -- a result deserialised from an
    // older version could arrive with a status nothing handles. Better a
    // named error than falling off the end of the function returning
    // undefined.
    const impossible = { status: "exploded" } as unknown as Parameters<
      typeof describeWarmResult
    >[0];

    expect(() => describeWarmResult(impossible)).toThrow(/unhandled case/);
  });
});

describe("WarmResult", () => {
  it("narrows on status so each branch sees only its own fields", () => {
    const results: WarmResult[] = [
      {
        status: "warmed",
        playerId: 201939,
        season: "2016-17",
        shotsSource: "live",
        splitsSource: "live",
        shotCount: 1443,
        hasTracking: true,
        durationMs: 8210,
      },
      {
        status: "skipped",
        playerId: 201939,
        season: "2016-17",
        reason: "already warm",
      },
      {
        status: "failed",
        playerId: 203999,
        season: "2009-10",
        error: "upstream 503",
        attempt: 2,
      },
    ];

    const described = results.map((result) => {
      // No casts anywhere below. Each branch reads fields that exist only in
      // that member, and the compiler permits it because `status` told it
      // which member it is holding.
      switch (result.status) {
        case "warmed":
          return `warmed ${result.shotCount} shots in ${result.durationMs}ms`;
        case "skipped":
          return `skipped: ${result.reason}`;
        case "failed":
          return `failed on attempt ${result.attempt}: ${result.error}`;
      }
    });

    expect(described).toEqual([
      "warmed 1443 shots in 8210ms",
      "skipped: already warm",
      "failed on attempt 2: upstream 503",
    ]);
  });
});
