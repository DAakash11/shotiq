import { describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

import { createWarmProcessor } from "./processor.js";
import type { WarmCache, WarmedEntry } from "../cache/warmCache.js";
import type { ShotiqClient } from "../fetchers/shotiqClient.js";
import { UpstreamError } from "../fetchers/shotiqClient.js";
import type {
  ShotsPayload,
  SplitsPayload,
  WarmJobData,
  WarmResult,
} from "../types/models.js";

/**
 * Fakes rather than mocks of a library.
 *
 * The processor takes its collaborators as arguments, so a test supplies
 * plain objects that satisfy the interfaces. No module interception, no
 * vi.mock of ioredis or fetch -- and because the fakes are typed as
 * ShotiqClient and WarmCache, a change to either interface breaks these at
 * COMPILE time rather than leaving a fake that silently no longer resembles
 * the real thing. That is the failure mode of mocking by module path, and
 * it is worth knowing the difference.
 */
function shotsFixture(overrides: Partial<ShotsPayload["meta"]> = {}): ShotsPayload {
  return {
    meta: {
      playerId: 201939,
      player: "Stephen Curry",
      season: "2016-17",
      seasonType: "Regular Season",
      hasTracking: true,
      source: "live",
      fetchedAt: "2026-08-18T00:00:00+00:00",
      team: "Golden State Warriors",
      attempts: 1443,
      made: 675,
      fgPct: 0.468,
      ...overrides,
    },
    shots: [],
    leagueAverages: [],
  };
}

function splitsFixture(source: "live" | "cache" = "live"): SplitsPayload {
  return {
    meta: {
      playerId: 201939,
      player: "Stephen Curry",
      season: "2016-17",
      seasonType: "Regular Season",
      hasTracking: true,
      source,
      fetchedAt: "2026-08-18T00:00:00+00:00",
      games: 79,
    },
    overall: null,
    splits: {
      shotClock: [],
      defenderDistance: [],
      dribbles: [],
      touchTime: [],
      general: [],
    },
  };
}

/** Only the fields the processor touches. */
function fakeJob(data: WarmJobData): Job<WarmJobData, WarmResult> {
  return { data } as Job<WarmJobData, WarmResult>;
}

function fakeCache(initial: WarmedEntry | null = null): WarmCache & {
  written: WarmedEntry[];
} {
  const written: WarmedEntry[] = [];
  return {
    written,
    async read() {
      return initial;
    },
    async write(_playerId, _season, entry) {
      written.push(entry);
    },
    async invalidate() {
      // Unused by the processor, but required by the interface -- and the
      // compiler said so the moment invalidate was added to WarmCache. That
      // is the argument for typed fakes over vi.mock of a module path: a
      // path-based mock would have silently stopped matching the real thing.
    },
  };
}

describe("the happy path", () => {
  it("fetches both payloads, caches them, and reports what it did", async () => {
    const cache = fakeCache();
    const client: ShotiqClient = {
      getShots: async () => shotsFixture(),
      getSplits: async () => splitsFixture(),
    };

    // A fake clock, so the duration is asserted rather than merely observed
    // to be a number. Real timing in a test is either slow or flaky.
    let tick = 1000;
    const process = createWarmProcessor({
      client,
      cache,
      now: () => {
        tick += 250;
        return tick;
      },
    });

    const result = await process(fakeJob({ playerId: 201939, season: "2016-17" }));

    expect(result.status).toBe("warmed");
    if (result.status === "warmed") {
      // Narrowed by the discriminant, so these fields are readable with no
      // cast. In the "skipped" branch the compiler would refuse them.
      expect(result.shotCount).toBe(0);
      expect(result.shotsSource).toBe("live");
      expect(result.hasTracking).toBe(true);
      expect(result.durationMs).toBeGreaterThan(0);
    }

    expect(cache.written).toHaveLength(1);
  });

  it("reports the upstream's own source, not what was asked for", async () => {
    // Both payloads served from the Python service's file cache means this
    // job did nothing slow. A run of these is the signal that the queue is
    // warming subjects nobody needed.
    const client: ShotiqClient = {
      getShots: async () => shotsFixture({ source: "cache" }),
      getSplits: async () => splitsFixture("cache"),
    };

    const result = await createWarmProcessor({ client, cache: fakeCache() })(
      fakeJob({ playerId: 201939, season: "2016-17" }),
    );

    expect(result).toMatchObject({ shotsSource: "cache", splitsSource: "cache" });
  });

  it("fetches shots and splits concurrently, not one after the other", async () => {
    /**
     * The assertion is about ORDER, not speed, so it cannot be flaky.
     *
     * Both fetches record when they started. If the processor awaited them
     * in sequence, the second could not begin until the first had resolved,
     * so its start would be recorded after the first's finish. Under
     * Promise.all both start before either finishes.
     *
     * Worth being able to explain: `await a(); await b();` is sequential
     * even though both are async. Async means "does not block the thread",
     * not "runs at the same time as the next line".
     */
    const events: string[] = [];
    const client: ShotiqClient = {
      getShots: async () => {
        events.push("shots:start");
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push("shots:end");
        return shotsFixture();
      },
      getSplits: async () => {
        events.push("splits:start");
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push("splits:end");
        return splitsFixture();
      },
    };

    await createWarmProcessor({ client, cache: fakeCache() })(
      fakeJob({ playerId: 201939, season: "2016-17" }),
    );

    expect(events.slice(0, 2)).toEqual(["shots:start", "splits:start"]);
  });
});

describe("idempotency of the work itself", () => {
  it("skips entirely when the subject is already cached", async () => {
    // The guarantee that makes at-least-once delivery affordable: a
    // redelivered job costs a Redis read rather than two 90-second fetches.
    const client: ShotiqClient = {
      getShots: vi.fn(async () => shotsFixture()),
      getSplits: vi.fn(async () => splitsFixture()),
    };

    const cache = fakeCache({
      shots: shotsFixture(),
      splits: splitsFixture(),
      warmedAt: "2026-08-18T00:00:00.000Z",
    });

    const result = await createWarmProcessor({ client, cache })(
      fakeJob({ playerId: 201939, season: "2016-17" }),
    );

    expect(result.status).toBe("skipped");
    if (result.status === "skipped") {
      expect(result.reason).toContain("already warm");
    }

    // The point of the test: the upstream was never touched.
    expect(client.getShots).not.toHaveBeenCalled();
    expect(client.getSplits).not.toHaveBeenCalled();
    expect(cache.written).toHaveLength(0);
  });
});

describe("failure", () => {
  it("throws rather than returning a failed result", async () => {
    /**
     * The single easiest thing to get wrong in a queue consumer.
     *
     * Returning { status: "failed" } would tell BullMQ the job SUCCEEDED:
     * it completes, no retry is scheduled, and the failure is visible only
     * to whoever happens to read the result. Throwing is how a processor
     * reports failure, and it is why nothing in the processor catches.
     */
    const client: ShotiqClient = {
      getShots: async () => {
        throw new UpstreamError("upstream responded 503", 503, "/api/shots");
      },
      getSplits: async () => splitsFixture(),
    };

    const cache = fakeCache();

    await expect(
      createWarmProcessor({ client, cache })(
        fakeJob({ playerId: 201939, season: "2016-17" }),
      ),
    ).rejects.toThrow(UpstreamError);

    // Nothing half-written. Promise.all rejects as soon as either side does,
    // so the cache write is never reached -- there is nothing useful to
    // store with half the data.
    expect(cache.written).toHaveLength(0);
  });

  it("does not write a partial entry when only one fetch fails", async () => {
    const client: ShotiqClient = {
      getShots: async () => shotsFixture(),
      getSplits: async () => {
        throw new UpstreamError("timed out", null, "/api/splits");
      },
    };
    const cache = fakeCache();

    await expect(
      createWarmProcessor({ client, cache })(
        fakeJob({ playerId: 201939, season: "2016-17" }),
      ),
    ).rejects.toThrow();

    expect(cache.written).toHaveLength(0);
  });
});
