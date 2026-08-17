import { describe, expect, it } from "vitest";

// The .js extension is not a typo and the file it names does not exist.
//
// Node's ESM loader does not guess extensions the way CommonJS `require`
// did, so the emitted JavaScript must import "./jobId.js". tsc does not
// rewrite import paths, so the source has to say what the output needs to
// say. Writing "./jobId" here type-checks under some settings and then
// fails at runtime inside the container -- the exact class of bug that
// only shows up after it is deployed.
import { isSeasonId, JOB_ID_PREFIX, warmJobId } from "./jobId.js";

describe("warmJobId", () => {
  it("builds a stable id from the player and season", () => {
    expect(warmJobId(201939, "2016-17")).toBe("warm:201939:2016-17");
  });

  it("is deterministic -- the same inputs give the same id every time", () => {
    // This is the property the whole idempotency story rests on, so it is
    // asserted directly rather than left implied by the test above.
    expect(warmJobId(1628983, "2025-26")).toBe(warmJobId(1628983, "2025-26"));
  });

  it("gives different players different ids in the same season", () => {
    expect(warmJobId(201939, "2016-17")).not.toBe(warmJobId(2544, "2016-17"));
  });

  it("gives the same player different ids in different seasons", () => {
    expect(warmJobId(201939, "2016-17")).not.toBe(warmJobId(201939, "2015-16"));
  });

  it("namespaces every id", () => {
    expect(warmJobId(203999, "2021-22")).toMatch(
      new RegExp(`^${JOB_ID_PREFIX}:`),
    );
  });
});

describe("isSeasonId", () => {
  it("accepts the NBA's own notation", () => {
    expect(isSeasonId("2016-17")).toBe(true);
    expect(isSeasonId("1999-00")).toBe(true);
  });

  it("rejects the shapes that look plausible but are not", () => {
    expect(isSeasonId("2016")).toBe(false);
    expect(isSeasonId("2016-2017")).toBe(false);
    expect(isSeasonId("16-17")).toBe(false);
    expect(isSeasonId("2016/17")).toBe(false);
  });

  it("rejects non-strings, because the caller's data comes off the wire", () => {
    // The reason this function exists at all. A route handler can DECLARE a
    // season parameter as a string and still be handed a number, an array or
    // undefined at runtime -- the annotation was erased before the process
    // started. Only a check like this one is actually present when the
    // request arrives.
    expect(isSeasonId(2016)).toBe(false);
    expect(isSeasonId(null)).toBe(false);
    expect(isSeasonId(undefined)).toBe(false);
    expect(isSeasonId(["2016-17"])).toBe(false);
  });
});
