import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JwtService } from "@nestjs/jwt";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import type { AdminUser } from "@badabhai/db";
import { AdminSessionService } from "./admin-session.service";
import type { AdminRepository } from "./admin.repository";
import { epochMatches, passwordEpochOf } from "./admin-credential-epoch";

/**
 * Migration 0144 / security review B2 — the CREDENTIAL-EPOCH cut-off in `validateAndTouch`.
 *
 * Every admin JWT carries `pwe` = the `password_set_at` epoch (ms, 0 = none) it was minted for,
 * and is valid only while that EQUALS the row's. The previous rule — `iat < floor(set_at/1000)`
 * — let a token from the SAME SECOND as a reset survive it, and POST /admin/refresh re-mints
 * `iat`, so a stolen session refreshing at ≥ 1 Hz always held such a token. These cases pin the
 * replacement: same second, same millisecond, refreshed — all dead after a reset.
 */

const SECRET = "admin-secret-distinct-from-worker-and-payer";
const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const config = { SESSION_TTL_DAYS: 30 } as unknown as ServerConfig;

function setup(initialSetAt: Date | null = null) {
  const store = new Map<string, string>();
  const redis = {
    async set(key: string, value: string) {
      store.set(key, value);
      return "OK";
    },
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async del(...keys: string[]) {
      let n = 0;
      for (const k of keys) if (store.delete(k)) n += 1;
      return n;
    },
    async expire() {
      return 1;
    },
  };
  const live: { passwordSetAt: Date | null } = { passwordSetAt: initialSetAt };
  const admins = {
    findById: vi.fn(
      async (id: string) =>
        ({
          id,
          role: "super_admin",
          status: "active",
          passwordSetAt: live.passwordSetAt,
        }) as unknown as AdminUser,
    ),
  } as unknown as AdminRepository;
  const queue = { client: Promise.resolve(redis) } as unknown as Queue;
  const jwt = new JwtService({ secret: SECRET, signOptions: { algorithm: "HS256" } });
  return { svc: new AdminSessionService(config, jwt, queue, admins), live, jwt, store };
}

/** Mint the way the app does: on the CURRENT row's epoch. */
const epochOf = (live: { passwordSetAt: Date | null }) => passwordEpochOf(live.passwordSetAt);

afterEach(() => {
  vi.useRealTimers();
});

describe("AdminSessionService — the credential-epoch cut-off (B2)", () => {
  it("every minted token carries the epoch it was minted for (`pwe`)", async () => {
    const setAt = new Date("2026-11-03T10:00:00.123Z");
    const { svc, jwt } = setup(setAt);
    const { token } = await svc.create(ADMIN_ID, "super_admin", passwordEpochOf(setAt));
    expect(jwt.decode<{ pwe: number }>(token).pwe).toBe(setAt.getTime());
    const v = await svc.validateAndTouch(token);
    expect(v).toMatchObject({ adminId: ADMIN_ID, passwordEpoch: setAt.getTime() });
  });

  it("a session minted before a reset is rejected on its next request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-03T10:00:00.000Z"));
    const { svc, live } = setup();
    const { token } = await svc.create(ADMIN_ID, "super_admin", epochOf(live));
    expect(await svc.validateAndTouch(token)).not.toBeNull();

    live.passwordSetAt = new Date("2026-11-03T10:05:00.000Z");
    expect(await svc.validateAndTouch(token)).toBeNull();
  });

  it("a session killed by a reset has its Redis record DELETED (a rollback cannot revive it)", async () => {
    const { svc, live, store } = setup();
    const { token } = await svc.create(ADMIN_ID, "super_admin", epochOf(live));
    expect(store.size).toBe(1);

    live.passwordSetAt = new Date("2026-11-03T10:05:00.000Z");
    expect(await svc.validateAndTouch(token)).toBeNull();
    expect(store.size).toBe(0);
  });

  it("a token minted in the SAME second — even the same millisecond — as the reset, before it committed, is rejected", async () => {
    vi.useFakeTimers();
    const instant = new Date("2026-11-03T10:05:00.400Z");
    vi.setSystemTime(instant);
    const { svc, live } = setup(new Date("2026-11-01T00:00:00.000Z"));
    // Minted on the OLD epoch at the very instant the reset is about to commit.
    const { token } = await svc.create(ADMIN_ID, "super_admin", epochOf(live));
    live.passwordSetAt = instant; // the reset commits, same millisecond
    expect(await svc.validateAndTouch(token)).toBeNull();
  });

  it("a REFRESHED old token is rejected — refresh re-mints iat, but never the epoch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-03T10:05:00.000Z"));
    const { svc, live } = setup();
    const { token } = await svc.create(ADMIN_ID, "super_admin", epochOf(live));
    const validated = await svc.validateAndTouch(token);
    expect(validated).not.toBeNull();

    // A reset commits; the attacker's refresh lands one second LATER with a brand-new iat,
    // re-minted on the epoch the guard validated it against — the OLD one.
    live.passwordSetAt = new Date("2026-11-03T10:05:00.500Z");
    vi.setSystemTime(new Date("2026-11-03T10:05:01.000Z"));
    const refreshed = await svc.mint(
      ADMIN_ID,
      validated!.sid,
      "super_admin",
      validated!.passwordEpoch,
    );
    expect(await svc.validateAndTouch(refreshed.token)).toBeNull();
  });

  it("the post-change FRESH session (minted on the NEW epoch) is accepted", async () => {
    vi.useFakeTimers();
    const setAt = new Date("2026-11-03T10:05:00.400Z");
    vi.setSystemTime(setAt);
    const { svc, live } = setup();
    live.passwordSetAt = setAt;
    const { token } = await svc.create(ADMIN_ID, "super_admin", epochOf(live));
    expect(await svc.validateAndTouch(token)).toMatchObject({ adminId: ADMIN_ID });
  });

  it("BACKWARD COMPATIBLE: a pre-0144 token (no `pwe`) works until the admin sets a password", async () => {
    const { svc, live, jwt } = setup();
    // Seed a live Redis session for a hand-signed legacy token.
    const created = await svc.create(ADMIN_ID, "super_admin", 0);
    const sid = (await svc.validateAndTouch(created.token))!.sid;
    const legacy = await jwt.signAsync({ sub: ADMIN_ID, sid, typ: "admin", role: "super_admin" });
    expect(await svc.validateAndTouch(legacy)).not.toBeNull();
    live.passwordSetAt = new Date("2026-11-03T10:05:00.000Z");
    expect(await svc.validateAndTouch(legacy)).toBeNull();
  });
});

describe("epochMatches — equality only, fail closed", () => {
  const setAt = new Date(1_793_700_000_500);

  it("matches exactly the row's epoch; an absent claim is 0", () => {
    expect(epochMatches(setAt.getTime(), setAt)).toBe(true);
    expect(epochMatches(setAt.getTime() - 1, setAt)).toBe(false);
    expect(epochMatches(setAt.getTime() + 1, setAt)).toBe(false);
    expect(epochMatches(undefined, null)).toBe(true);
    expect(epochMatches(0, null)).toBe(true);
    expect(epochMatches(undefined, setAt)).toBe(false);
  });

  it("anything that is not a finite number never matches", () => {
    expect(epochMatches(String(setAt.getTime()), setAt)).toBe(false);
    expect(epochMatches(Number.NaN, null)).toBe(false);
    expect(epochMatches(null, null)).toBe(false);
  });
});
