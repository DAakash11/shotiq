import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";

import type { Config } from "../config.js";
import type { JobStore } from "./jobStore.js";
import { createInMemoryJobStore } from "./jobStore.js";
import { healthResponseSchema } from "./schemas.js";
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

  /**
   * Interactive API docs at /docs, generated from the same JSON Schemas the
   * validator uses.
   *
   * Deliberately not a hand-written Postman collection or a page of curl
   * commands: either would be a second copy of the contract, and a second
   * copy drifts the first time a schema changes and the doc does not. This
   * way the page is wrong only if the server is wrong.
   *
   * It also matches what the Python service already does -- FastAPI serves
   * the equivalent at /docs from its Pydantic models -- so both halves of
   * the stack are explored the same way. The raw OpenAPI document is at
   * /docs/json and imports straight into Postman or Insomnia for anyone who
   * prefers those.
   */
  void fastify.register(fastifySwagger, {
    openapi: {
      info: {
        title: "ShotIQ warm worker",
        description:
          "Queues the slow parts of a player-season lookup -- the " +
          "up-to-90s fetch from stats.nba.com and the metered LLM summary " +
          "-- so the dashboard does not wait on them.",
        version: "0.1.0",
      },
      tags: [
        { name: "Jobs", description: "Submitting and tracking warm jobs" },
        { name: "Service", description: "Liveness" },
      ],
    },
  });

  void fastify.register(fastifySwaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      // Show every operation expanded. There are three; collapsing them
      // behind a click helps nobody.
      docExpansion: "full",
      deepLinking: true,
    },
  });

  /**
   * Wrapped in register() rather than declared directly on the instance, and
   * this is not style -- it is the difference between appearing in the docs
   * and not.
   *
   * fastify.register() DEFERS: the plugin is queued and runs at ready(). So
   * @fastify/swagger's onRoute hook, which is what notices routes, does not
   * exist until then. A route added synchronously to the root instance is
   * therefore registered BEFORE the hook is installed and is invisible to
   * the spec. Written the direct way, /health worked perfectly, served the
   * right JSON, and simply was not in the document -- which is exactly the
   * sort of gap nobody spots by looking at the page.
   *
   * Queuing it behind the plugin puts it in the same phase as the job
   * routes. Caught by the test that asserts the spec lists all three paths.
   */
  void fastify.register(async (instance) => {
    instance.get(
      "/health",
      {
        schema: {
          tags: ["Service"],
          summary: "Liveness check",
          response: { 200: healthResponseSchema },
        },
      },
      async () => ({
        status: "ok",
        service: "shotiq-worker",
        upstream: config.shotiqApiUrl,
      }),
    );
  });

  // Registered under a prefix so every job route is namespaced without each
  // one repeating it.
  void fastify.register(jobRoutes, { prefix: "/api", store });

  return fastify;
}
