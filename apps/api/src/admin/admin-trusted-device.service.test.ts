import "reflect-metadata";
import { describe, expect, it } from "vitest";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { PiiCryptoService } from "../common/pii-crypto.service";
import {
  AdminTrustedDeviceService,
  type TrustedDeviceAccount,
} from "./admin-trusted-device.service";

const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_ID = "bbbbbbbb-0000-4000-8000-000000000002";

const pii = new PiiCryptoService({
  PII_HASH_PEPPER: "test-pepper",
  PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
} as unknown as ServerConfig);

function makeRedis(opts: { throwOn?: string } = {}) {
  const store = new Map<string, { value: string; ttl: number }>();
  const guard = (cmd: string) => {
    if (opts.throwOn === cmd) throw new Error(`redis ${cmd} failed`);
  };
  return {
    store,
    client: {
      async set(key: string, value: string, _mode: "EX", ttl: number) {
        guard("set");
        store.set(key, { value, ttl });
        return "OK";
      },
      async get(key: string) {
        guard("get");
        return store.get(key)?.value ?? null;
      },
    },
  };
}

function setup(over: { days?: number; throwOn?: string } = {}) {
  const redis = makeRedis({ throwOn: over.throwOn });
  const queue = { client: Promise.resolve(redis.client) } as unknown as Queue;
  const config = { ADMIN_TRUSTED_DEVICE_DAYS: over.days ?? 30 } as unknown as ServerConfig;
  return { svc: new AdminTrustedDeviceService(config, pii, queue), redis };
}

const SEED_ENC = pii.encrypt("JBSWY3DPEHPK3PXP");
const ISSUED_AT = new Date("2026-11-03T10:00:00.000Z");
const LATER = new Date("2026-11-04T10:00:00.000Z");

function account(over: Partial<TrustedDeviceAccount> = {}): TrustedDeviceAccount {
  return { id: ADMIN_ID, mfaEnrolled: true, mfaSecretEnc: SEED_ENC, passwordSetAt: null, ...over };
}

async function issued(over: { days?: number; passwordSetAt?: Date | null } = {}) {
  const d = setup(over);
  const device = await d.svc.issue(
    { id: ADMIN_ID, mfaSecretEnc: SEED_ENC, passwordSetAt: over.passwordSetAt ?? null },
    ISSUED_AT,
  );
  return { ...d, device: device! };
}

describe("AdminTrustedDeviceService.issue (0144)", () => {
  it("mints a 256-bit base64url token and stores ONLY its keyed HMAC, with the day TTL", async () => {
    const { device, redis } = await issued();
    expect(device.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(device.expiresInSeconds).toBe(30 * 86400);
    const keys = [...redis.store.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]!.startsWith("admin_trusted_device:")).toBe(true);
    // The raw token is NOWHERE in Redis — not in the key, not in the record.
    expect(JSON.stringify([...redis.store.entries()])).not.toContain(device.token);
    expect(redis.store.get(keys[0]!)!.ttl).toBe(30 * 86400);
    // The record holds the seed FINGERPRINT, never the seed or its ciphertext.
    const record = JSON.parse(redis.store.get(keys[0]!)!.value) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(["admin_id", "created_at_ms", "mfa_fp", "pwe"]);
    // The credential epoch at issue (B2): 0 = this admin had no password yet.
    expect(record.pwe).toBe(0);
    expect(JSON.stringify(record)).not.toContain(SEED_ENC);
  });

  it("issues NOTHING when ADMIN_TRUSTED_DEVICE_DAYS=0 (the off-switch)", async () => {
    const d = setup({ days: 0 });
    expect(
      await d.svc.issue({ id: ADMIN_ID, mfaSecretEnc: SEED_ENC, passwordSetAt: null }),
    ).toBeNull();
    expect(d.redis.store.size).toBe(0);
  });

  it("issues nothing without a seed to fingerprint", async () => {
    expect(
      await setup().svc.issue({ id: ADMIN_ID, mfaSecretEnc: null, passwordSetAt: null }),
    ).toBeNull();
  });

  it("a Redis refusal returns null (asked for TOTP next time) — never throws into the login", async () => {
    expect(
      await setup({ throwOn: "set" }).svc.issue({
        id: ADMIN_ID,
        mfaSecretEnc: SEED_ENC,
        passwordSetAt: null,
      }),
    ).toBeNull();
  });
});

