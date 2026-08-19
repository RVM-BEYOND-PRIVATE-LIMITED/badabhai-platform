/**
 * R38 — every published port is loopback-bound unless it is deliberately public.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT. The failure mode is invisible in review: `"8080:8080"`
 * and `"127.0.0.1:8080:8080"` differ by eleven characters and only one of them puts a database
 * admin console on the public internet. R38 was found by reading a deploy's `docker compose ps`
 * output weeks after the fact, not by anyone noticing the diff.
 *
 * It cannot be fixed from an overlay, which is the non-obvious part and the reason the
 * assertions below read the BASE file. Compose merges `ports` by
 * {ip, target, published, protocol} and APPENDS entries whose key differs — so an overlay
 * adding `127.0.0.1:5432:5432` does NOT replace a base `5432:5432`; both binds survive and the
 * 0.0.0.0 exposure remains. (compose-spec 13-merge.md, "Unique resources".) The base file is
 * the only place the bind can be narrowed.
 *
 * The allowlist below is the whole point: a port is public because someone wrote it here and
 * said why, not because a bare port string slipped through.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..", "..");
const BASE = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
const E2E = readFileSync(join(ROOT, "docker-compose.e2e.yml"), "utf8");

/**
 * Host ports that are ALLOWED to bind every interface, each with the reason.
 *
 * Adding an entry here is the reviewable act. Anything not listed must be loopback-bound.
 */
const INTENTIONALLY_PUBLIC: Readonly<Record<string, string>> = {
  "3001": "the api itself — this is the service the box exists to serve",
};

/** Every published-port entry in a compose file, as written. */
function publishedPorts(yaml: string): string[] {
  return yaml
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^- "(\d|127\.0\.0\.1:)/.test(l))
    .map((l) => l.replace(/^- "/, "").replace(/".*$/, ""));
}

describe("R38 — published-port bindings in the base compose file", () => {
  it("binds every port to 127.0.0.1 except the explicitly-public allowlist", () => {
    const offenders: string[] = [];
    for (const entry of publishedPorts(BASE)) {
      if (entry.startsWith("127.0.0.1:")) continue;
      const hostPort = entry.split(":")[0] ?? "";
      if (INTENTIONALLY_PUBLIC[hostPort] === undefined) offenders.push(entry);
    }
    expect(
      offenders,
      `these publish on 0.0.0.0 with no recorded reason: ${offenders.join(", ")}. ` +
        "Either bind 127.0.0.1 or add the port to INTENTIONALLY_PUBLIC with a justification.",
    ).toEqual([]);
  });

  /**
   * The four R38 named specifically. Pinned individually as well as by the sweep above, so a
   * regression on any one of them names the service rather than just a port number — and so
   * that widening the allowlist cannot silently re-expose them.
   */
  it.each([
    ["postgres", "127.0.0.1:5432:5432"],
    ["adminer (a full DB admin console)", "127.0.0.1:8080:8080"],
    ["redis", "127.0.0.1:6379:6379"],
    ["ai-service", "127.0.0.1:8000:8000"],
    ["proxy harness", "127.0.0.1:8088:8080"],
  ])("keeps %s loopback-bound", (_name, bind) => {
    expect(BASE).toContain(`- "${bind}"`);
  });

  it("never leaves a bare bind for those same host ports", () => {
    // The complement of the assertion above: `toContain` would still pass if BOTH a bare and
    // a loopback entry were present, which is exactly the state a mistaken overlay "fix"
    // produces — and exactly the state that keeps the port exposed.
    for (const bare of ['- "5432:5432"', '- "8080:8080"', '- "6379:6379"', '- "8000:8000"', '- "8088:8080"']) {
      expect(BASE).not.toContain(bare);
    }
  });

  it("the e2e postgres remap is loopback too", () => {
    // Its own file, and it had the same defect. The box's `docker compose ps` showed a
    // 0.0.0.0:5433 bind, which means this override was loaded somewhere it should not be.
    expect(E2E).toContain('- "127.0.0.1:5433:5432"');
    expect(E2E).not.toContain('- "5433:5432"');
  });

  it("the api stays public, and says why", () => {
    // The guard must not be so eager that it breaks the one binding that has to be open.
    expect(BASE).toContain('- "3001:3001"');
    expect(INTENTIONALLY_PUBLIC["3001"]).toBeDefined();
  });
});
