import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import type { AdminRole, AdminStatus } from "@badabhai/db";
import { validateEvent } from "@badabhai/event-schema";
import { PiiCryptoService } from "../common/pii-crypto.service";
import type { RequestContext } from "../common/request-context";
import { AdminAttemptLockoutService } from "./admin-attempt-lockout.service";
import { AdminPasswordService } from "./admin-password.service";
import { fakeRedis } from "./testing/fake-redis";

const CTX: RequestContext = {
  correlationId: "11111111-1111-4111-8111-111111111111",
  requestId: "req-1",
};
const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const SID = "sid-old";
const EMAIL = "ops.admin@badabhai.in";
const PASSWORD = "Correct-horse-9";
const TEMP = "Temp-pass-1234";
const NEW_PASSWORD = "Brand-new-pass-7";
const NEUTRAL = "Incorrect email or password";
const MAX_ATTEMPTS = 3;

/** One instance per setup, so each KDF spy counts only its own service's calls. */
const makePii = () =>
  new PiiCryptoService({
    PII_HASH_PEPPER: "test-pepper",
    PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  } as unknown as ServerConfig);
const pii = makePii();
// Hashed once (scrypt is deliberately slow).
const PASSWORD_HASH = pii.hashPassword(PASSWORD);
const TEMP_HASH = pii.hashPassword(TEMP);

type Row = {
  id: string;
  role: AdminRole;
  status: AdminStatus;
  passwordHash: string | null;
  passwordPepperVersion: number | null;
  passwordSetAt: Date | null;
  mustChangePassword: boolean;
  mfaEnrolled: boolean;
  mfaEnabled: boolean;
};

function row(over: Partial<Row> = {}): Row {
  return {
    id: ADMIN_ID,
    role: "ops_admin",
    status: "active",
    passwordHash: PASSWORD_HASH,
    passwordPepperVersion: 1,
    passwordSetAt: new Date("2026-11-01T00:00:00.000Z"),
    mustChangePassword: false,
    mfaEnrolled: false,
    mfaEnabled: false,
    ...over,
  };
}

function setup(over: { account?: Row | undefined; redisDown?: boolean } = {}) {
  const account = "account" in over ? over.account : row();
  const config = {
    OTP_RESEND_COOLDOWN_SECONDS: 30,
    ADMIN_PASSWORD_MAX_ATTEMPTS: MAX_ATTEMPTS,
    ADMIN_PASSWORD_LOCKOUT_SECONDS: 900,
  } as unknown as ServerConfig;

  const TX = { tx: true };
  const admins = {
    emailHash: (email: string) => `hmac<${email}>`,
    findByEmailHash: vi.fn(async () => account as never),
    findById: vi.fn(async () => account as never),
    setPassword: vi.fn(
      async (_id: string, write: { hash: string; pepperVersion: number; setAt: Date }) =>
        (account && account.status === "active"
          ? {
              ...account,
              passwordHash: write.hash,
              passwordPepperVersion: write.pepperVersion,
              passwordSetAt: write.setAt,
              mustChangePassword: false,
            }
          : undefined) as never,
    ),
    withTransaction: vi.fn(async <T>(cb: (tx: unknown) => Promise<T>) => cb(TX)),
  };
  const redis = fakeRedis({ throwOn: over.redisDown ? "get" : undefined });
  const queue = { client: Promise.resolve(redis.client) } as unknown as Queue;
  const lockout = new AdminAttemptLockoutService(config, queue);
  const otp = {
    issueAndSend: vi.fn(async () => ({ resendInSeconds: 30 })),
    issueAndDispatch: vi.fn(async () => ({ resendInSeconds: 30 })),
    issueWithoutDelivery: vi.fn(async () => ({ resendInSeconds: 30 })),
    verify: vi.fn(async () => undefined),
  };
  const sessions = { revoke: vi.fn(async () => undefined), create: vi.fn() };
  const session = {
    access_token: "fresh-admin-jwt",
    token_type: "Bearer" as const,
    expires_in_seconds: 2592000,
    admin_id: ADMIN_ID,
    role: "ops_admin" as const,
  };
  const auth = {
    gateMfaThenMaybeMint: vi.fn(async (_account: unknown, _ctx: unknown, _device?: string) => ({
      status: "mfa_required",
      needs_enrollment: false,
    })),
    mintSession: vi.fn(async (_account: unknown, _ctx: unknown) => session),
  };
  const events = {
    emit: vi.fn(async (_e: { payload: Record<string, unknown>; tx?: unknown }) => undefined),
  };
  const ownPii = makePii();
  const kdf = vi.spyOn(ownPii, "verifyPassword");

  const svc = new AdminPasswordService(
    config,
    admins as never,
    ownPii,
    lockout,
    otp as never,
    sessions as never,
    auth as never,
    events as never,
  );
  return { svc, admins, otp, sessions, auth, events, redis, kdf, TX, session };
}

