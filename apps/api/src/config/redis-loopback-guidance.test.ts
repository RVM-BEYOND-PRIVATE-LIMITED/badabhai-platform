/**
 * The loopback-address guidance is load-bearing, so it is pinned by test.
 *
 * ===========================================================================
 * WHY A TEST GUARDS A COMMENT
 * ===========================================================================
 * `docker-compose.yml` publishes redis as `127.0.0.1:6379:6379` — an IPv4-ONLY bind. On a
 * dual-stack host `localhost` resolves `::1` first, nothing listens there, and the connection
 * does not refuse: it HANGS until the client's own timeout.
 *
 * That failure mode is invisible in exactly the way that costs a day. On 2026-08-21 it stopped
 * the entire Phase 9 evaluation: `AI_SPEND_REDIS_URL=redis://localhost:6379` made the TD68
 * SpendLedger time out at 2.0s, which correctly fails CLOSED, so all 168 query embeds were
 * blocked — with a healthy redis container running the whole time. Measured: `localhost`
 * 2.016s fail, `127.0.0.1` 0.000s.
 *
 * Both files previously told a developer to use `localhost`. The compose comment asserted
 * "host tools still reach it at localhost:6379", which is false for this bind. Prose that is
 * wrong in this specific way is worse than absent prose, because it is quoted while debugging.
 *
 * The fix is guidance, NOT a code change: nothing about TD68 is weakened, no spend control is
 * bypassed, and no developer-local address is compiled into shipped configuration. These are a
 * comment and an example file. This test simply stops the wrong advice coming back.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..", "..");
const COMPOSE = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
const STAGING_EXAMPLE = readFileSync(
  join(ROOT, "apps", "ai-service", ".env.staging.example"),
  "utf8",
);

/** Strip `#` comment bodies so a rule can be asserted about the DIRECTIVE, not the prose. */
const uncommented = (s: string): string =>
  s
    .split("\n")
    .map((l) => l.replace(/(^|\s)#.*$/, "$1"))
    .join("\n");

describe("redis loopback guidance — the ::1 trap that fails closed", () => {
  it("compose still publishes redis on the IPv4 loopback only", () => {
    // If this bind ever widens, the guidance below stops being necessary — but widening it
    // is a security decision (an unauthenticated redis on a routable interface), so the test
    // should break and be read, not silently pass.
    expect(uncommented(COMPOSE)).toContain('"127.0.0.1:6379:6379"');
  });

  it("the compose comment no longer claims host tools can use localhost:6379", () => {
    expect(COMPOSE).not.toMatch(/host tools still reach it at localhost:6379/);
  });

  it("compose explains that 127.0.0.1 is required for host tools", () => {
    expect(COMPOSE).toMatch(/127\.0\.0\.1:6379.*NOT localhost:6379|NOT localhost:6379/);
  });

  it("the staging example recommends 127.0.0.1 for a host-run ai-service", () => {
    expect(STAGING_EXAMPLE).toMatch(/redis:\/\/127\.0\.0\.1:6379\/0/);
  });

  it("the staging example explicitly marks redis://localhost as not working", () => {
    // The string may still APPEAR — it is named in order to be warned against. What must not
    // survive is naming it as the recommendation, so assert the warning sits on that line.
    const line = STAGING_EXAMPLE.split("\n").find((l) => l.includes("redis://localhost:6379/0"));
    expect(line).toBeDefined();
    expect(line).toMatch(/DOES NOT WORK/);
  });

  it("the real AI_SPEND_REDIS_URL directive is still empty by default", () => {
    // UNSET selects the in-process backend, which is the correct dev/CI default. A committed
    // example that ships a live URL would arm a store the developer does not own.
    const directives = uncommented(STAGING_EXAMPLE)
      .split("\n")
      .filter((l) => l.trim().startsWith("AI_SPEND_REDIS_URL="));
    expect(directives).toHaveLength(1);
    // Staging's example is a placeholder host, never a loopback address.
    expect(directives[0]).not.toMatch(/localhost|127\.0\.0\.1/);
  });

  it("nothing hardcodes a loopback spend-ledger URL into compose", () => {
    // The value must come from the environment. A default here would make every deploy
    // silently point at a store on the box rather than the one that was provisioned.
    expect(uncommented(COMPOSE)).not.toMatch(/AI_SPEND_REDIS_URL:\s*redis:\/\//);
  });
});
