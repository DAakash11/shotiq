import type { FastifyInstance, FastifyPluginOptions } from "fastify";

import type { JobStore } from "../jobStore.js";
import type { WarmJobData } from "../../types/models.js";
import {
  errorResponseSchema,
  jobIdParamsSchema,
  jobRecordResponseSchema,
  submitJobResponseSchema,
  warmJobBodySchema,
} from "../schemas.js";

export interface JobRoutesOptions extends FastifyPluginOptions {
  readonly store: JobStore;
}

/**
 * The job routes, as a Fastify plugin.
 *
 * A plugin is just an async function that receives the server and registers
 * things on it. Taking the store as an option rather than importing a shared
 * one is plain dependency injection: step 4 swaps the in-memory store for a
 * BullMQ-backed one by passing a different object, and nothing in this file
 * changes.
 */
export async function jobRoutes(
  fastify: FastifyInstance,
  options: JobRoutesOptions,
): Promise<void> {
  const { store } = options;

  /**
   * The angle brackets are a GENERIC ARGUMENT, and this is the shape of
   * generics you will meet most often in TypeScript: not writing them, but
   * supplying them to somebody else's type.
   *
   * Fastify's route method is declared roughly as
   * `post<T extends RouteGenericInterface>(...)`, where T carries the types
   * of the body, params, querystring and reply. Passing `{ Body: WarmJobData }`
   * fills that slot in, and from there `request.body` is WarmJobData rather
   * than `unknown` -- autocomplete on `.playerId`, and a compile error on
   * `.playerID`.
   *
   * The important caveat, and a fair interview question: this generic is a
   * CLAIM, not a check. It does not inspect the schema. If the two disagree,
   * TypeScript believes the generic and the request obeys the schema. That
   * is why the schema is the thing standing between the outside world and
   * this handler, and why a test below pins them together.
   */
  fastify.post<{ Body: WarmJobData }>(
    "/jobs",
    {
      schema: {
        // `tags` and `summary` are ignored by the validator and read by
        // @fastify/swagger, which is how /docs gets its grouping and titles
        // without a separate document to keep in step.
        tags: ["Jobs"],
        summary: "Request that a player-season be warmed",
        description:
          "Returns 202 when the job is newly queued and 200 when an " +
          "identical job already exists. A repeat is a success, not a " +
          "conflict: the job id is derived from the player and season, so " +
          "asking twice is harmless by construction.",
        body: warmJobBodySchema,
        response: {
          202: submitJobResponseSchema,
          200: submitJobResponseSchema,
          400: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // The `await` is not optional decoration. Without it `outcome` would be
      // a Promise, `outcome.kind` would be undefined, and the function would
      // fall through to the duplicate branch for every request -- a bug that
      // TypeScript does catch here, because Promise<SubmitOutcome> has no
      // `kind` property. Forgetting an await is the single commonest async
      // mistake, and it is only sometimes this visible: on a value you merely
      // pass along, the promise flows onward and surfaces far from its cause.
      const outcome = await store.submit(request.body);

      // 202 Accepted, not 200 OK, and the distinction is the entire point of
      // an async service: the work has been accepted for later processing
      // and has NOT been done. Returning 200 would tell the caller the
      // player-season is warm when nothing has run yet.
      if (outcome.kind === "accepted") {
        return reply.code(202).send({ ...outcome.job, deduplicated: false });
      }

      // A duplicate is a success, not an error, and specifically not a 409.
      // The caller asked for a player-season to be warm; that request is
      // already in hand and they get the same job id back. Idempotency means
      // the second call is harmless, not that it is rejected -- a client
      // retrying after a dropped connection must not be punished for it.
      return reply.code(200).send({ ...outcome.job, deduplicated: true });
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/jobs/:id",
    {
      schema: {
        tags: ["Jobs"],
        summary: "Look up a submitted job",
        params: jobIdParamsSchema,
        response: {
          200: jobRecordResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const job = await store.get(request.params.id);

      // `undefined` has to be handled because Map.get returns `T | undefined`
      // and strictNullChecks will not let it past. Without that flag this
      // would compile, return undefined, and serialise as an empty 200.
      if (job === undefined) {
        return reply.code(404).send({
          error: "not_found",
          message: `No job with id ${request.params.id}`,
        });
      }

      return reply.code(200).send(job);
    },
  );
}
