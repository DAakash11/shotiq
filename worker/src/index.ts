/**
 * The API entrypoint. The only file here that does anything on import.
 *
 * Step 5 adds a second entrypoint for the worker process. Both are built
 * from the same image and differ only in the command Compose gives them,
 * which is why the interesting code lives in modules that export functions
 * and these two files stay this thin.
 */

import { buildServer } from "./api/server.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const server = buildServer({ config });

/**
 * Graceful shutdown.
 *
 * Docker sends SIGTERM and then waits ten seconds before SIGKILL. Without a
 * handler, Node's default for SIGTERM is to die instantly, cutting every
 * in-flight request mid-response -- a caller sees a dropped connection on
 * every deploy. fastify.close() stops accepting new connections and lets
 * the ones in progress finish first.
 *
 * This matters far more in step 5, where the same signal must let a running
 * job finish rather than abandoning it half-done.
 */
async function shutdown(signal: string): Promise<void> {
  server.log.info({ signal }, "shutting down");
  try {
    await server.close();
    process.exit(0);
  } catch (error) {
    server.log.error({ error }, "failed to shut down cleanly");
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
  await server.listen({ port: config.port, host: config.host });
} catch (error) {
  // The logger is used rather than console.error so a startup failure lands
  // in the same stream as everything else -- a container that dies at boot
  // must say why in the place the operator is already looking.
  server.log.error({ error }, "failed to start");
  process.exit(1);
}
