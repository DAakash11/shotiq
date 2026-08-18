import type { FastifyInstance, FastifyPluginOptions } from "fastify";

import type { JobStore } from "../jobStore.js";
import type { WarmJobData } from "../../types/models.js";
import { jobIdParamsSchema, warmJobBodySchema } from "../schemas.js";

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
    { schema: { body: warmJobBodySchema } },
    async (request, reply) => {
      const outcome = store.submit(request.body);

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
    { schema: { params: jobIdParamsSchema } },
    async (request, reply) => {
      const job = store.get(request.params.id);

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
