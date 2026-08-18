import type {
  PlayerId,
  SeasonId,
  ShotsPayload,
  SplitsPayload,
} from "../types/models.js";

/**
 * An error from the upstream API, carrying what a retry policy needs to
 * decide with.
 *
 * A plain `throw new Error("request failed")` would force step 6 to make
 * that decision by matching on a message string, which breaks the moment
 * anyone rewords it. The status code is the fact; the message is prose.
 *
 * `extends Error` on a class is one of the few places TypeScript needs help:
 * the `Object.setPrototypeOf` line below exists because subclassing built-in
 * Error is only reliable when the prototype is restored explicitly. Without
 * it, `instanceof UpstreamError` can be false for an object that plainly is
 * one, depending on the compilation target -- a genuinely confusing bug.
 */
export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly url: string,
  ) {
    super(message);
    this.name = "UpstreamError";
    Object.setPrototypeOf(this, UpstreamError.prototype);
  }

  /**
   * Whether trying again could plausibly help.
   *
   * 5xx and a timeout are worth retrying: the request was well-formed and
   * the other side failed or was slow. 4xx is not -- asking again for a
   * player that does not exist will fail identically forever, and retrying
   * it just spends the budget three times before reporting the same thing.
   * `status === null` means the request never got an answer at all, which is
   * the timeout case.
   */
  get isRetryable(): boolean {
    return this.status === null || this.status >= 500;
  }
}

export interface ShotiqClient {
  getShots(playerId: PlayerId, season: SeasonId): Promise<ShotsPayload>;
  getSplits(playerId: PlayerId, season: SeasonId): Promise<SplitsPayload>;
}

/**
 * A deliberately shallow check on what came back.
 *
 * Being honest about what this is: it is NOT full validation. Running a JSON
 * Schema over 1,443 shot records on every job would cost more than it saves,
 * and this upstream is our own service in the same compose file rather than
 * a third party.
 *
 * But "our own service" is not the same as "trusted": it can be a version
 * behind, or return a 200 carrying an error body, and the whole payload is
 * about to be cast to a type the compiler will then believe completely. So
 * the two fields everything downstream depends on are checked, and the cast
 * is confined to this one function instead of being scattered.
 *
 * The general shape is worth knowing: `unknown` in, a check, a narrowed type
 * out. Casting straight from `await response.json()` to ShotsPayload -- which
 * is what `as` invites -- would make every field a promise nobody verified.
 */
function assertShotsPayload(value: unknown, url: string): ShotsPayload {
  const payload = value as ShotsPayload;
  if (
    typeof payload?.meta?.playerId !== "number" ||
    !Array.isArray(payload?.shots)
  ) {
    throw new UpstreamError("shots response was not the expected shape", 200, url);
  }
  return payload;
}

function assertSplitsPayload(value: unknown, url: string): SplitsPayload {
  const payload = value as SplitsPayload;
  // `overall` is intentionally NOT checked for non-null: null is the correct,
  // documented value for a season before 2013-14.
  if (
    typeof payload?.meta?.playerId !== "number" ||
    typeof payload?.splits !== "object"
  ) {
    throw new UpstreamError("splits response was not the expected shape", 200, url);
  }
  return payload;
}

export function createShotiqClient(
  baseUrl: string,
  timeoutMs: number,
): ShotiqClient {
  async function get(path: string, playerId: PlayerId, season: SeasonId): Promise<unknown> {
    // URL and URLSearchParams rather than string concatenation. Building a
    // query by hand is how an unencoded value ends up changing the meaning
    // of the request.
    const url = new URL(path, baseUrl);
    url.searchParams.set("playerId", String(playerId));
    url.searchParams.set("season", season);

    let response: Response;
    try {
      response = await fetch(url, {
        // Without this, a hung upstream hangs the WORKER, holding a
        // concurrency slot forever. AbortSignal.timeout is the built-in
        // way to bound it; the old pattern of setTimeout plus an
        // AbortController is no longer necessary on Node 18+.
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // fetch rejects only on a network-level failure or an abort. A
      // timeout arrives here, not below, and carries no status -- which is
      // exactly what isRetryable reads as "worth trying again".
      throw new UpstreamError(
        error instanceof Error ? error.message : "network failure",
        null,
        url.toString(),
      );
    }

    // The trap that makes fetch different from most HTTP clients: it
    // RESOLVES on 404 and 500. Only a network failure rejects. Code that
    // awaits fetch and goes straight to .json() treats an error page as
    // data, and this project has a test on the React side pinning the same
    // check for the same reason.
    if (!response.ok) {
      throw new UpstreamError(
        `upstream responded ${response.status}`,
        response.status,
        url.toString(),
      );
    }

    return await response.json();
  }

  return {
    async getShots(playerId, season) {
      const url = new URL("/api/shots", baseUrl).toString();
      return assertShotsPayload(await get("/api/shots", playerId, season), url);
    },

    async getSplits(playerId, season) {
      const url = new URL("/api/splits", baseUrl).toString();
      return assertSplitsPayload(await get("/api/splits", playerId, season), url);
    },
  };
}
