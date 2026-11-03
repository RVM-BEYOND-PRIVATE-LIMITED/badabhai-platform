import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { UnauthorizedException } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { PiiCryptoService } from "../common/pii-crypto.service";
import type { RequestContext } from "../common/request-context";
import { AdminAttemptLockoutService } from "./admin-attempt-lockout.service";
import { AdminAuthService } from "./admin-auth.service";
import { AdminMfaSecretStore } from "./admin-mfa.store";
import { AdminPasswordService } from "./admin-password.service";
import { currentTotpCode, generateTotpEnrollment } from "./admin-mfa";
import { fakeRedis } from "./testing/fake-redis";

/**
 * Security review B1, end to end: a LEAKED PASSWORD for an admin with two-step ON must not buy
 * an unlimited "password → one TOTP guess" loop.
 *
 * Wired from the REAL pieces that interact — AdminPasswordService (which clears the `password`
 * counter and re-mints the OTP-pending marker on every correct password), AdminAuthService
 * (the gate + verifyMfa), the real AdminMfaSecretStore (marker in Redis, seed AES at rest) and the
 * real AdminAttemptLockoutService — over one in-memory Redis. Only the edges with no bearing on
 * the property (sessions, events, OTP mail, devices) are stubbed.
 */

const CTX: RequestContext = {
  correlationId: "11111111-1111-4111-8111-111111111111",
  requestId: "req-1",
};
const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const EMAIL = "ops.admin@badabhai.in";
const PASSWORD = "Correct-horse-9";
const MAX = 5;

const pii = new PiiCryptoService({
  PII_HASH_PEPPER: "test-pepper",
  PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
} as unknown as ServerConfig);
const PASSWORD_HASH = pii.hashPassword(PASSWORD);

function setup() {
  const { secret } = generateTotpEnrollment("BadaBhai Admin", ADMIN_ID);
  const row = {
    id: ADMIN_ID,
    role: "support" as const,
    status: "active" as const,
    passwordHash: PASSWORD_HASH,
    passwordPepperVersion: 1,
    passwordSetAt: new Date("2026-11-01T00:00:00.000Z"),
    mustChangePassword: false,
    mfaEnrolled: true,
    mfaEnabled: true,
    mfaSecretEnc: pii.encrypt(secret),
  };
  const config = {
    ADMIN_MFA_REQUIRED: true,
    ADMIN_TOTP_ISSUER: "BadaBhai Admin",
    OTP_RESEND_COOLDOWN_SECONDS: 30,
    ADMIN_PASSWORD_MAX_ATTEMPTS: MAX,
    ADMIN_PASSWORD_LOCKOUT_SECONDS: 900,
  } as unknown as ServerConfig;
  const admins = {
    emailHash: (email: string) => `hmac<${email}>`,
    findByEmailHash: vi.fn(async () => row),
    findById: vi.fn(async () => row),
    findMfaSecret: vi.fn(async () => row.mfaSecretEnc),
    setMfaEnrolled: vi.fn(async () => row),
    touchLastLogin: vi.fn(async () => undefined),
  };
  const redis = fakeRedis();
  const queue = { client: Promise.resolve(redis.client) } as unknown as Queue;
  const lockout = new AdminAttemptLockoutService(config, queue);
  const mfaStore = new AdminMfaSecretStore(pii, queue, admins as never);
  const sessions = {
    create: vi.fn(async () => ({ token: "admin-jwt", expiresInSeconds: 2592000 })),
    revoke: vi.fn(async () => undefined),
  };
  const events = { emit: vi.fn(async () => undefined) };
  const devices = { isTrusted: vi.fn(async () => false), issue: vi.fn(async () => null) };
  const auth = new AdminAuthService(
    config,
    admins as never,
    {} as never,
    sessions as never,
    mfaStore,
    events as never,
    {} as never,
    devices as never,
    lockout,
  );
  const passwords = new AdminPasswordService(
    config,
    admins as never,
    pii,
    lockout,
    {} as never,
    sessions as never,
    auth,
    events as never,
  );
  const wrong = currentTotpCode(secret) === "000000" ? "111111" : "000000";
  return { auth, passwords, sessions, redis, secret, wrong };
}

const passwordLogin = (d: ReturnType<typeof setup>) =>
  d.passwords.loginWithPassword({ email: EMAIL, password: PASSWORD }, CTX);

describe("B1 — a leaked password cannot loop 'password → one TOTP guess'", () => {
  it(`after ${MAX} wrong TOTPs, a FRESH correct password + the CORRECT TOTP is still refused`, async () => {
    const d = setup();
    for (let i = 0; i < MAX; i += 1) {
      // Each round: a correct password (re-mints the one-guess marker, clears the PASSWORD
      // counter) followed by one wrong TOTP.
      expect(await passwordLogin(d)).toEqual({ status: "mfa_required", needs_enrollment: false });
      await expect(d.auth.verifyMfa({ email: EMAIL, code: d.wrong }, CTX)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    }

    // A fresh, SUCCESSFUL password login in between…
    expect(await passwordLogin(d)).toEqual({ status: "mfa_required", needs_enrollment: false });
    // …does not reset the TOTP counter: the 6th attempt is refused, even with the RIGHT code.
    const err = await d.auth
      .verifyMfa({ email: EMAIL, code: currentTotpCode(d.secret) }, CTX)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as Error).message).toBe("Incorrect or expired code");
    expect(d.sessions.create).not.toHaveBeenCalled();

    // The password door's own counter WAS cleared by those successes; the TOTP one was not.
    expect(d.redis.store.has(`admin_pw:attempts:${ADMIN_ID}`)).toBe(false);
    expect(d.redis.store.get(`admin_mfa_login:attempts:${ADMIN_ID}`)).toBe(String(MAX));
    expect(d.redis.ttls.get(`admin_mfa_login:attempts:${ADMIN_ID}`)).toBe(900);
  });

  it("control: under the cap, password + the correct TOTP DOES mint (the refusal above is the cap)", async () => {
    const d = setup();
    for (let i = 0; i < MAX - 1; i += 1) {
      await passwordLogin(d);
      await d.auth.verifyMfa({ email: EMAIL, code: d.wrong }, CTX).catch(() => undefined);
    }
    await passwordLogin(d);
    const res = await d.auth.verifyMfa({ email: EMAIL, code: currentTotpCode(d.secret) }, CTX);
    expect(res).toMatchObject({ access_token: "admin-jwt" });
    // …and the success clears the TOTP counter.
    expect(d.redis.store.has(`admin_mfa_login:attempts:${ADMIN_ID}`)).toBe(false);
  });
});
