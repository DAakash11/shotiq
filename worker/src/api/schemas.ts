/**
 * Runtime validation for everything arriving over HTTP.
 *
 * This is the file that answers the question the whole project has been
 * circling: if types are erased before the program runs, what actually stops
 * a bad request?
 *
 * Nothing, unless something like this exists. A handler declared as
 * `(request: { Body: WarmJobData })` is a statement about what the code
 * EXPECTS, and the compiler enforces it everywhere inside the program. It
 * enforces nothing at the edge, because the edge is where data crosses in
 * from outside and the annotation was deleted before the process started.
 * `curl -d '{"playerId":"banana"}'` satisfies every type in this repository.
 *
 * Fastify compiles these JSON Schemas into validators that run per request,
 * before the handler is entered. A body that fails is rejected with a 400
 * and the handler never sees it -- so by the time the typed code runs, the
 * type is true.
 *
 * The two systems are complementary, not redundant:
 *
 *   TypeScript  -- compile time -- protects you from YOUR OWN mistakes
 *   JSON Schema -- runtime      -- protects you from EVERYONE ELSE'S input
 *
 * "Parse, don't validate" is the slogan for it, and it is worth being able
 * to say in an interview: untrusted input is turned into a trusted type at
 * exactly one place, and everything downstream is spared the question.
 */

/**
 * The same regex isSeasonId uses, expressed for the validator.
 *
 * Duplicated on purpose and pinned by a test. The alternative would be to
 * build the schema from the TypeScript type with a library such as TypeBox
 * or Zod, which removes the duplication entirely -- worth knowing about, and
 * the right answer on a bigger surface. At three fields it would be more
 * machinery than the problem deserves, and the risk it removes is covered
 * here by a test asserting the two agree.
 */
const SEASON_REGEX_SOURCE = "^\\d{4}-\\d{2}$";

export const warmJobBodySchema = {
  type: "object",
  required: ["playerId", "season"],

  // Necessary but NOT sufficient on its own, which was measured rather than
  // assumed and is the more useful half of the lesson.
  //
  // Alone, under Fastify's defaults, this line does not reject an unknown
  // property -- AJV's removeAdditional deletes it and returns 200. A typo
  // like {"playerId":201939,"season":"2016-17","includeSumary":true} came
  // back as a success with the field stripped, so the summary silently never
  // ran and nothing anywhere said so. That is the expensive kind of failure:
  // a success response for a request that was not honoured.
  //
  // It only rejects because server.ts also turns removeAdditional off. Two
  // settings in different files have to agree for this to mean what it
  // looks like it means, so a test pins the behaviour end to end.
  additionalProperties: false,

  properties: {
    // "integer", not "number". JSON has one numeric type, so 201939.5 is a
    // perfectly good JSON number and would sail through a "number" schema
    // into a player id.
    playerId: { type: "integer", minimum: 1 },
    season: { type: "string", pattern: SEASON_REGEX_SOURCE },
    includeSummary: { type: "boolean" },
  },
} as const;

export const jobIdParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1 },
  },
} as const;

/** Exported so a test can assert it matches the guard in queue/jobId.ts. */
export const seasonRegexSource = SEASON_REGEX_SOURCE;

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

/**
 * These do two jobs at once, and the second one has teeth.
 *
 * The obvious job is documentation: @fastify/swagger reads them to generate
 * the OpenAPI spec behind /docs, so the browser page shows the real response
 * shapes instead of an empty example.
 *
 * The job that bites is SERIALISATION. Once a route has a response schema,
 * Fastify stops using JSON.stringify and compiles a serialiser from it via
 * fast-json-stringify -- which emits only the properties the schema names
 * and silently drops the rest. Adding a field to a handler and forgetting it
 * here means the field vanishes from the response with no error anywhere,
 * and the handler's own types are no help because the deletion happens after
 * they are gone. It is the mirror image of removeAdditional on the request
 * side: same silence, opposite direction.
 *
 * That is a fair trade for the speed and the documentation, but only if the
 * responses are covered by tests. Ours assert on `deduplicated` and on
 * `result: null` specifically because both would disappear unnoticed if this
 * file fell behind.
 */

const warmJobDataSchema = {
  type: "object",
  properties: {
    playerId: { type: "integer" },
    season: { type: "string" },
    includeSummary: { type: "boolean" },
  },
} as const;

const jobRecordProperties = {
  jobId: { type: "string", examples: ["warm:201939:2016-17"] },
  state: {
    type: "string",
    enum: ["queued", "active", "completed", "failed"],
  },
  data: warmJobDataSchema,
  acceptedAt: { type: "string", format: "date-time" },
  // The outcome, once there is one. Left open rather than spelling out the
  // three WarmResult members, because step 6 is where that union settles and
  // a schema pinned to a half-built shape would quietly truncate the parts
  // it did not yet know about.
  result: { type: "object", nullable: true, additionalProperties: true },
} as const;

export const jobRecordResponseSchema = {
  type: "object",
  properties: jobRecordProperties,
} as const;

/** What POST /jobs returns: a job record plus whether it was a repeat. */
export const submitJobResponseSchema = {
  type: "object",
  properties: {
    ...jobRecordProperties,
    deduplicated: { type: "boolean" },
  },
} as const;

export const errorResponseSchema = {
  type: "object",
  properties: {
    error: { type: "string" },
    message: { type: "string" },
  },
} as const;

export const healthResponseSchema = {
  type: "object",
  properties: {
    status: { type: "string" },
    service: { type: "string" },
    upstream: { type: "string" },
  },
} as const;