describe("AdminTrustedDeviceService.isTrusted — every way the trust must die", () => {
  it("a fresh device for the same admin + same seed is trusted", async () => {
    const { svc, device } = await issued();
    expect(await svc.isTrusted(device.token, account(), LATER)).toBe(true);
  });

  it("REJECTED after a password set/change/reset — the credential epoch must be EQUAL (B2)", async () => {
    const setAt = new Date(ISSUED_AT.getTime() - 60_000);
    const { svc, device } = await issued({ passwordSetAt: setAt });
    // Same epoch as at issue → trusted.
    expect(await svc.isTrusted(device.token, account({ passwordSetAt: setAt }), LATER)).toBe(true);
    // Any later change kills it…
    const changed = new Date(ISSUED_AT.getTime() + 60_000);
    expect(await svc.isTrusted(device.token, account({ passwordSetAt: changed }), LATER)).toBe(
      false,
    );
    // …including one stamped EARLIER than the device's issue time, or in the same second —
    // equality, not a time comparison (a clock-skewed or same-second reset must still kill it).
    const sameSecond = new Date(setAt.getTime() + 1);
    expect(await svc.isTrusted(device.token, account({ passwordSetAt: sameSecond }), LATER)).toBe(
      false,
    );
    // An admin who had NO password at issue and sets a first one: dead too.
    const fresh = await issued();
    expect(
      await fresh.svc.isTrusted(fresh.device.token, account({ passwordSetAt: setAt }), LATER),
    ).toBe(false);
  });

  it("REJECTED after the MFA secret changes (re-enrol / reset → a new ciphertext)", async () => {
    const { svc, device } = await issued();
    // Same plaintext seed re-encrypted is a NEW ciphertext (fresh IV) — trust dies with it.
    const reSaved = pii.encrypt("JBSWY3DPEHPK3PXP");
    expect(reSaved).not.toBe(SEED_ENC);
    expect(await svc.isTrusted(device.token, account({ mfaSecretEnc: reSaved }), LATER)).toBe(
      false,
    );
  });

  it("REJECTED when the seed was cleared or the admin is no longer enrolled", async () => {
    const { svc, device } = await issued();
    expect(await svc.isTrusted(device.token, account({ mfaSecretEnc: null }), LATER)).toBe(false);
    expect(await svc.isTrusted(device.token, account({ mfaEnrolled: false }), LATER)).toBe(false);
  });

  it("REJECTED for a different admin presenting the same token", async () => {
    const { svc, device } = await issued();
    expect(await svc.isTrusted(device.token, account({ id: OTHER_ID }), LATER)).toBe(false);
  });

  it("REJECTED when ADMIN_TRUSTED_DEVICE_DAYS is 0 — even a live record is not honoured", async () => {
    const live = await issued();
    const off = setup({ days: 0 });
    // Same Redis contents, feature switched off.
    for (const [k, v] of live.redis.store) off.redis.store.set(k, v);
    // Checked at the ISSUE instant (age 0), so the age-vs-budget rule cannot be what rejects it —
    // only the off-switch can. (Measured: at a later instant the age rule masked a removed
    // off-switch check and this test stayed green.)
    expect(await off.svc.isTrusted(live.device.token, account(), ISSUED_AT)).toBe(false);
    // ...while the same record at the same instant IS trusted with the feature on.
    expect(await live.svc.isTrusted(live.device.token, account(), ISSUED_AT)).toBe(true);
  });

  it("REJECTED once older than the CURRENT day budget (config lowered after issue)", async () => {
    const live = await issued({ days: 30 });
    const shorter = setup({ days: 1 });
    for (const [k, v] of live.redis.store) shorter.redis.store.set(k, v);
    const twoDaysLater = new Date(ISSUED_AT.getTime() + 2 * 86400_000);
    expect(await shorter.svc.isTrusted(live.device.token, account(), twoDaysLater)).toBe(false);
  });

  it("an unknown token, a Redis error, or a garbage record is simply not trusted", async () => {
    const { svc, redis, device } = await issued();
    expect(await svc.isTrusted("z".repeat(43), account(), LATER)).toBe(false);
    for (const k of redis.store.keys()) redis.store.set(k, { value: "{not json", ttl: 1 });
    expect(await svc.isTrusted(device.token, account(), LATER)).toBe(false);
    const broken = setup({ throwOn: "get" });
    expect(await broken.svc.isTrusted(device.token, account(), LATER)).toBe(false);
  });
});
