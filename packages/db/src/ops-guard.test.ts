/**
 * The guard that decides whether an ops runner may write.
 *
 * Every branch is pinned because the branch that must never be wrong is the one that does
 * nothing: a guard that silently permits is indistinguishable, in a log, from a guard that
 * correctly permitted. The two historical failures this replaces are both asserted directly —
 * the false refusal of a read-only dry run, and the false permit of a production write.
 */
import { describe, expect, it } from "vitest";

import {
  PRODUCTION_WRITE_ENV,
  PRODUCTION_WRITE_FLAG,
  hostClass,
  isProductionLike,
  opsGuard,
  type OpsGuardInput,
} from "./ops-guard";

const LOCAL = "postgres://badabhai:pw@127.0.0.1:5432/badabhai";
const PROD = "postgres://postgres.abcd:pw@aws-0-ap-south-1.pooler.supabase.com:5432/postgres";
const OTHER = "postgres://u:pw@db.internal.example:5432/postgres";

const guard = (o: Partial<OpsGuardInput> = {}) =>
  opsGuard({
    script: "retag",
    connectionString: LOCAL,
    nodeEnv: undefined,
    allowEnv: undefined,
    argv: [],
    mutating: false,
    ...o,
  });

describe("hostClass / isProductionLike", () => {
  it.each([
    [LOCAL, "LOCAL DOCKER"],
    ["postgres://u:p@localhost:5432/db", "LOCAL DOCKER"],
    ["postgres://u:p@[::1]:5432/db", "LOCAL DOCKER"],
    [PROD, "SUPABASE (remote)"],
    [OTHER, "OTHER-REMOTE"],
    ["not a url", "UNPARSEABLE"],
  ])("%s -> %s", (url, expected) => {
    expect(hostClass(url)).toBe(expected);
  });

  it("never echoes the credential", () => {
    expect(hostClass("postgres://admin:hunter2@db.supabase.co:5432/postgres")).not.toMatch(/hunter2|admin/);
  });

  it("treats anything not provably local as production-like — fails CLOSED", () => {
    // Including an unparseable string. A guard that must understand a URL before it protects
    // you stops protecting you the first time it meets a format nobody anticipated.
    expect(isProductionLike(LOCAL)).toBe(false);
    expect(isProductionLike(PROD)).toBe(true);
    expect(isProductionLike(OTHER)).toBe(true);
    expect(isProductionLike("not a url")).toBe(true);
  });
});

describe("development — the ordinary case", () => {
  it("allows a dry run", () => {
    expect(guard({ mutating: false }).allowed).toBe(true);
  });

  it("allows a write, with no ceremony", () => {
    const v = guard({ mutating: true });
    expect(v.allowed).toBe(true);
    expect(v.refusal).toBeNull();
  });

  it("says nothing alarming about a local target", () => {
    expect(guard({ mutating: true }).warning).toBeNull();
  });
});

describe("staging / other-remote", () => {
  it("is treated as production-like — a write needs authorisation", () => {
    // There is no staging DATABASE_URL in this repo's ops flow, and guessing from a hostname
    // which remote is 'safe' is how a real one gets written to. Remote means authorise.
    expect(guard({ connectionString: OTHER, mutating: true }).allowed).toBe(false);
  });

  it("still allows a read-only dry run against it", () => {
    expect(guard({ connectionString: OTHER, mutating: false }).allowed).toBe(true);
  });
});

describe("production — refusal unless explicitly authorised", () => {
  it("refuses a write to a production database even when NODE_ENV is unset", () => {
    // THE FALSE PERMIT. This is the default state of a laptop whose environment points at
    // production, and the old NODE_ENV-only guard allowed it.
    const v = guard({ connectionString: PROD, nodeEnv: undefined, mutating: true });
    expect(v.allowed).toBe(false);
    expect(v.refusal).toMatch(/REFUSING TO WRITE/);
  });

  it("refuses a write when NODE_ENV=production even against a LOCAL database", () => {
    // The second tripwire, kept independent: an operator who correctly labelled their process
    // should not be rescued by a connection string this function failed to classify.
    expect(guard({ connectionString: LOCAL, nodeEnv: "production", mutating: true }).allowed).toBe(false);
  });

  it("refuses with only the flag", () => {
    const v = guard({ connectionString: PROD, argv: [PRODUCTION_WRITE_FLAG], mutating: true });
    expect(v.allowed).toBe(false);
    expect(v.refusal).toContain(PRODUCTION_WRITE_ENV);
  });

  it("refuses with only the env var", () => {
    const v = guard({ connectionString: PROD, allowEnv: "retag", mutating: true });
    expect(v.allowed).toBe(false);
    expect(v.refusal).toContain(PRODUCTION_WRITE_FLAG);
  });

  it("refuses when the env var authorises a DIFFERENT runner, and says so", () => {
    // The reason the variable carries a name rather than a boolean: a stale export left over
    // from authorising one script must not silently authorise the next.
    const v = guard({
      connectionString: PROD,
      argv: [PRODUCTION_WRITE_FLAG],
      allowEnv: "promote-skills",
      mutating: true,
    });
    expect(v.allowed).toBe(false);
    expect(v.refusal).toMatch(/authorises a different runner/);
  });

  it("allows the write when BOTH signals are present and agree", () => {
    const v = guard({
      connectionString: PROD,
      argv: [PRODUCTION_WRITE_FLAG],
      allowEnv: "retag",
      mutating: true,
    });
    expect(v.allowed).toBe(true);
    expect(v.warning).toMatch(/AUTHORISED/);
  });

  it("an authorised write still announces the target", () => {
    const v = guard({ connectionString: PROD, argv: [PRODUCTION_WRITE_FLAG], allowEnv: "retag", mutating: true });
    expect(v.warning).toContain("SUPABASE (remote)");
  });
});

describe("dry run — the false refusal this replaces", () => {
  it("is allowed against production, with NODE_ENV=production, with no authorisation at all", () => {
    // THE FALSE REFUSAL. The old guard blocked exactly this, and the workaround — unsetting
    // NODE_ENV — also unblocked --apply. A guard people routinely disable is worse than none,
    // because it still carries authority.
    const v = guard({ connectionString: PROD, nodeEnv: "production", mutating: false });
    expect(v.allowed).toBe(true);
    expect(v.refusal).toBeNull();
  });

  it("announces loudly that the target is production and that nothing will be written", () => {
    const v = guard({ connectionString: PROD, mutating: false });
    expect(v.warning).toContain("SUPABASE (remote)");
    expect(v.warning).toMatch(/read-only; nothing will be written/);
  });

  it("authorisation is not required and not consumed by a dry run", () => {
    expect(guard({ connectionString: PROD, mutating: false }).allowed).toBe(true);
  });
});

describe("the flag cannot be triggered accidentally", () => {
  it("matches the flag exactly, not as a prefix", () => {
    expect(
      guard({
        connectionString: PROD,
        argv: [`${PRODUCTION_WRITE_FLAG}=false`],
        allowEnv: "retag",
        mutating: true,
      }).allowed,
    ).toBe(false);
  });

  it("an empty OPS_ALLOW_PRODUCTION does not authorise an unnamed script", () => {
    expect(
      guard({ connectionString: PROD, argv: [PRODUCTION_WRITE_FLAG], allowEnv: "", mutating: true }).allowed,
    ).toBe(false);
  });
});
