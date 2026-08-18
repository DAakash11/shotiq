import { afterEach, describe, expect, it, vi } from "vitest";

import { createShotiqClient, UpstreamError } from "./shotiqClient.js";

const BASE = "http://127.0.0.1:8000";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const validShots = {
  meta: { playerId: 201939, hasTracking: true, source: "cache" },
  shots: [],
  leagueAverages: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the fetch trap", () => {
  it("throws on a 500 instead of treating the error page as data", async () => {
    /**
     * The reason this client exists rather than a bare fetch call.
     *
     * fetch RESOLVES on 404 and 500 -- only a network-level failure
     * rejects. So `const data = await (await fetch(url)).json()` hands an
     * error body downstream as though it were a payload, and the failure
     * surfaces much later as a missing field. The React side of this
     * project pins the same check for the same reason.
     */
    vi.stubGlobal("fetch", async () => jsonResponse({ detail: "boom" }, 500));

    const client = createShotiqClient(BASE, 1000);
    await expect(client.getShots(201939, "2016-17")).rejects.toThrow(UpstreamError);
  });

  it("carries the status code, so a retry policy has a fact to decide on", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({}, 503));

    try {
      await createShotiqClient(BASE, 1000).getShots(201939, "2016-17");
      expect.unreachable("should have thrown");
    } catch (error) {
      // instanceof works because the constructor restores the prototype --
      // subclassing a built-in Error is unreliable without that.
      expect(error).toBeInstanceOf(UpstreamError);
      if (error instanceof UpstreamError) {
        expect(error.status).toBe(503);
        expect(error.isRetryable).toBe(true);
      }
    }
  });

  it("treats a 404 as not worth retrying", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({}, 404));

    try {
      await createShotiqClient(BASE, 1000).getShots(1, "2016-17");
      expect.unreachable("should have thrown");
    } catch (error) {
      // Asking again for a player that does not exist fails identically
      // forever. Retrying it spends the budget three times to report the
      // same thing.
      expect((error as UpstreamError).isRetryable).toBe(false);
    }
  });

  it("treats a network failure as retryable, with no status", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });

    try {
      await createShotiqClient(BASE, 1000).getShots(201939, "2016-17");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as UpstreamError).status).toBeNull();
      expect((error as UpstreamError).isRetryable).toBe(true);
    }
  });
});

describe("the response shape is checked before it is trusted", () => {
  it("accepts a well-formed payload", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse(validShots));

    const payload = await createShotiqClient(BASE, 1000).getShots(201939, "2016-17");
    expect(payload.meta.playerId).toBe(201939);
  });

  it("rejects a 200 that is not the expected shape", async () => {
    // A 200 carrying something else -- a version drift, or an error body
    // returned with the wrong status. Without the check this would be cast
    // to ShotsPayload and the compiler would believe every field of it.
    vi.stubGlobal("fetch", async () => jsonResponse({ error: "nope" }));

    await expect(
      createShotiqClient(BASE, 1000).getShots(201939, "2016-17"),
    ).rejects.toThrow(/not the expected shape/);
  });

  it("accepts splits with a null overall, because that is a real season", async () => {
    // A season before 2013-14. Rejecting null here would fail every
    // pre-tracking request for a value the API is documented to return.
    vi.stubGlobal("fetch", async () =>
      jsonResponse({
        meta: { playerId: 203999, hasTracking: false, source: "live" },
        overall: null,
        splits: { shotClock: [], defenderDistance: [], dribbles: [], touchTime: [], general: [] },
      }),
    );

    const payload = await createShotiqClient(BASE, 1000).getSplits(203999, "2009-10");
    expect(payload.overall).toBeNull();
  });
});

describe("the request itself", () => {
  it("sends playerId and season as encoded query parameters", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: URL) => {
      seen.push(url.toString());
      return jsonResponse(validShots);
    });

    await createShotiqClient(BASE, 1000).getShots(201939, "2016-17");

    expect(seen[0]).toBe("http://127.0.0.1:8000/api/shots?playerId=201939&season=2016-17");
  });

  it("passes an abort signal, so a hung upstream cannot hold a worker slot", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", async (_url: URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return jsonResponse(validShots);
    });

    await createShotiqClient(BASE, 5000).getShots(201939, "2016-17");

    // Without a timeout the request can hang forever, and with concurrency
    // of 2 it takes half the worker's capacity with it.
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});
