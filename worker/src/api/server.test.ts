import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "./server.js";
import { createInMemoryJobStore } from "./jobStore.js";
import type { JobStore } from "./jobStore.js";
import { loadConfig } from "../config.js";
import { isSeasonId } from "../queue/jobId.js";
import { seasonRegexSource } from "./schemas.js";

/**
 * Every test gets its own server and its own store.
 *
 * A shared instance would let a job created by one test be found by another,
 * so the suite would pass in the order it was written and fail when a runner
 * shuffled it. Vitest runs files in parallel by default, which turns that
 * kind of leakage from a theoretical problem into a real one.
 */
let server: FastifyInstance;
let store: JobStore;

beforeEach(() => {
  store = createInMemoryJobStore();
  server = buildServer({
    // "silent" so a suite of deliberate 400s does not bury the results in
    // expected error logs.
    config: { ...loadConfig({}), logLevel: "silent" },
    store,
  });
});

afterEach(async () => {
  await server.close();
});

describe("GET /health", () => {
  it("reports the service and the upstream it is configured against", async () => {
    const response = await server.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      service: "shotiq-worker",
      // The default from config.ts. 127.0.0.1, not localhost -- Node resolves
      // localhost to ::1 first while uvicorn binds IPv4.
      upstream: "http://127.0.0.1:8000",
    });
  });
});

describe("POST /api/jobs", () => {
  it("accepts a valid request with 202, not 200", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { playerId: 201939, season: "2016-17" },
    });

    // 202 Accepted: the work is queued, not done. A 200 here would be a lie
    // about the state of the cache.
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      jobId: "warm:201939:2016-17",
      state: "queued",
      deduplicated: false,
      result: null,
    });
  });

  it("collapses a repeated request into the same job", async () => {
    const payload = { playerId: 201939, season: "2016-17" };

    const first = await server.inject({ method: "POST", url: "/api/jobs", payload });
    const second = await server.inject({ method: "POST", url: "/api/jobs", payload });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ deduplicated: true });

    // Same id, and only one job exists. This is idempotency measured rather
    // than asserted: the second call did not create work.
    expect(second.json().jobId).toBe(first.json().jobId);
    expect(store.size()).toBe(1);
  });

  it("treats a different season as a different job", async () => {
    await server.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { playerId: 201939, season: "2016-17" },
    });
    await server.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { playerId: 201939, season: "2015-16" },
    });

    expect(store.size()).toBe(2);
  });
});

describe("POST /api/jobs rejects what the type system cannot", () => {
  /**
   * The heart of the step. Every payload below type-checks nowhere and is
   * still a perfectly valid HTTP request that a client can send. The TypeScript
   * annotation on the handler stops none of them -- it was erased before the
   * process started. Only the JSON Schema is present at request time.
   */

  it("rejects a player id sent as a string", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { playerId: "201939", season: "2016-17" },
    });

    expect(response.statusCode).toBe(400);
    expect(store.size()).toBe(0);
  });

  it("rejects a non-integer player id", async () => {
    // JSON has a single numeric type, so 201939.5 is valid JSON and would
    // pass a schema that said "number" instead of "integer".
    const response = await server.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { playerId: 201939.5, season: "2016-17" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("rejects a malformed season", async () => {
    for (const season of ["2016", "2016-2017", "16-17", "2016/17", ""]) {
      const response = await server.inject({
        method: "POST",
        url: "/api/jobs",
        payload: { playerId: 201939, season },
      });
      expect(response.statusCode, `season ${JSON.stringify(season)}`).toBe(400);
    }
  });

  it("rejects a missing required field", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { playerId: 201939 },
    });

    expect(response.statusCode).toBe(400);
  });

  it("rejects an unknown property rather than ignoring it", async () => {
    // Without additionalProperties: false this returns 202, and the typo
    // means the summary silently never runs. A success response for a
    // request that was not honoured is the expensive kind of bug.
    const response = await server.inject({
      method: "POST",
      url: "/api/jobs",
      payload: {
        playerId: 201939,
        season: "2016-17",
        includeSumary: true,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(store.size()).toBe(0);
  });

  it("accepts the correctly spelled optional field", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { playerId: 201939, season: "2016-17", includeSummary: true },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().data).toMatchObject({ includeSummary: true });
  });
});