/** Raw password / code / email must never ride an event. */
function assertEventsClean(events: { emit: ReturnType<typeof vi.fn> }) {
  const blob = JSON.stringify(events.emit.mock.calls);
  for (const secret of [EMAIL, "badabhai.in", PASSWORD, TEMP, NEW_PASSWORD, "123456"]) {
    expect(blob).not.toContain(secret);
  }
}

function emittedCodes(events: { emit: ReturnType<typeof vi.fn> }): string[] {
  return events.emit.mock.calls.map(
    (c) => (c[0] as { payload: { action_code: string } }).payload.action_code,
  );
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

// ---------------------------------------------------------------------------
// POST /admin/login/password — no-enumeration
// ---------------------------------------------------------------------------
describe("loginWithPassword — every miss is the SAME 401 and burns ONE KDF", () => {
  async function failure(d: ReturnType<typeof setup>, password = "Wrong-pass-0") {
    const err = await d.svc
      .loginWithPassword({ email: EMAIL, password }, CTX)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    return err as UnauthorizedException;
  }

  it("unknown email and wrong password are indistinguishable (status, message, KDF count)", async () => {
    const unknown = setup({ account: undefined });
    const wrong = setup();
    const a = await failure(unknown);
    const b = await failure(wrong);
    expect(a.getStatus()).toBe(b.getStatus());
    expect(a.message).toBe(NEUTRAL);
    expect(b.message).toBe(NEUTRAL);
    expect(JSON.stringify(a.getResponse())).toBe(JSON.stringify(b.getResponse()));
    // One full scrypt each — no timing oracle between "no account" and "wrong password".
    expect(unknown.kdf).toHaveBeenCalledTimes(1);
    expect(wrong.kdf).toHaveBeenCalledTimes(1);
    expect(unknown.auth.gateMfaThenMaybeMint).not.toHaveBeenCalled();
    expect(wrong.auth.gateMfaThenMaybeMint).not.toHaveBeenCalled();
  });

  it("an admin with NO password set gets the same 401 after one (dummy) KDF", async () => {
    const d = setup({ account: row({ passwordHash: null, passwordPepperVersion: null }) });
    expect((await failure(d, PASSWORD)).message).toBe(NEUTRAL);
    expect(d.kdf).toHaveBeenCalledTimes(1);
  });

  for (const status of ["pending", "suspended"] as const) {
    it(`a ${status} admin with the CORRECT password gets the same 401 — never a session`, async () => {
      const d = setup({ account: row({ status }) });
      expect((await failure(d, PASSWORD)).message).toBe(NEUTRAL);
      expect(d.auth.gateMfaThenMaybeMint).not.toHaveBeenCalled();
      expect(d.auth.mintSession).not.toHaveBeenCalled();
    });
  }

  it(`locks out after ${MAX_ATTEMPTS} failures — then even the RIGHT password is the same 401`, async () => {
    const d = setup();
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) await failure(d);
    d.kdf.mockClear();
    expect((await failure(d, PASSWORD)).message).toBe(NEUTRAL);
    expect(d.auth.gateMfaThenMaybeMint).not.toHaveBeenCalled();
    // The locked path still burns one KDF (no lockout timing oracle).
    expect(d.kdf).toHaveBeenCalledTimes(1);
  });

  it("a success clears the failure counter", async () => {
    const d = setup();
    await failure(d);
    await failure(d);
    await d.svc.loginWithPassword({ email: EMAIL, password: PASSWORD }, CTX);
    expect(d.redis.store.size).toBe(0);
  });

  it("FAILS CLOSED (503) when the lockout counter cannot be read", async () => {
    const d = setup({ redisDown: true });
    await expect(
      d.svc.loginWithPassword({ email: EMAIL, password: PASSWORD }, CTX),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(d.auth.gateMfaThenMaybeMint).not.toHaveBeenCalled();
  });

  it("the right password hands the account to the SHARED MFA gate, device token included", async () => {
    const d = setup();
    const res = await d.svc.loginWithPassword(
      { email: EMAIL, password: PASSWORD, device_token: "t".repeat(43) },
      CTX,
    );
    expect(d.auth.gateMfaThenMaybeMint).toHaveBeenCalledWith(
      expect.objectContaining({ id: ADMIN_ID }),
      CTX,
      "t".repeat(43),
    );
    expect(res).toEqual({ status: "mfa_required", needs_enrollment: false });
    // A normal sign-in writes nothing.
    expect(d.admins.setPassword).not.toHaveBeenCalled();
    expect(d.events.emit).not.toHaveBeenCalled();
  });

  it("a new_password on a NON-temporary account is ignored (no write)", async () => {
    const d = setup();
    await d.svc.loginWithPassword(
      { email: EMAIL, password: PASSWORD, new_password: NEW_PASSWORD },
      CTX,
    );
    expect(d.admins.setPassword).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The must-change (temporary password) step
// ---------------------------------------------------------------------------
describe("loginWithPassword — temporary password must be replaced first", () => {
  const tempRow = () => row({ passwordHash: TEMP_HASH, mustChangePassword: true });

  it("missing new_password → password_change_required (no session, no write, no gate)", async () => {
    const d = setup({ account: tempRow() });
    const res = await d.svc.loginWithPassword({ email: EMAIL, password: TEMP }, CTX);
    expect(res).toEqual({ status: "password_change_required" });
    expect(d.auth.gateMfaThenMaybeMint).not.toHaveBeenCalled();
    expect(d.admins.setPassword).not.toHaveBeenCalled();
  });

  it("new_password equal to the temporary one → 400, nothing written", async () => {
    const d = setup({ account: tempRow() });
    await expect(
      d.svc.loginWithPassword({ email: EMAIL, password: TEMP, new_password: TEMP }, CTX),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(d.admins.setPassword).not.toHaveBeenCalled();
    expect(d.events.emit).not.toHaveBeenCalled();
  });

  it("a WRONG temporary password never reaches the change step (same 401)", async () => {
    const d = setup({ account: tempRow() });
    await expect(
      d.svc.loginWithPassword(
        { email: EMAIL, password: "Not-the-temp-1", new_password: NEW_PASSWORD },
        CTX,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(d.admins.setPassword).not.toHaveBeenCalled();
  });

  it("valid new_password → stored (hashed), admin_password_set emitted on the tx, then the MFA gate", async () => {
    const d = setup({ account: tempRow() });
    const res = await d.svc.loginWithPassword(
      { email: EMAIL, password: TEMP, new_password: NEW_PASSWORD },
      CTX,
    );
    expect(res).toEqual({ status: "mfa_required", needs_enrollment: false });

    const [, write, tx] = d.admins.setPassword.mock.calls[0]! as unknown as [
      string,
      { hash: string; pepperVersion: number; setAt: Date },
      unknown,
    ];
    expect(pii.verifyPassword(NEW_PASSWORD, write.hash)).toBe(true);
    expect(write.hash).not.toContain(NEW_PASSWORD);
    expect(write.pepperVersion).toBe(1);
    expect(write.setAt).toBeInstanceOf(Date);
    expect(tx).toBe(d.TX);

    expect(emittedCodes(d.events)).toEqual(["admin_password_set"]);
    const call = d.events.emit.mock.calls[0]![0];
    expect(call.tx).toBe(d.TX);
    expect(call.payload).toEqual({
      admin_id: ADMIN_ID,
      action_code: "admin_password_set",
      target_type: "admin_session",
      target_id: ADMIN_ID,
    });
    expect(registryValid(call.payload)).toBe(true);
    assertEventsClean(d.events);

    // The gate sees the UPDATED row (its new password_set_at is the trusted-device cut-off).
    const gated = d.auth.gateMfaThenMaybeMint.mock.calls[0]![0] as unknown as Row;
    expect(gated.mustChangePassword).toBe(false);
    expect(gated.passwordSetAt).toBe(write.setAt);
  });
});

// ---------------------------------------------------------------------------
// POST /admin/password/forgot + /reset
// ---------------------------------------------------------------------------
describe("requestReset — IDENTICAL response for every email", () => {
  it("active → DISPATCHED (not awaited) in the password_reset namespace; unknown/pending/suspended → reserved only", async () => {
    const active = setup();
    const a = await active.svc.requestReset({ email: EMAIL });
    expect(active.otp.issueAndDispatch).toHaveBeenCalledWith(
      `hmac<${EMAIL}>`,
      EMAIL,
      "password_reset",
    );
    // Never the awaiting sender — its provider latency was the timing oracle.
    expect(active.otp.issueAndSend).not.toHaveBeenCalled();
    expect(active.otp.issueWithoutDelivery).not.toHaveBeenCalled();

    const bodies = [a];
    for (const account of [undefined, row({ status: "pending" }), row({ status: "suspended" })]) {
      const d = setup({ account });
      bodies.push(await d.svc.requestReset({ email: EMAIL }));
      expect(d.otp.issueWithoutDelivery).toHaveBeenCalledWith(`hmac<${EMAIL}>`, "password_reset");
      expect(d.otp.issueAndDispatch).not.toHaveBeenCalled();
      expect(d.otp.issueAndSend).not.toHaveBeenCalled();
    }
    for (const body of bodies) expect(body).toEqual({ status: "code_sent", resend_in_seconds: 30 });
  });

  it("the known-account path does not wait on the provider (a hanging send cannot delay it)", async () => {
    const d = setup();
    // Model the REAL dispatcher's contract: resolves after the reserve, delivery detached.
    let delivered = false;
    d.otp.issueAndDispatch.mockImplementationOnce(async () => {
      void new Promise<void>(() => undefined).then(() => {
        delivered = true;
      });
      return { resendInSeconds: 30 };
    });
    expect(await d.svc.requestReset({ email: EMAIL })).toEqual({
      status: "code_sent",
      resend_in_seconds: 30,
    });
    expect(delivered).toBe(false);
  });

  it("a cooldown 429 still propagates (the unknown branch hits the same one — no oracle)", async () => {
    const d = setup();
    d.otp.issueAndDispatch.mockRejectedValueOnce(
      new HttpException("wait", HttpStatus.TOO_MANY_REQUESTS),
    );
    await expect(d.svc.requestReset({ email: EMAIL })).rejects.toBeInstanceOf(HttpException);
  });
});

describe("resetPassword — sets the password, NEVER mints a session", () => {
  const dto = { email: EMAIL, code: "123456", new_password: NEW_PASSWORD };

  it("verifies against the password_reset namespace (a login code cannot reset)", async () => {
    const d = setup();
    await d.svc.resetPassword(dto, CTX);
    expect(d.otp.verify).toHaveBeenCalledWith(`hmac<${EMAIL}>`, "123456", "password_reset");
  });

  it("success: hashed write, admin_password_reset (actor = target), lockout cleared, next=sign_in", async () => {
    const d = setup();
    d.redis.store.set(`admin_pw:attempts:${ADMIN_ID}`, "2");
    const res = await d.svc.resetPassword(dto, CTX);
    expect(res).toEqual({ status: "password_reset", next: "sign_in" });

    const write = d.admins.setPassword.mock.calls[0]![1] as { hash: string; setAt: Date };
    expect(pii.verifyPassword(NEW_PASSWORD, write.hash)).toBe(true);
    expect(emittedCodes(d.events)).toEqual(["admin_password_reset"]);
    const payload = d.events.emit.mock.calls[0]![0].payload;
    expect(payload).toMatchObject({ admin_id: ADMIN_ID, target_id: ADMIN_ID });
    expect(registryValid(payload)).toBe(true);
    assertEventsClean(d.events);
    expect(d.redis.store.has(`admin_pw:attempts:${ADMIN_ID}`)).toBe(false);

    // NEVER a session, never the gate, never a revoke-and-remint.
    expect(d.auth.mintSession).not.toHaveBeenCalled();
    expect(d.auth.gateMfaThenMaybeMint).not.toHaveBeenCalled();
    expect(d.sessions.create).not.toHaveBeenCalled();
    expect(res).not.toHaveProperty("access_token");
  });

  for (const status of ["pending", "suspended"] as const) {
    it(`a ${status} admin never gets a reset (same neutral 401, nothing written)`, async () => {
      const d = setup({ account: row({ status }) });
      const err = await d.svc.resetPassword(dto, CTX).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect((err as Error).message).toBe("Incorrect or expired code");
      expect(d.admins.setPassword).not.toHaveBeenCalled();
      expect(d.events.emit).not.toHaveBeenCalled();
    });
  }

  it("a wrong code stops before any lookup or write", async () => {
    const d = setup();
    d.otp.verify.mockRejectedValueOnce(new UnauthorizedException("Incorrect or expired code"));
    await expect(d.svc.resetPassword(dto, CTX)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(d.admins.findByEmailHash).not.toHaveBeenCalled();
    expect(d.admins.setPassword).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /admin/me/password
// ---------------------------------------------------------------------------
describe("changeOwnPassword — current password required when one exists; fresh session", () => {
  const ADMIN = { id: ADMIN_ID, sid: SID };

  it("with a password: missing current_password → 401", async () => {
    const d = setup();
    const err = await d.svc
      .changeOwnPassword(ADMIN, { new_password: NEW_PASSWORD }, CTX)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as Error).message).toBe("Current password is incorrect");
    expect(d.admins.setPassword).not.toHaveBeenCalled();
  });

  it("wrong current_password → 401 AND it counts toward the sign-in lockout", async () => {
    const d = setup();
    await expect(
      d.svc.changeOwnPassword(
        ADMIN,
        { current_password: "Wrong-pass-0", new_password: NEW_PASSWORD },
        CTX,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(d.redis.store.get(`admin_pw:attempts:${ADMIN_ID}`)).toBe("1");
    expect(d.admins.setPassword).not.toHaveBeenCalled();
  });

  it("locked out → 429 (the caller is authenticated, so there is no oracle to protect)", async () => {
    const d = setup();
    d.redis.store.set(`admin_pw:attempts:${ADMIN_ID}`, String(MAX_ATTEMPTS));
    const err = await d.svc
      .changeOwnPassword(ADMIN, { current_password: PASSWORD, new_password: NEW_PASSWORD }, CTX)
      .catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });

  it("new == current → 400", async () => {
    const d = setup();
    await expect(
      d.svc.changeOwnPassword(ADMIN, { current_password: PASSWORD, new_password: PASSWORD }, CTX),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("right current_password → write + admin_password_set, OLD sid revoked, FRESH session returned", async () => {
    const d = setup();
    const res = await d.svc.changeOwnPassword(
      ADMIN,
      { current_password: PASSWORD, new_password: NEW_PASSWORD },
      CTX,
    );
    expect(res).toBe(d.session);
    expect(d.sessions.revoke).toHaveBeenCalledWith(SID);
    expect(emittedCodes(d.events)).toEqual(["admin_password_set"]);
    assertEventsClean(d.events);
    // The fresh session is minted from the UPDATED row, AFTER the write.
    const minted = d.auth.mintSession.mock.calls[0]![0] as unknown as Row;
    const write = d.admins.setPassword.mock.calls[0]![1] as { setAt: Date };
    expect(minted.passwordSetAt).toBe(write.setAt);
    expect(d.admins.setPassword.mock.invocationCallOrder[0]!).toBeLessThan(
      d.auth.mintSession.mock.invocationCallOrder[0]!,
    );
    expect(d.sessions.revoke.mock.invocationCallOrder[0]!).toBeLessThan(
      d.auth.mintSession.mock.invocationCallOrder[0]!,
    );
  });

  it("no password yet: current_password is ignored and the first password is set", async () => {
    const d = setup({ account: row({ passwordHash: null, passwordPepperVersion: null }) });
    await d.svc.changeOwnPassword(
      ADMIN,
      { current_password: "whatever", new_password: NEW_PASSWORD },
      CTX,
    );
    expect(d.admins.setPassword).toHaveBeenCalledTimes(1);
    expect(d.kdf).not.toHaveBeenCalled();
  });

  it("a suspended row (mid-session) cannot change anything", async () => {
    const d = setup({ account: row({ status: "suspended" }) });
    await expect(
      d.svc.changeOwnPassword(
        ADMIN,
        { current_password: PASSWORD, new_password: NEW_PASSWORD },
        CTX,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(d.admins.setPassword).not.toHaveBeenCalled();
  });
});
