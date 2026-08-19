/**
 * #994 — the redis in the base compose file is the WORKER SESSION STORE, and it must be
 * configured like one.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT. `session:*`, `refresh:*`, `refresh_family:*`,
 * `worker_sessions:*` and `worker_families:*` (apps/api/src/auth/session.service.ts) live in
 * this redis and NOWHERE else — there is no Postgres mirror. Every property that keeps them
 * alive is one token in a YAML file: an `--appendonly` flag, an `--appendfsync` policy, a
 * `--maxmemory-policy`, a `/data` volume mount, a top-level volume declaration. Delete any one
 * of them and the platform still boots, still PINGs, still deploys green — and every worker is
 * force-logged-out, seeing "PIN sahi nahi" for a PIN that is correct, because PIN unlock is a
 * refresh-token lookup behind a deliberately-neutral 401.
 *
 * That failure has no test that would have caught it, no alarm, and no log line. It has this
 * file. The deploy asserts the same properties against the LIVE box (CD-7, in
 * scripts/deploy/staging-deploy.sh); this asserts them against the file the box deploys, so a
 * regression is caught in review rather than on a worker's handset.
 *
 * Same read-the-file-and-assert-on-text shape as published-port-binding-compose.guard.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..", "..");
const BASE = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
const STAGING = readFileSync(join(ROOT, "docker-compose.staging.yml"), "utf8");

/** The `redis:` service block of the base file, up to the next top-level service. */
function redisBlock(yaml: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => /^ {2}redis:\s*$/.test(l));
  expect(start, "the base compose file no longer declares a `redis:` service").toBeGreaterThan(-1);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}\S/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

const REDIS = redisBlock(BASE);
/** The same block with comment lines dropped — the flags actually passed, not the prose. */
const REDIS_FLAGS = REDIS.split("\n")
  .filter((l) => !l.trim().startsWith("#"))
  .join("\n");

