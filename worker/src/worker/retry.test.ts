import { describe, expect, it } from "vitest";
import { UnrecoverableError } from "bullmq";

import { toQueueError } from "./retry.js";
import { UpstreamError } from "../fetchers/shotiqClient.js";

describe("which failures are worth retrying", () => {
  it("passes a 503 through unchanged, so BullMQ retries it", () => {
    // The case the whole backoff policy exists for: Gemini 503s and
    // stats.nba.com rate limiting, both transient.
    const error = new UpstreamError("upstream responded 503", 503, "/api/shots");
    const translated = toQueueError(error);

    expect(translated).toBe(error);
    expect(translated).not.toBeInstanceOf(UnrecoverableError);
  });

  it("passes a timeout through, since a hung upstream may well recover", () => {
    const translated = toQueueError(new UpstreamError("timed out", null, "/api/shots"));
    expect(translated).not.toBeInstanceOf(UnrecoverableError);
  });

  it("converts a 404 into an UnrecoverableError so no attempts are wasted", () => {
    // Asking again for a player that does not exist fails identically every
    // time. Three attempts with backoff would spend six seconds and two
    // extra requests to reach the answer the first response already gave --
    // while holding a worker slot that real work is queued behind.
    const translated = toQueueError(
      new UpstreamError("upstream responded 404", 404, "/api/shots"),
    );

    expect(translated).toBeInstanceOf(UnrecoverableError);
    expect(translated.message).toContain("not retryable");
  });

  it("converts a malformed 200 into an UnrecoverableError", () => {
    // A response of the wrong shape will be the wrong shape next time too.
    const translated = toQueueError(
      new UpstreamError("shots response was not the expected shape", 200, "/api/shots"),
    );
    expect(translated).toBeInstanceOf(UnrecoverableError);
  });

  it("keeps the original error as the cause", () => {
    // Losing the original stack would leave BullMQ's failedReason as the
    // only record of what actually went wrong.
    const original = new UpstreamError("upstream responded 400", 400, "/api/shots");
    expect(toQueueError(original).cause).toBe(original);
  });
});

describe("things that are not UpstreamErrors", () => {
  it("passes an ordinary Error through", () => {
    const error = new Error("something else broke");
    expect(toQueueError(error)).toBe(error);
  });

  it("wraps a thrown non-error so the failure still reads", () => {
    // JavaScript can throw anything -- a string, a number, undefined. Typing
    // the parameter as Error would be a claim the language does not support,
    // and BullMQ's failedReason would end up as "[object Object]" at exactly
    // the moment someone needs to read it.
    const translated = toQueueError({ weird: true });

    expect(translated).toBeInstanceOf(Error);
    expect(translated.message).toContain("non-error thrown");
  });

  it("wraps a thrown string", () => {
    expect(toQueueError("just a string").message).toContain("just a string");
  });
});
