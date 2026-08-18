import { describe, expect, it, vi } from "vitest";

import { consumeNetworkAttempts } from "./noNetwork.js";
import { createShotiqClient, UpstreamError } from "../fetchers/shotiqClient.js";

/**
 * Testing the guard itself.
 *
 * A guard nobody exercises is a guard nobody knows is broken -- and this one
 * is a global side effect installed by a setup file, which is exactly the
 * kind of thing that silently stops being wired up after a config change.
 *
 * Every test here calls consumeNetworkAttempts() to clear the record, since
 * otherwise the afterEach in noNetwork.ts would fail these tests for doing
 * deliberately what it exists to catch.
 */
describe("the network guard", () => {
  it("throws rather than reaching the network", async () => {
    await expect(fetch("http://example.com/nope")).rejects.toThrow(
      /network access is not allowed/,
    );
    consumeNetworkAttempts();
  });

  it("records the URL it blocked", async () => {
    await expect(fetch("http://stats.nba.com/whatever")).rejects.toThrow();

    const recorded = consumeNetworkAttempts();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.url).toBe("http://stats.nba.com/whatever");
  });

  it("records a URL object too, not only a string", async () => {
    await expect(fetch(new URL("http://127.0.0.1:8000/api/shots"))).rejects.toThrow();
    expect(consumeNetworkAttempts()[0]?.url).toBe("http://127.0.0.1:8000/api/shots");
  });

  it("SURVIVES a caller that catches broadly", async () => {
    /**
     * The reason recording exists at all, and the lesson this project
     * already learned once on the Python side.
     *
     * createShotiqClient catches every fetch rejection and wraps it in an
     * UpstreamError with a null status, which it treats as retryable. So a
     * test that reached the real network would see an ordinary
     * "upstream unreachable" error, and an assertion of
     * `rejects.toThrow(UpstreamError)` would PASS while having gone out to
     * the internet. Throwing alone does not protect anything from a caller
     * that catches.
     *
     * Below is that exact situation: the guard fires, the client swallows
     * it and produces its own error, and the attempt is STILL on the record.
     * The afterEach hook is what turns that record into a failed test.
     */
    const client = createShotiqClient("http://127.0.0.1:8000", 1000);

    await expect(client.getShots(201939, "2016-17")).rejects.toThrow(UpstreamError);

    const recorded = consumeNetworkAttempts();
    expect(recorded, "the attempt was recorded despite being swallowed").toHaveLength(1);
    expect(recorded[0]?.url).toContain("/api/shots");
  });

  it("still allows a test to stub fetch deliberately", async () => {
    // The guard blocks REAL network access; it must not stop a test
    // supplying its own fake, which is how every other test here works.
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));

    const response = await fetch("http://anything");
    expect(response.status).toBe(200);

    vi.unstubAllGlobals();
    expect(consumeNetworkAttempts()).toEqual([]);
  });

  it("is restored after unstubbing, so one test cannot disarm the rest", async () => {
    // vi.stubGlobal captures whatever was there -- the guard -- and
    // unstubAllGlobals puts it back. Worth pinning: if a stub leaked, every
    // later test in the file would be unprotected and nothing would say so.
    vi.stubGlobal("fetch", async () => new Response("{}"));
    vi.unstubAllGlobals();

    await expect(fetch("http://example.com")).rejects.toThrow(
      /network access is not allowed/,
    );
    consumeNetworkAttempts();
  });
});
