import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

/**
 * loadConfig takes the environment as an argument with process.env as the
 * default. That one choice is what makes it testable: a function reading
 * process.env directly could only be tested by mutating global state and
 * hoping to restore it, which leaks between tests in a parallel runner.
 */
describe("loadConfig", () => {
  it("falls back to defaults when nothing is set", () => {
    const config = loadConfig({});

    expect(config.port).toBe(3001);
    // 0.0.0.0, not 127.0.0.1: a container process bound to loopback is
    // unreachable through a published port.
    expect(config.host).toBe("0.0.0.0");
    expect(config.shotiqApiUrl).toBe("http://127.0.0.1:8000");
    // Matches the 90s the Python API allows itself to reach stats.nba.com.
    expect(config.upstreamTimeoutMs).toBe(90_000);
  });

  it("reads values from the environment", () => {
    const config = loadConfig({
      WORKER_PORT: "4000",
      SHOTIQ_API_URL: "http://api:8000",
      UPSTREAM_TIMEOUT_MS: "5000",
    });

    expect(config.port).toBe(4000);
    expect(config.shotiqApiUrl).toBe("http://api:8000");
    expect(config.upstreamTimeoutMs).toBe(5000);
  });

  it("dies at boot on a non-numeric port instead of serving traffic", () => {
    // The failure mode being prevented: parseInt("abc") is NaN, NaN is a
    // number to TypeScript, and the process would happily start and then
    // behave strangely somewhere unrelated.
    expect(() => loadConfig({ WORKER_PORT: "abc" })).toThrow(/WORKER_PORT/);
  });

  it("rejects a port that parses but is not one", () => {
    // parseInt("3001abc") returns 3001 and hides the typo. Number() returns
    // NaN, which is why config.ts uses it.
    expect(() => loadConfig({ WORKER_PORT: "3001abc" })).toThrow(/WORKER_PORT/);
    expect(() => loadConfig({ WORKER_PORT: "3.5" })).toThrow(/WORKER_PORT/);
    expect(() => loadConfig({ WORKER_PORT: "70000" })).toThrow(/between/);
  });

  it("treats an empty variable as unset", () => {
    // Compose writes an empty string for a variable that is declared but has
    // no value, so this case is routine rather than exotic.
    expect(loadConfig({ WORKER_PORT: "" }).port).toBe(3001);
  });
});
