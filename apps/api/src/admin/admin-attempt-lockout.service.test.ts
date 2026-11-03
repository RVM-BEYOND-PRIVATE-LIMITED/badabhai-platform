import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { ServiceUnavailableException } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { AdminAttemptLockoutService, RECORD_FAILURE_SCRIPT } from "./admin-attempt-lockout.service";
import { fakeRedis } from "./testing/fake-redis";

const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const config = {
  ADMIN_PASSWORD_MAX_ATTEMPTS: 3,
  ADMIN_PASSWORD_LOCKOUT_SECONDS: 900,
} as unknown as ServerConfig;

function setup(throwOn?: string) {
  const redis = fakeRedis({ throwOn });
  const queue = { client: Promise.resolve(redis.client) } as unknown as Queue;
  return { svc: new AdminAttemptLockoutService(config, queue), redis };
}

describe("AdminAttemptLockoutService (0142)", () => {
  it("scope keys: the contract's admin_pw:attempts:<id>, plus one counter per guessable code", () => {
    expect(AdminAttemptLockoutService.key("password", ADMIN_ID)).toBe(
      `admin_pw:attempts:${ADMIN_ID}`,
    );
    expect(AdminAttemptLockoutService.key("mfa_toggle", ADMIN_ID)).toBe(
      `admin_mfa_toggle:attempts:${ADMIN_ID}`,
    );
    expect(AdminAttemptLockoutService.key("mfa_login", ADMIN_ID)).toBe(
      `admin_mfa_login:attempts:${ADMIN_ID}`,
    );
  });

  it("locks after N failures; the FIRST failure arms the (non-sliding) window", async () => {
    const { svc, redis } = setup();
    for (let i = 0; i < 3; i += 1) {
      expect(await svc.isLockedOut("password", ADMIN_ID)).toBe(false);
      await svc.recordFailure("password", ADMIN_ID);
    }
    expect(await svc.isLockedOut("password", ADMIN_ID)).toBe(true);
    expect(redis.ttls.get(`admin_pw:attempts:${ADMIN_ID}`)).toBe(900);
  });

  it("clear() resets the counter", async () => {
    const { svc } = setup();
    for (let i = 0; i < 3; i += 1) await svc.recordFailure("password", ADMIN_ID);
    await svc.clear("password", ADMIN_ID);
    expect(await svc.isLockedOut("password", ADMIN_ID)).toBe(false);
  });

  it("scopes are independent — clearing the password scope never resets the TOTP scopes", async () => {
    const { svc } = setup();
    for (let i = 0; i < 3; i += 1) {
      await svc.recordFailure("mfa_toggle", ADMIN_ID);
      await svc.recordFailure("mfa_login", ADMIN_ID);
    }
    await svc.clear("password", ADMIN_ID);
    expect(await svc.isLockedOut("mfa_toggle", ADMIN_ID)).toBe(true);
    expect(await svc.isLockedOut("mfa_login", ADMIN_ID)).toBe(true);
    expect(await svc.isLockedOut("password", ADMIN_ID)).toBe(false);
  });

  it("FAILS CLOSED: a Redis error on the check or the record is a 503, never an allow", async () => {
    await expect(setup("get").svc.isLockedOut("mfa_login", ADMIN_ID)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(setup("eval").svc.recordFailure("mfa_login", ADMIN_ID)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("clear() is best-effort — a Redis error does not throw", async () => {
    await expect(setup("del").svc.clear("password", ADMIN_ID)).resolves.toBeUndefined();
  });
});

describe("AdminAttemptLockoutService — the failure count is ONE atomic Redis step (NIT)", () => {
  it("recordFailure issues exactly one `eval` — never a bare INCR followed by an EXPIRE", async () => {
    // INCR-then-EXPIRE as two round-trips can lose the EXPIRE (a dropped connection between
    // them), leaving a counter with NO TTL — a permanent lockout once it reaches the cap.
    const { svc, redis } = setup();
    await svc.recordFailure("mfa_login", ADMIN_ID);
    await svc.recordFailure("mfa_login", ADMIN_ID);
    expect(redis.calls).toEqual(["eval", "eval"]);
    expect(redis.calls).not.toContain("incr");
    expect(redis.calls).not.toContain("expire");
  });

  it("the script increments, then arms the window only when the key has NO ttl (heals, never slides)", () => {
    expect(RECORD_FAILURE_SCRIPT).toContain("redis.call('INCR', KEYS[1])");
    // `TTL < 0`, not `n == 1`: a key that somehow already lost its TTL is healed on the next
    // failure, and a live window is never pushed out (a trickle cannot hold the lock forever).
    expect(RECORD_FAILURE_SCRIPT).toContain("if redis.call('TTL', KEYS[1]) < 0 then");
    expect(RECORD_FAILURE_SCRIPT).toContain("redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))");
    expect(RECORD_FAILURE_SCRIPT.indexOf("INCR")).toBeLessThan(
      RECORD_FAILURE_SCRIPT.indexOf("EXPIRE"),
    );
  });

  it("passes the key and the configured window to the script", async () => {
    const { svc, redis } = setup();
    await svc.recordFailure("password", ADMIN_ID);
    expect(redis.ttls.get(`admin_pw:attempts:${ADMIN_ID}`)).toBe(900);
    expect(redis.store.get(`admin_pw:attempts:${ADMIN_ID}`)).toBe("1");
  });
});
