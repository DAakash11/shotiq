import { Redis } from "ioredis";

/**
 * The Redis connection.
 *
 * One setting here is not optional and not a preference: BullMQ REQUIRES
 * `maxRetriesPerRequest: null` on any connection a Worker will use, and
 * throws on startup if it is missing. The reason is worth understanding
 * rather than copying.
 *
 * ioredis defaults to giving up on a command after 20 retries and rejecting
 * it. That is sensible for ordinary commands. But a BullMQ worker spends
 * almost all of its life inside a BLOCKING command -- BRPOPLPUSH, waiting
 * for the next job -- which by design does not return until there is work.
 * Under the default, a blocking wait that outlives the retry budget gets
 * killed and the worker stops consuming while looking perfectly healthy.
 * `null` means "retry forever", which is the correct behaviour for a
 * long-lived consumer whose whole job is to wait.
 */
export function createRedisConnection(url: string): Redis {
  const connection = new Redis(url, {
    maxRetriesPerRequest: null,

    // Do not connect on construction. Connecting lazily means building the
    // object cannot throw or hang, so a test that never touches Redis is not
    // punished for importing this module, and startup ordering stops
    // mattering.
    lazyConnect: true,
  });

  // ioredis is an EventEmitter, and an 'error' event with no listener is
  // rethrown as an uncaught exception that kills the process. A Redis blip
  // must not take the API down with it, so the event is always handled --
  // logging only, because ioredis reconnects on its own.
  connection.on("error", (error: Error) => {
    // eslint-disable-next-line no-console -- the Fastify logger is not
    // available here, and a connection error must not be swallowed.
    console.error("[redis]", error.message);
  });

  return connection;
}
