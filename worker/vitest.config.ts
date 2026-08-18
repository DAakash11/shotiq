import { defineConfig } from "vitest/config";

/**
 * The default suite: unit tests only, no Redis, no Docker, no network.
 *
 * Integration tests are excluded here and run from their own config, and the
 * split is deliberate rather than tidiness. A suite that silently SKIPS when
 * Redis is missing is the worst of both worlds -- it goes green on a machine
 * where nothing was actually verified, which is precisely the trap the
 * Python side already avoids by making its fetchers raise rather than
 * trusting them to stay offline.
 *
 * So: `npm test` never needs Redis and never pretends to have tested it.
 * `npm run test:integration` needs Redis and FAILS if it is absent. Neither
 * command can quietly do nothing.
 */
export default defineConfig({
  test: {
    // Installs the network guard for every unit test. See
    // src/testing/noNetwork.ts -- it throws AND records, because the HTTP
    // client catches broadly enough to swallow a throw on its own.
    setupFiles: ["src/testing/noNetwork.ts"],

    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.integration.test.ts",
    ],
  },
});
