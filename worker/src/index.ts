/**
 * The API entrypoint. The only file here that does anything on import.
 *
 * Step 5 adds a second entrypoint for the worker process. Both are built
 * from the same image and differ only in the command Compose gives them,
 * which is why the interesting code lives in modules that export functions
 * and these two files stay this thin.
 */

import { buildServer } from "./api/server.js";
import { createBullJobStore } from "./queue/bullJobStore.js";
import { createRedisConnection } from "./queue/connection.js";
import { createWarmQueue } from "./queue/warmQueue.js";
import { loadConfig } from "./config.js";

const config = loadConfig();

// Composed here and nowhere else. Every module below took its dependency as
// an argument rather than importing a shared instance, so this is the single
// place that decides what the real ones are -- and the single place a test
// does not go through.
const connection = createRedisConnection(config.redisUrl);

// Connect BEFORE the queue is constructed, and the order is not cosmetic.
//
// createRedisConnection asks for lazyConnect, so nothing dials Redis on
// construction. But BullMQ's Queue constructor connects the client it is
// given, so by the time a Queue exists the connection is already in flight
// -- and ioredis throws "Redis is already connecting/connected" if connect()
// is then called again. The first version of this file did exactly that and
// died at boot every time, which is the right failure to have if you are
// going to have one at all.
//
// Connecting here keeps the intent that made it explicit in the first place:
// a service that cannot reach Redis must fail now, not accept requests it
// cannot serve. An orchestrator seeing a healthy container and routing
// traffic to a broken one is worse than a container that will not start.
await connection.connect();

const queue = createWarmQueue(connection);
const store = createBullJobStore(queue, connection);

const server = buildServer({ config, store });

/**
 * Graceful shutdown.
 *
 * Docker sends SIGTERM and then waits ten seconds before SIGKILL. Without a
 * handler, Node's default for SIGTERM is to die instantly, cutting every
 * in-flight request mid-response -- a caller sees a dropped connection on
 * every deploy. fastify.close() stops accepting new connections and lets
 * the ones in progress finish first.
 *
 * Order matters and is not arbitrary: the server closes BEFORE the queue and
 * the connection. Reversed, a request still being served would reach for a
 * closed Redis client and fail at the very end of a shutdown meant to be
 * graceful.
 *
 * This matters far more in step 5, where the same signal must let a running
 * job finish rather than abandoning it half-done.
 */
async function shutdown(signal: string): Promise<void> {
  server.log.info({ signal }, "shutting down");
  try {
    await server.close();
    await store.close();
    await connection.quit();
    process.exit(0);
  } catch (error) {
    server.log.error({ err: error }, "failed to shut down cleanly");
    process.exit(1);
  }
}

// SIGINT is Ctrl+C at a terminal; SIGTERM is what an orchestrator sends.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

try {
  server.log.info({ redis: config.redisUrl }, "connected to redis");
  await server.listen({ port: config.port, host: config.host });
} catch (error) {
  // The logger is used rather than console.error so a startup failure lands
  // in the same stream as everything else -- a container that dies at boot
  // must say why in the place the operator is already looking.
  server.log.error({ err: error }, "failed to start");
  process.exit(1);
}