describe("#994 — the redis session store is configured to survive a restart", () => {
  it("runs with AOF on (--appendonly yes)", () => {
    // Without this a restart replays only the last RDB snapshot: every session minted since
    // then is gone, and those workers are logged out with nothing recorded anywhere.
    expect(
      /--appendonly["',\s-]+yes/.test(REDIS_FLAGS),
      "redis must run with `--appendonly yes` — see the comment above the command in docker-compose.yml",
    ).toBe(true);
  });

  it("pins appendfsync to everysec", () => {
    // Documented as load-bearing right above the flag: `no` hands durability to the kernel's
    // flush timing, which on an unclean stop is exactly the "sessions from the last few
    // minutes vanished" bug. Asserted so the doc comment is not the only thing holding it.
    expect(
      /--appendfsync["',\s-]+everysec/.test(REDIS_FLAGS),
      "redis must pin `--appendfsync everysec`",
    ).toBe(true);
  });

  it("pins maxmemory-policy to noeviction", () => {
    // Load-bearing twice: an LRU/random policy silently evicts LIVE refresh tokens under
    // memory pressure (a logout with no error anywhere), and BullMQ refuses to run at all
    // against an evicting instance.
    expect(
      /--maxmemory-policy["',\s-]+noeviction/.test(REDIS_FLAGS),
      "redis must pin `--maxmemory-policy noeviction`",
    ).toBe(true);
  });

  it("does NOT pass --save, so redis's built-in RDB snapshots stay armed", () => {
    // Any --save on the command line REPLACES the built-in set, so restating it is the one
    // way to accidentally weaken (or, with `--save ""`, delete) the second copy that backs
    // up the AOF. Leaving it off is what keeps the defaults.
    expect(REDIS_FLAGS).not.toMatch(/--save/);
  });

  it("mounts /data on the named, top-level-declared badabhai_redisdata volume", () => {
    // The flags above only protect what is IN the volume. An anonymous or missing volume is
    // a store that starts empty on every container recreate — i.e. on every deploy.
    expect(REDIS_FLAGS).toContain("badabhai_redisdata:/data");
    expect(BASE).toMatch(/^volumes:$/m);
    expect(BASE, "badabhai_redisdata must be declared under the top-level `volumes:` key").toMatch(
      /^ {2}badabhai_redisdata:$/m,
    );
  });

  it("does NOT pin a compose project name here — the deploy detects drift instead", () => {
    // A top-level `name:` would need Compose v2.3.3+ (unverified on the box: an unsupported
    // key fails at PARSE, taking every deploy command with it), and pinning a name we cannot
    // confirm matches the live project would ITSELF mount a new empty volume on first run —
    // the cure causing the disease. The deploy asserts compose still resolves the RUNNING
    // redis instead; see the pre-flight drift guard asserted below.
    expect(BASE).not.toMatch(/^name:/m);
  });

  it("keeps the staging overlay OUT of the redis definition", () => {
    // If the overlay ever declared its own `redis:`, the assertions above would be checking a
    // file the box does not actually run. The base file must stay the single source of truth
    // for the production session store.
    expect(
      /^ {2}redis:$/m.test(STAGING),
      "docker-compose.staging.yml must not define a `redis:` service — the base file is the single source for the session store",
    ).toBe(false);
  });
});

describe("#994 — the deploy proves the session store survived", () => {
  // The deploy body lives in the extracted script, not in ci.yml — see that file's header
  // and ci-deploy-script-size.guard.test.ts for why. Asserting against ci.yml here would
  // pass vacuously forever the moment CD-7 moved, so this reads where the commands are.
  const DEPLOY = readFileSync(join(ROOT, "scripts", "deploy", "staging-deploy.sh"), "utf8");

  it("asserts appendonly + noeviction on the LIVE box and fails the deploy if either is off", () => {
    // A file that says `--appendonly yes` proves nothing about a box that is running a
    // container started before the flag existed. CD-7 reads the running instance.
    expect(DEPLOY).toContain("CONFIG GET appendonly");
    expect(DEPLOY).toContain("CONFIG GET maxmemory-policy");
  });

  it("writes and reads a deploy canary, so a wiped keyspace cannot deploy silently", () => {
    // PING PONGs on an empty keyspace, so PING can never answer "did the data survive". A
    // TTL-less key written each deploy and read on the next one can.
    expect(DEPLOY).toContain("deploy:canary");
  });

  it("refuses to deploy when the compose project name has drifted, BEFORE `up` can act", () => {
    // The project name namespaces the volumes. If compose resolves a different project than
    // the running container belongs to, `up` mounts a NEW EMPTY session store — the invisible
    // wipe. `docker ps` finds the container by its fixed container_name regardless of project;
    // `$COMPOSE ps -q redis` finds it only if THIS invocation resolves the same one. The two
    // disagreeing is the drift, and it must be caught before `up -d --no-deps redis`.
    const guard = DEPLOY.indexOf("docker ps -q -f name='^badabhai-redis$'");
    const up = DEPLOY.indexOf("$COMPOSE up -d --no-deps redis");
    expect(guard, "the compose-project drift guard is missing from the deploy").toBeGreaterThan(-1);
    expect(
      guard,
      "the drift guard must run BEFORE `up`, or it cannot prevent the wipe",
    ).toBeLessThan(up);
  });

  it("never prints the worker_families KEYS (worker ids) into the job log", () => {
    // The lineage count is observability; the keys are `worker_families:<workerId>`. Dropping
    // the `| wc -l` would tip a bounded integer into a list of worker ids in a DEPLOY log.
    const scan = DEPLOY.match(/--scan --pattern 'worker_families:\*'[^\n]*/);
    expect(scan, "the worker_families scan disappeared from CD-7").not.toBeNull();
    expect(scan![0], "the scan must be counted, never printed").toContain("wc -l");
  });
});
