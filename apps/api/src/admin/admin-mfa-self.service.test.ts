import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import {
  ConflictException,
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import type { AdminStatus } from "@badabhai/db";
import { validateEvent } from "@badabhai/event-schema";
import { PiiCryptoService } from "../common/pii-crypto.service";
import type { RequestContext } from "../common/request-context";
import { AdminAttemptLockoutService } from "./admin-attempt-lockout.service";
import { AdminMfaSecretStore } from "./admin-mfa.store";
import { AdminMfaSelfService } from "./admin-mfa-self.service";
import { currentTotpCode, generateTotpEnrollment } from "./admin-mfa";
import { fakeRedis } from "./testing/fake-redis";

const CTX: RequestContext = {
  correlationId: "11111111-1111-4111-8111-111111111111",
  requestId: "req-1",
};
const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const MAX_ATTEMPTS = 3;

const pii = new PiiCryptoService({
  PII_HASH_PEPPER: "test-pepper",
  PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
} as unknown as ServerConfig);

type Row = {
  id: string;
  status: AdminStatus;
  mfaEnabled: boolean;
  mfaEnrolled: boolean;
  mfaSecretEnc: string | null;
};

/**
 * A STATEFUL admin_users double implementing exactly the guarded writes the switch uses, with
 * the repository's WHERE guards — so an enable → confirm → disable round trip runs through the
 * REAL secret store (real AES at rest) and the REAL TOTP maths.
 */
function makeAdmins(initial: Partial<Row>) {
  const r: Row = {
    id: ADMIN_ID,
    status: "active",
    mfaEnabled: false,
    mfaEnrolled: false,
    mfaSecretEnc: null,
    ...initial,
  };
  const TX = { tx: true };
  return {
    r,
    TX,
    findById: vi.fn(async () => ({ ...r })),
    findMfaSecret: vi.fn(async () => r.mfaSecretEnc),
    stageMfaEnrolment: vi.fn(async (_id: string, enc: string) => {
      if (r.mfaEnabled) return false;
      r.mfaSecretEnc = enc;
      r.mfaEnrolled = false;
      return true;
    }),
    enableMfa: vi.fn(async () => {
      if (r.mfaEnabled || !r.mfaSecretEnc) return false;
      r.mfaEnabled = true;
      r.mfaEnrolled = true;
      return true;
    }),
    disableMfa: vi.fn(async () => {
      if (!r.mfaEnabled) return false;
      r.mfaEnabled = false;
      r.mfaEnrolled = false;
      r.mfaSecretEnc = null;
      return true;
    }),
    withTransaction: vi.fn(async <T>(cb: (tx: unknown) => Promise<T>) => cb(TX)),
  };
}

function setup(initial: Partial<Row> = {}) {
  const config = {
    ADMIN_TOTP_ISSUER: "BadaBhai Admin",
    ADMIN_PASSWORD_MAX_ATTEMPTS: MAX_ATTEMPTS,
    ADMIN_PASSWORD_LOCKOUT_SECONDS: 900,
  } as unknown as ServerConfig;
  const admins = makeAdmins(initial);
  const redis = fakeRedis();
  const queue = { client: Promise.resolve(redis.client) } as unknown as Queue;
  const store = new AdminMfaSecretStore(pii, queue, admins as never);
  const lockout = new AdminAttemptLockoutService(config, queue);
  const events = {
    emit: vi.fn(async (_e: { payload: Record<string, unknown>; tx?: unknown }) => undefined),
  };
  const svc = new AdminMfaSelfService(config, admins as never, store, lockout, events as never);
  return { svc, admins, events, redis };
}

/** An enabled admin with a real, known seed. */
function enabledWithSeed() {
  const { secret } = generateTotpEnrollment("BadaBhai Admin", ADMIN_ID);
  const d = setup({ mfaEnabled: true, mfaEnrolled: true, mfaSecretEnc: pii.encrypt(secret) });
  return { ...d, secret };
}

function wrongCode(secret: string): string {
  const right = currentTotpCode(secret);
  return right === "000000" ? "111111" : "000000";
}

function registryValid(payload: Record<string, unknown>): boolean {
  return validateEvent({
    event_id: "11111111-1111-4111-8111-111111111111",
    event_name: "admin.action_performed",
    event_version: 1,
    occurred_at: "2026-11-03T00:00:00.000Z",
    actor: { actor_type: "admin", actor_id: ADMIN_ID },
    subject: { subject_type: "admin_session", subject_id: ADMIN_ID },
    source: "api",
    correlation_id: "22222222-2222-4222-8222-222222222222",
    causation_id: null,
    payload,
    metadata: { environment: "test", service: "api" },
  }).success;
}

describe("AdminMfaSelfService — enable → confirm round trip (Amendment 1)", () => {
  it("enable returns a fresh secret whose REAL TOTP confirms it; the switch is ON only after confirm", async () => {
    const d = setup();
    const { enrollment } = await d.svc.enable(ADMIN_ID);

    expect(enrollment.secret).toMatch(/^[A-Z2-7]+$/);
    expect(enrollment.otpauth_uri).toContain(encodeURIComponent(ADMIN_ID));
    expect(enrollment.otpauth_uri).toContain(`secret=${enrollment.secret}`);
    // Staged ENCRYPTED, not enabled, not enrolled yet.
    expect(d.admins.r.mfaSecretEnc).not.toBeNull();
    expect(d.admins.r.mfaSecretEnc).not.toContain(enrollment.secret);
    expect(pii.decrypt(d.admins.r.mfaSecretEnc!)).toBe(enrollment.secret);
    expect(d.admins.r.mfaEnabled).toBe(false);
    expect(d.admins.r.mfaEnrolled).toBe(false);

    const res = await d.svc.confirm(ADMIN_ID, currentTotpCode(enrollment.secret), CTX);
    expect(res).toEqual({ mfa_enabled: true });
    expect(d.admins.r.mfaEnabled).toBe(true);
    expect(d.admins.r.mfaEnrolled).toBe(true);

    const call = d.events.emit.mock.calls[0]![0];
    expect(call.payload).toEqual({
      admin_id: ADMIN_ID,
      action_code: "admin_mfa_enabled",
      target_type: "admin_session",
      target_id: ADMIN_ID,
    });
    expect(call.tx).toBe(d.admins.TX);
    expect(registryValid(call.payload)).toBe(true);
    // The seed never rides the event.
    expect(JSON.stringify(d.events.emit.mock.calls)).not.toContain(enrollment.secret);
  });

  it("a WRONG confirm code → 401 'Incorrect code'; the switch stays OFF and nothing is evented", async () => {
    const d = setup();
    const { enrollment } = await d.svc.enable(ADMIN_ID);
    const err = await d.svc
      .confirm(ADMIN_ID, wrongCode(enrollment.secret), CTX)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as Error).message).toBe("Incorrect code");
    expect(d.admins.r.mfaEnabled).toBe(false);
    expect(d.events.emit).not.toHaveBeenCalled();
  });

  it("confirm with nothing staged → the same 401", async () => {
    const d = setup();
    await expect(d.svc.confirm(ADMIN_ID, "123456", CTX)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("enable / confirm while already ON → 409 (a live seed is never swapped from a session)", async () => {
    const d = enabledWithSeed();
    const before = d.admins.r.mfaSecretEnc;
    await expect(d.svc.enable(ADMIN_ID)).rejects.toBeInstanceOf(ConflictException);
    await expect(d.svc.confirm(ADMIN_ID, currentTotpCode(d.secret), CTX)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(d.admins.r.mfaSecretEnc).toBe(before);
  });

  it("re-enabling after a disable shows a NEW secret (the old QR is dead)", async () => {
    const d = setup();
    const first = await d.svc.enable(ADMIN_ID);
    await d.svc.confirm(ADMIN_ID, currentTotpCode(first.enrollment.secret), CTX);
    await d.svc.disable(ADMIN_ID, currentTotpCode(first.enrollment.secret), CTX);
    const second = await d.svc.enable(ADMIN_ID);
    expect(second.enrollment.secret).not.toBe(first.enrollment.secret);
  });
});

describe("AdminMfaSelfService — disable needs a valid CURRENT code", () => {
  it("a valid current code → OFF: enabled, enrolled AND the seed cleared; admin_mfa_disabled", async () => {
    const d = enabledWithSeed();
    const res = await d.svc.disable(ADMIN_ID, currentTotpCode(d.secret), CTX);
    expect(res).toEqual({ mfa_enabled: false });
    expect(d.admins.r).toMatchObject({ mfaEnabled: false, mfaEnrolled: false, mfaSecretEnc: null });
    const payload = d.events.emit.mock.calls[0]![0].payload;
    expect(payload).toMatchObject({ action_code: "admin_mfa_disabled", target_id: ADMIN_ID });
    expect(registryValid(payload)).toBe(true);
  });

  it("a WRONG code → 401, still ON, seed intact, nothing evented", async () => {
    const d = enabledWithSeed();
    await expect(d.svc.disable(ADMIN_ID, wrongCode(d.secret), CTX)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(d.admins.r.mfaEnabled).toBe(true);
    expect(d.admins.r.mfaSecretEnc).not.toBeNull();
    expect(d.events.emit).not.toHaveBeenCalled();
  });

  it("not enabled → 409", async () => {
    const d = setup();
    await expect(d.svc.disable(ADMIN_ID, "123456", CTX)).rejects.toBeInstanceOf(ConflictException);
  });

  it(`code attempts are capped: after ${MAX_ATTEMPTS} wrong codes even the RIGHT one is a 429`, async () => {
    const d = enabledWithSeed();
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await d.svc.disable(ADMIN_ID, wrongCode(d.secret), CTX).catch(() => undefined);
    }
    const err = await d.svc
      .disable(ADMIN_ID, currentTotpCode(d.secret), CTX)
      .catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(d.admins.r.mfaEnabled).toBe(true);
  });

  it("a suspended admin (mid-session) can switch nothing", async () => {
    const d = setup({ status: "suspended" });
    await expect(d.svc.enable(ADMIN_ID)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
