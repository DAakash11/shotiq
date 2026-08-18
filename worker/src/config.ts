/**
 * Configuration, read from the environment once and validated at boot.
 *
 * The pattern matters more than the values. `process.env.PORT` is typed
 * `string | undefined` -- Node cannot know what is set, so TypeScript
 * refuses to pretend. Every field below therefore has to be parsed and
 * checked, and doing that here means a misconfigured container dies
 * immediately with a message naming the variable, rather than serving
 * traffic until some request path happens to touch the bad value.
 *
 * Fail fast at the edge; the rest of the program then gets a fully typed
 * object with no undefined in it.
 */

export interface Config {
  /** Port the job API listens on. */
  readonly port: number;
  /** Interface to bind. 0.0.0.0 inside a container, see below. */
  readonly host: string;
  /** Base URL of the existing ShotIQ FastAPI. */
  readonly shotiqApiUrl: string;
  /** Redis connection string, e.g. redis://127.0.0.1:6379. */
  readonly redisUrl: string;
  /** How long to wait on the upstream before giving up, in ms. */
  readonly upstreamTimeoutMs: number;
  readonly logLevel: string;
}

/**
 * Parses an integer environment variable.
 *
 * Note the return type is plain `number` while the input is
 * `string | undefined`. Everything uncertain is resolved inside this
 * function -- that is what a boundary function is for.
 *
 * `Number.parseInt` is not enough on its own: parseInt("3001abc") returns
 * 3001 and parseInt("") returns NaN, and NaN is a number as far as
 * TypeScript is concerned. This is the clearest small example of the gap
 * between the two systems -- the type says number, the value is NaN, and
 * only a runtime check closes it.
 */
function intFromEnv(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(
      `${name} must be an integer, received ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = intFromEnv("WORKER_PORT", env["WORKER_PORT"], 3001);
  if (port < 1 || port > 65535) {
    throw new Error(`WORKER_PORT must be between 1 and 65535, received ${port}`);
  }

  return {
    port,

    // 0.0.0.0, not 127.0.0.1. A process inside a container that binds to
    // loopback is reachable only from inside that container, so the port
    // mapping appears to do nothing and the failure looks like a Docker
    // problem rather than a bind address.
    host: env["WORKER_HOST"] ?? "0.0.0.0",

    // 127.0.0.1 rather than localhost, for the reason already recorded on
    // the Vite side of this project: Node resolves "localhost" to the IPv6
    // ::1 first, while uvicorn binds IPv4, so the connection is refused by
    // a server that is plainly running. Compose overrides this with
    // http://api:8000, where the service name resolves correctly either way.
    shotiqApiUrl: env["SHOTIQ_API_URL"] ?? "http://127.0.0.1:8000",

    // 127.0.0.1 for the same IPv6 reason as above. Compose overrides it with
    // redis://redis:6379.
    redisUrl: env["REDIS_URL"] ?? "redis://127.0.0.1:6379",

    // 90 seconds, matching what the Python API allows itself to reach
    // stats.nba.com. A shorter timeout here would abandon requests the
    // upstream was still legitimately working on and turn slow into failed
    // -- and this service exists precisely because that call is slow.
    upstreamTimeoutMs: intFromEnv(
      "UPSTREAM_TIMEOUT_MS",
      env["UPSTREAM_TIMEOUT_MS"],
      90_000,
    ),

    logLevel: env["LOG_LEVEL"] ?? "info",
  };
}
