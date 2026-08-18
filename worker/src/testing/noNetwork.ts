import { afterEach, expect } from "vitest";

/**
 * Makes the test suite unable to reach the network, enforced rather than
 * trusted.
 *
 * The Python side already does this -- its fixtures make the NBA fetchers
 * raise instead of hoping nobody calls them -- and the reasoning carries
 * over exactly. A suite that merely HAPPENS not to hit the network today
 * starts hitting it the first time somebody adds a test without a stub, and
 * the symptom is a suite that is slow, flaky, occasionally rate-limited, and
 * green throughout.
 *
 * There is a second, sharper reason here. `createShotiqClient` catches every
 * fetch rejection and wraps it in an UpstreamError with status null, which it
 * classifies as retryable. So if a test reached the real network and the
 * guard threw, the client would swallow it and hand back a perfectly
 * ordinary "upstream unreachable" error -- and a test asserting
 * `rejects.toThrow(UpstreamError)` would PASS while having gone out to the
 * internet. That is the trap already recorded on the Python side: a caller
 * that catches broadly swallows the guard too.
 *
 * Throwing therefore is not enough on its own. Every attempt is RECORDED,
 * and an afterEach fails the test if anything was recorded, whether or not
 * the throw was caught along the way. The record is what makes the guard
 * un-swallowable.
 */

interface NetworkAttempt {
  readonly url: string;
  readonly at: string;
}

let attempts: NetworkAttempt[] = [];

/**
 * Returns the recorded attempts AND clears them.
 *
 * Only the guard's own test should call this. Anything else calling it is
 * hiding a real network attempt from the check below, which is the one thing
 * this module exists to prevent.
 */
export function consumeNetworkAttempts(): NetworkAttempt[] {
  const recorded = attempts;
  attempts = [];
  return recorded;
}

function describeTarget(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (input instanceof Request) return input.url;
  return String(input);
}

globalThis.fetch = ((input: unknown): Promise<never> => {
  const url = describeTarget(input);
  attempts.push({ url, at: new Date().toISOString() });

  // A REJECTED PROMISE, not a synchronous throw, because that is what real
  // fetch does: a network failure rejects the promise it already returned.
  //
  // The first version threw synchronously and was wrong in a way worth
  // keeping. Callers written against real fetch put the call inside
  // `try { await fetch(...) }`, which catches both -- so production code
  // behaved identically and nothing looked broken. Only the guard's own
  // tests failed, because `expect(fetch(url)).rejects` needs a promise to
  // reject and got an exception thrown before expect() was ever called.
  //
  // A fake that does not fail the way the real thing fails will eventually
  // let something through, or block something it should not.
  return Promise.reject(
    new Error(
      `network access is not allowed in tests (attempted ${url}). ` +
        `Stub fetch with vi.stubGlobal("fetch", ...) instead.`,
    ),
  );
}) as unknown as typeof fetch;

afterEach(() => {
  const recorded = consumeNetworkAttempts();

  // The assertion, rather than a throw, so the failure is reported against
  // the test that caused it with the URL in the message.
  expect(
    recorded.map((attempt) => attempt.url),
    "a test attempted real network access",
  ).toEqual([]);
});
