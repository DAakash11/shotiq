import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

import type { Config } from "../config.js";
import type { JobStore } from "./jobStore.js";
import { createInMemoryJobStore } from "./jobStore.js";
import { jobRoutes } from "./routes/jobs.js";

export interface BuildServerOptions {
  readonly config: Config;
  /** Injected so tests can supply their own. Defaults to a fresh one. */
  readonly store?: JobStore;
}

/**
 * Builds the server WITHOUT starting it.
 *
 * The separation is what makes the HTTP layer testable. Because this returns
 * a configured instance rather than binding a port, the test suite can drive
 * it through fastify.inject() -- a real request through the real router,
 * schemas, and handlers, with no socket, no port to collide with, and
 * nothing to clean up if an assertion throws halfway through.
 *
 * Starting the listener lives in index.ts instead, which is the only file
 * with a side effect.
 */
export function buildServer(options: BuildServerOptions): FastifyInstance {
  const { config, store = createInMemoryJobStore() } = options;

  const fastify = Fastify({
    logger: { level: config.logLevel },

    // Fastify's validator defaults are lenient, and all three overrides below
    // were established by running the server and watching what it did, not by
    // reading the documentation. Two of them contradicted what the schemas
    // appeared to promise:
    //
    //   coerceTypes defaults to true, so a body of {"playerId": "201939"}
    //   -- a STRING -- is quietly converted to the number 201939 and
    //   accepted. Convenient for querystrings, where everything is a string
    //   by definition. Wrong for a JSON body, where the client had a real
    //   number type available and chose not to use it. Off means a caller
    //   sending the wrong type is told so.
    //
    //   removeAdditional defaults to true, which changes what
    //   additionalProperties: false MEANS: instead of rejecting an unknown
    //   key, AJV deletes it and lets the request through. {"includeSumary":
    //   true} came back 200 with the field silently gone. Off makes the typo
    //   a 400 the caller can see and fix.
    //
    //   allErrors defaults to false, so only the first problem is reported
    //   and a caller with two bad fields needs two round trips to learn it.
    ajv: {
      customOptions: {
        allErrors: true,
        coerceTypes: false,
        removeAdditional: false,
      },
    },
  });

  fastify.get("/health", async () => ({
    status: "ok",
    service: "shotiq-worker",
    upstream: config.shotiqApiUrl,
  }));

  // Registered under a prefix so every job route is namespaced without each
  // one repeating it.
  void fastify.register(jobRoutes, { prefix: "/api", store });

  return fastify;
}