describe("GET /api/jobs/:id", () => {
  it("returns a job that exists", async () => {
    await server.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { playerId: 203999, season: "2021-22" },
    });

    const response = await server.inject({
      method: "GET",
      url: "/api/jobs/warm:203999:2021-22",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      jobId: "warm:203999:2021-22",
      state: "queued",
    });
  });

  it("404s for a job that does not exist, rather than an empty 200", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/jobs/warm:1:2016-17",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "not_found" });
  });
});

describe("the response schemas do not silently drop fields", () => {
  /**
   * Guarding the trap that response schemas introduce. Once a route has one,
   * Fastify serialises through fast-json-stringify, which emits ONLY the
   * properties the schema names and drops the rest without a word. A field
   * added to a handler and forgotten in schemas.ts disappears from the
   * response, and neither the compiler nor a toMatchObject assertion notices
   * -- the first because types are long gone by then, the second because it
   * checks for presence and never for absence.
   *
   * Asserting the exact key set is what catches it.
   */
  it("returns every field of a submitted job", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { playerId: 201939, season: "2016-17" },
    });

    expect(Object.keys(response.json()).sort()).toEqual([
      "acceptedAt",
      "data",
      "deduplicated",
      "jobId",
      "result",
      "state",
    ]);
  });

  it("keeps result: null rather than omitting the key", async () => {
    // A dropped null reads as "no such field" to a client, which is a
    // different claim from "no result yet".
    await server.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { playerId: 201939, season: "2016-17" },
    });
    const response = await server.inject({
      method: "GET",
      url: "/api/jobs/warm:201939:2016-17",
    });

    expect(Object.keys(response.json())).toContain("result");
    expect(response.json().result).toBeNull();
  });
});

describe("the OpenAPI document", () => {
  it("describes every route, so /docs cannot drift from the server", async () => {
    // `await server.ready()` is required and the reason is worth keeping.
    //
    // fastify.register() defers: the plugin is queued, not run, so
    // server.swagger() does not exist until boot completes. TypeScript is
    // perfectly happy with the call either way, because @fastify/swagger
    // augments FastifyInstance with the method and types describe SHAPE, not
    // TIMING -- there is no way to say "this property appears at boot". The
    // first version of this test type-checked cleanly and threw
    // "server.swagger is not a function" at runtime.
    //
    // The other tests never hit it because inject() awaits ready() itself.
    await server.ready();

    // Generated from the same schemas the validator uses, so this is really
    // asserting that they are wired up rather than that a document exists.
    const spec = server.swagger();

    expect(Object.keys(spec.paths ?? {}).sort()).toEqual([
      "/api/jobs",
      "/api/jobs/{id}",
      "/health",
    ]);
  });
});

describe("the schema and the type guard agree", () => {
  /**
   * The season rule is written twice -- once as a regex for the guard in
   * queue/jobId.ts, once as a JSON Schema pattern for the validator. Two
   * copies of one rule drift, and the compiler cannot help because both are
   * strings as far as it is concerned. This test is what holds them together;
   * a schema-derived-types library such as TypeBox or Zod is the other way
   * to solve it.
   */
  it("accepts and rejects exactly the same seasons", () => {
    const schemaRegex = new RegExp(seasonRegexSource);

    for (const season of ["2016-17", "1999-00", "2025-26"]) {
      expect(schemaRegex.test(season), season).toBe(true);
      expect(isSeasonId(season), season).toBe(true);
    }

    for (const season of ["2016", "2016-2017", "16-17", "2016/17", ""]) {
      expect(schemaRegex.test(season), season).toBe(false);
      expect(isSeasonId(season), season).toBe(false);
    }
  });
});
