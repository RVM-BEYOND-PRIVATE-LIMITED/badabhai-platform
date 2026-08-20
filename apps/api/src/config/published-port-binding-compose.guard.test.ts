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
 * THE OVERLAY THAT ACTUALLY RUNS ON THE BOX, and until 2026-08-20 the one file this guard did
 * not read. `docker-compose.staging.yml` said so itself, in a comment next to a loopback bind:
 * "it reads ONLY docker-compose.yml and docker-compose.e2e.yml — it does NOT read this overlay,
 * so it did not and cannot check this line. The bind above is a deliberate choice, not a
 * guard-enforced one." A correct bind that nothing enforces is one edit from being wrong, and
 * R38 is the entry that exists because eleven characters went unreviewed.
 *
 * The merge caveat in the header cuts the other way here and is worth stating plainly: an
 * overlay cannot NARROW a base bind, but it can ADD a published port of its own — `payer-web`
 * and `admin-web` exist only in this file. So both files need the sweep, for opposite reasons.
 */
const STAGING = readFileSync(join(ROOT, "docker-compose.staging.yml"), "utf8");

/**
 * Host ports that are ALLOWED to bind every interface, each with the reason.
 *
 * Adding an entry here is the reviewable act. Anything not listed must be loopback-bound.
 */
const INTENTIONALLY_PUBLIC: Readonly<Record<string, string>> = {
  "3001": "the api itself — this is the service the box exists to serve",
  "3333":
    "payer-web (staging overlay) — the entire point of the v1 is reachability from OUTSIDE " +
    "the box for real browser traffic, so a loopback bind would defeat it outright",
};

/**
 * Every published-port entry in a compose file, as written — including the interpolated form
 * the staging overlay uses (`"${PAYER_WEB_PORT:-3333}:3002"`).
 *
 * The `${VAR:-default}` shape matters and is not cosmetic. A reader that only recognises a bare
 * leading digit skips those lines entirely, so the sweep would report ZERO offenders on a file
 * whose binds are all interpolated — passing loudly while checking nothing. The default is what
 * the box actually gets (the deploy sets neither variable), so the default is what is checked.
 */
function publishedPorts(yaml: string): string[] {
  return yaml
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^- "(\d|127\.0\.0\.1:|\$\{)/.test(l))
    .map((l) => l.replace(/^- "/, "").replace(/".*$/, ""))
    .filter((e) => /:\d+$/.test(e));
}

/** `${PAYER_WEB_PORT:-3333}:3002` -> `3333`; a literal host port is returned unchanged. */
export function resolveHostPort(entry: string): string {
  const withoutTarget = entry.replace(/:\d+$/, "");
  const hostPart = withoutTarget.startsWith("127.0.0.1:")
    ? withoutTarget.slice("127.0.0.1:".length)
    : withoutTarget;
  return /^\$\{[A-Z_0-9]+:-([0-9]+)\}$/.exec(hostPart)?.[1] ?? hostPart;
}

describe.each([
  ["docker-compose.yml", BASE],
  ["docker-compose.staging.yml", STAGING],
])("R38 — published-port bindings in %s", (file, yaml) => {
  it("binds every port to 127.0.0.1 except the explicitly-public allowlist", () => {
    const offenders: string[] = [];
    for (const entry of publishedPorts(yaml)) {
      if (entry.startsWith("127.0.0.1:")) continue;
      if (INTENTIONALLY_PUBLIC[resolveHostPort(entry)] === undefined) offenders.push(entry);
    }
    expect(
      offenders,
      `${file}: these publish on 0.0.0.0 with no recorded reason: ${offenders.join(", ")}. ` +
        "Either bind 127.0.0.1 or add the port to INTENTIONALLY_PUBLIC with a justification.",
    ).toEqual([]);
  });

  it("finds ports at all — a sweep that reads nothing passes vacuously", () => {
    // The failure this catches is the one that would have hidden the staging overlay for
    // another month: a reader that skips `${VAR:-3333}` reports zero offenders on a file full
    // of them, and zero offenders is what success looks like.
    expect(publishedPorts(yaml).length).toBeGreaterThan(0);
  });
});

describe("R38 — published-port bindings in the base compose file", () => {

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

  it("keeps the staging admin-web loopback-bound, defaults included", () => {
    // admin-web is the internal ops console. It exists only in the overlay, so the base-file
    // assertions above never saw it, and the overlay's own comment said no guard could.
    expect(STAGING).toContain('- "127.0.0.1:${ADMIN_WEB_PORT:-3003}:3003"');
    expect(STAGING).not.toContain('- "${ADMIN_WEB_PORT:-3003}:3003"');
  });

  it("resolves an interpolated host port to the default the box actually gets", () => {
    expect(resolveHostPort("${PAYER_WEB_PORT:-3333}:3002")).toBe("3333");
    expect(resolveHostPort("127.0.0.1:${ADMIN_WEB_PORT:-3003}:3003")).toBe("3003");
    expect(resolveHostPort("3001:3001")).toBe("3001");
    expect(resolveHostPort("127.0.0.1:5432:5432")).toBe("5432");
  });

  it("the api stays public, and says why", () => {
    // The guard must not be so eager that it breaks the one binding that has to be open.
    expect(BASE).toContain('- "3001:3001"');
    expect(INTENTIONALLY_PUBLIC["3001"]).toBeDefined();
  });
});
