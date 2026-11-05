import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import type { AdminRole, AdminStatus } from "@badabhai/db";
import { validateEvent } from "@badabhai/event-schema";
import type { RequestContext } from "../common/request-context";
import { AdminAuthService, MUST_CHANGE_VIA_PASSWORD } from "./admin-auth.service";
import { currentTotpCode, generateTotpEnrollment } from "./admin-mfa";
import { AdminAttemptLockoutService } from "./admin-attempt-lockout.service";
import { fakeRedis } from "./testing/fake-redis";

const CTX: RequestContext = {
  correlationId: "11111111-1111-4111-8111-111111111111",
  requestId: "req-1",
};
const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const EMAIL = "ops.admin@badabhai.in";

type Account = {
  id: string;
  role: AdminRole;
  status: AdminStatus;
  mfaEnrolled: boolean;
  /**
   * The admin's own two-step switch (owner Amendment 1, migration 0144). Defaults to ON in
   * `setup`, so every pre-amendment case below keeps exercising the two-step-ON gate it was
   * written for; the switch-OFF cases pass `false` explicitly.
   */
  mfaEnabled?: boolean;
  mfaSecretEnc?: string | null;
  passwordSetAt?: Date | null;
  mustChangePassword?: boolean;
};

function setup(
  over: {
    account?: Account;
    noAccount?: boolean;
    mfaRequired?: boolean;
    storedSecret?: string | null;
    otpPending?: boolean;
    trusted?: boolean;
    issuedDevice?: { token: string; expiresInSeconds: number } | null;
    redisThrowOn?: string;
  } = {},
) {
  const config = {
    ADMIN_MFA_REQUIRED: over.mfaRequired ?? true,
    ADMIN_TOTP_ISSUER: "BadaBhai Admin",
    OTP_RESEND_COOLDOWN_SECONDS: 30,
  } as unknown as ServerConfig;

  // `noAccount: true` means the email resolves to no row (unknown). Otherwise use the supplied
  // account, or a default active-but-unenrolled ops_admin.
  const account: Account | undefined = over.noAccount
    ? undefined
    : {
        mfaEnabled: true,
        mfaSecretEnc: "v1.seed-ciphertext",
        passwordSetAt: null,
        ...(over.account ?? { id: ADMIN_ID, role: "ops_admin", status: "active", mfaEnrolled: false }),
      };

  const admins = {
    emailHash: (email: string) => `hmac<${email}>`,
    findByEmailHash: vi.fn(async () => account as never),
    findById: vi.fn(async () => account as never),
    setMfaEnrolled: vi.fn(async () => account as never),
    touchLastLogin: vi.fn(async () => undefined),
  };
  const otp = {
    issueAndSend: vi.fn(async () => ({ resendInSeconds: 30 })),
    issueAndDispatch: vi.fn(async () => ({ resendInSeconds: 30 })),
    issueWithoutDelivery: vi.fn(async () => ({ resendInSeconds: 30 })),
    verify: vi.fn(async () => undefined),
  };
  const sessions = {
    create: vi.fn(async () => ({ token: "admin-jwt", expiresInSeconds: 2592000 })),
    mint: vi.fn(async () => ({ token: "fresh-admin-jwt", expiresInSeconds: 2592000 })),
    revoke: vi.fn(async () => undefined),
  };
  const mfaStore = {
    save: vi.fn(async () => undefined),
    load: vi.fn(async () => over.storedSecret ?? null),
    clear: vi.fn(async () => undefined),
    markOtpPassed: vi.fn(async () => undefined),
    // Default: the OTP-pending marker is present (the happy path: verifyLogin set it).
    // The "OTP not passed" case overrides this to resolve false.
    consumeOtpPending: vi.fn(async () => over.otpPending ?? true),
  };
  const events = {
    emit: vi.fn((_e: { event_name: string; payload: Record<string, unknown> }) => Promise.resolve()),
  };

  // Only `hashToken` is exercised from here (the accept path); the rest of the seam belongs
  // to the invite side. Identity-ish hashing keeps an accept assertion readable.
  const invites = { hashToken: vi.fn((raw: string) => `hash(${raw})`) };

  // 0144 — the trusted-device seam. `trusted` is what isTrusted answers; `issuedDevice` what
  // issue() returns (null = feature off / Redis refused).
  const devices = {
    isTrusted: vi.fn(async () => over.trusted ?? false),
    issue: vi.fn(async () =>
      over.issuedDevice === undefined
        ? { token: "device-token-raw-0123456789abcdef", expiresInSeconds: 2592000 }
        : over.issuedDevice,
    ),
  };

  // B1 — the REAL per-admin attempt counter over an in-memory Redis, so the TOTP cap is
  // exercised end to end rather than mocked.
  const redis = fakeRedis({ throwOn: over.redisThrowOn });
  const lockout = new AdminAttemptLockoutService(
    { ADMIN_PASSWORD_MAX_ATTEMPTS: 5, ADMIN_PASSWORD_LOCKOUT_SECONDS: 900 } as unknown as ServerConfig,
    { client: Promise.resolve(redis.client) } as unknown as Queue,
  );

  const svc = new AdminAuthService(
    config,
    admins as never,
    otp as never,
    sessions as never,
    mfaStore as never,
    events as never,
    invites as never,
    devices as never,
    lockout,
  );
  return { svc, admins, otp, sessions, mfaStore, events, devices, lockout, redis };
}

/** Email must NEVER appear in any emitted event (CLAUDE.md invariant #2). */
function assertNoPiiInEvents(events: { emit: ReturnType<typeof vi.fn> }) {
  const blob = JSON.stringify(events.emit.mock.calls);
  expect(blob).not.toContain(EMAIL);
  expect(blob).not.toContain("badabhai.in");
}

// ---------------------------------------------------------------------------
// MUST-FIX #1 — MFA enforced at session-mint for ALL roles + status-gating.
// ---------------------------------------------------------------------------
describe("AdminAuthService — MFA at session-mint (must-fix #1, ALL roles)", () => {
  it("a verified-OTP admin with mfa_enrolled=false gets NO session — only an enrollment step", async () => {
    const d = setup({
      account: { id: ADMIN_ID, role: "ops_admin", status: "active", mfaEnrolled: false },
    });
    const res = await d.svc.verifyLogin({ email: EMAIL, code: "123456" }, CTX);

    // NO session minted, NO session_started event — only a TOTP enrollment payload.
    expect(d.sessions.create).not.toHaveBeenCalled();
    expect(res).toMatchObject({ status: "mfa_required", needs_enrollment: true });
    expect((res as { enrollment?: unknown }).enrollment).toBeDefined();
    expect(d.events.emit).not.toHaveBeenCalled();
  });

  it("the enrollment branch applies even to `analyst` (MFA for ALL roles — owner OQ-1)", async () => {
    const d = setup({
      account: { id: ADMIN_ID, role: "analyst", status: "active", mfaEnrolled: false },
    });
    const res = await d.svc.verifyLogin({ email: EMAIL, code: "123456" }, CTX);
    expect(d.sessions.create).not.toHaveBeenCalled();
    expect(res).toMatchObject({ status: "mfa_required", needs_enrollment: true });
  });

  it("an enrolled admin gets mfa_required (NO session, NO enrollment material) until TOTP passes", async () => {
    const d = setup({
      account: { id: ADMIN_ID, role: "support", status: "active", mfaEnrolled: true },
    });
    const res = await d.svc.verifyLogin({ email: EMAIL, code: "123456" }, CTX);
    expect(d.sessions.create).not.toHaveBeenCalled();
    expect(res).toEqual({ status: "mfa_required", needs_enrollment: false });
    expect((res as { enrollment?: unknown }).enrollment).toBeUndefined();
  });

  it("a VALID TOTP step mints the session + emits a PII-free admin.session_started", async () => {
    const { secret } = generateTotpEnrollment("BadaBhai Admin", ADMIN_ID);
    const d = setup({
      account: { id: ADMIN_ID, role: "support", status: "active", mfaEnrolled: true },
      storedSecret: secret,
    });
    const code = currentTotpCode(secret);
    const res = await d.svc.verifyMfa({ email: EMAIL, code }, CTX);

    expect(d.sessions.create).toHaveBeenCalledWith(ADMIN_ID, "support", 0);
    expect(res).toMatchObject({ access_token: "admin-jwt", token_type: "Bearer", admin_id: ADMIN_ID, role: "support" });
    const started = d.events.emit.mock.calls.find((c) => c[0].event_name === "admin.session_started");
    expect(started![0].payload).toEqual({ admin_id: ADMIN_ID, role: "support" });
    assertNoPiiInEvents(d.events);
  });

  it("an INVALID TOTP step does NOT mint a session (same neutral 401)", async () => {
    const { secret } = generateTotpEnrollment("BadaBhai Admin", ADMIN_ID);
    const d = setup({
      account: { id: ADMIN_ID, role: "support", status: "active", mfaEnrolled: true },
      storedSecret: secret,
    });
    await expect(d.svc.verifyMfa({ email: EMAIL, code: "000000" }, CTX)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(d.sessions.create).not.toHaveBeenCalled();
  });

  it("a TOTP step with NO prior OTP success in this flow fails closed (single-flow binding)", async () => {
    const { secret } = generateTotpEnrollment("BadaBhai Admin", ADMIN_ID);
    const d = setup({
      account: { id: ADMIN_ID, role: "support", status: "active", mfaEnrolled: true },
      storedSecret: secret,
      otpPending: false, // verifyLogin did NOT mark OTP-passed (or it expired) → marker absent
    });
    const code = currentTotpCode(secret);
    await expect(d.svc.verifyMfa({ email: EMAIL, code }, CTX)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(d.sessions.create).not.toHaveBeenCalled();
    // The marker is consumed BEFORE the TOTP check, so a valid code does not even get verified.
    expect(d.mfaStore.consumeOtpPending).toHaveBeenCalledWith(ADMIN_ID, 0);
  });

  it("the MFA branch of verifyLogin sets the OTP-pending marker (binds OTP→MFA in one flow)", async () => {
    const d = setup({
      account: { id: ADMIN_ID, role: "support", status: "active", mfaEnrolled: true },
    });
    await d.svc.verifyLogin({ email: EMAIL, code: "123456" }, CTX);
    expect(d.mfaStore.markOtpPassed).toHaveBeenCalledWith(ADMIN_ID, 0);
  });

  it("a TOTP step with NO stored secret fails closed (same 401)", async () => {
    const d = setup({
      account: { id: ADMIN_ID, role: "support", status: "active", mfaEnrolled: true },
      storedSecret: null,
    });
    await expect(d.svc.verifyMfa({ email: EMAIL, code: "123456" }, CTX)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(d.sessions.create).not.toHaveBeenCalled();
  });

  it("MFA disabled (config off, non-default) mints directly after OTP — the gate is config-driven", async () => {
    const d = setup({
      account: { id: ADMIN_ID, role: "ops_admin", status: "active", mfaEnrolled: false },
      mfaRequired: false,
    });
    const res = await d.svc.verifyLogin({ email: EMAIL, code: "123456" }, CTX);
    expect(d.sessions.create).toHaveBeenCalledWith(ADMIN_ID, "ops_admin", 0);
    expect(res).toMatchObject({ access_token: "admin-jwt", admin_id: ADMIN_ID });
  });
});

// ---------------------------------------------------------------------------
// STATUS-GATING — pending/suspended authenticate to NOTHING (neutral).
// ---------------------------------------------------------------------------
describe("AdminAuthService — status gating (pending/suspended authenticate to nothing)", () => {
  for (const status of ["pending", "suspended"] as const) {
    it(`a ${status} admin who verifies OTP gets the SAME neutral 401 (no session, no oracle)`, async () => {
      const d = setup({
        account: { id: ADMIN_ID, role: "super_admin", status, mfaEnrolled: true },
      });
      await expect(d.svc.verifyLogin({ email: EMAIL, code: "123456" }, CTX)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(d.sessions.create).not.toHaveBeenCalled();
      expect(d.events.emit).not.toHaveBeenCalled();
    });
  }
});

// ---------------------------------------------------------------------------
// NO-ENUMERATION — known vs unknown vs inactive email are indistinguishable.
// ---------------------------------------------------------------------------
describe("AdminAuthService — no user-enumeration (XB-H)", () => {
  it("requestLogin for an ACTIVE account issues+dispatches; for an unknown one runs the no-delivery reserve", async () => {
    const active = setup({ account: { id: ADMIN_ID, role: "support", status: "active", mfaEnrolled: true } });
    const a = await active.svc.requestLogin({ email: EMAIL });
    // R73 — delivery is DISPATCHED off the request path; the awaited send is never used here,
    // so the provider's latency cannot tell an admin address from an unknown one.
    expect(active.otp.issueAndDispatch).toHaveBeenCalledTimes(1);
    expect(active.otp.issueAndDispatch).toHaveBeenCalledWith(expect.any(String), EMAIL, "login");
    expect(active.otp.issueAndSend).not.toHaveBeenCalled();
    expect(active.otp.issueWithoutDelivery).not.toHaveBeenCalled();

    const unknown = setup({ noAccount: true });
    const b = await unknown.svc.requestLogin({ email: "ghost@nowhere.com" });
    expect(unknown.otp.issueWithoutDelivery).toHaveBeenCalledTimes(1);
    expect(unknown.otp.issueAndDispatch).not.toHaveBeenCalled();
    expect(unknown.otp.issueAndSend).not.toHaveBeenCalled();

    // Byte-identical neutral response — no oracle.
    expect(a).toEqual(b);
    expect(a).toEqual({ status: "code_sent", resend_in_seconds: 30 });
    // No admin.* event emitted on either request branch.
    expect(active.events.emit).not.toHaveBeenCalled();
    expect(unknown.events.emit).not.toHaveBeenCalled();
  });

  it("requestLogin for a PENDING/SUSPENDED account runs the no-delivery reserve (treated like unknown)", async () => {
    const pending = setup({ account: { id: ADMIN_ID, role: "support", status: "pending", mfaEnrolled: true } });
    await pending.svc.requestLogin({ email: EMAIL });
    expect(pending.otp.issueWithoutDelivery).toHaveBeenCalledTimes(1);
    expect(pending.otp.issueAndDispatch).not.toHaveBeenCalled();
    expect(pending.otp.issueAndSend).not.toHaveBeenCalled();
  });

  it("verifyLogin for an UNKNOWN account returns the SAME 401 as a wrong code (no oracle)", async () => {
    const d = setup({ noAccount: true });
    await expect(d.svc.verifyLogin({ email: "ghost@nowhere.com", code: "999999" }, CTX)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(d.sessions.create).not.toHaveBeenCalled();
    expect(d.events.emit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PII-FREE EVENTS — session_started/session_revoked validate + carry only ids/enums.
// ---------------------------------------------------------------------------
describe("AdminAuthService — PII-free, registry-valid admin events", () => {
  it("logout revokes the session and emits a registry-valid PII-free admin.session_revoked", async () => {
    const d = setup();
    await d.svc.logout(ADMIN_ID, "sid-1", CTX);
    expect(d.sessions.revoke).toHaveBeenCalledWith("sid-1");
    const revoked = d.events.emit.mock.calls.find((c) => c[0].event_name === "admin.session_revoked");
    expect(revoked![0].payload).toEqual({ admin_id: ADMIN_ID });
    assertNoPiiInEvents(d.events);

    // The emitted payload validates against the shipped registry schema.
    const built = validateEvent({
      event_id: "11111111-1111-4111-8111-111111111111",
      event_name: "admin.session_revoked",
      event_version: 1,
      occurred_at: "2026-06-27T00:00:00.000Z",
      actor: { actor_type: "admin", actor_id: ADMIN_ID },
      subject: { subject_type: "admin_session", subject_id: ADMIN_ID },
      source: "api",
      correlation_id: "22222222-2222-4222-8222-222222222222",
      causation_id: null,
      payload: revoked![0].payload,
      metadata: { environment: "test", service: "api" },
    });
    expect(built.success).toBe(true);
  });

  it("refresh mints a fresh token for the validated admin+session (role preserved)", async () => {
    const d = setup();
    const res = await d.svc.refresh(ADMIN_ID, "sid-1", "ops_admin", 1_793_700_000_500);
    // B2 — re-minted on the epoch the GUARD validated, passed through verbatim.
    expect(d.sessions.mint).toHaveBeenCalledWith(ADMIN_ID, "sid-1", "ops_admin", 1_793_700_000_500);
    expect(res).toMatchObject({ access_token: "fresh-admin-jwt", token_type: "Bearer" });
  });
});

// ---------------------------------------------------------------------------
// Migration 0144 / owner AMENDMENT 1 — two-step is a per-admin switch, default OFF.
// ---------------------------------------------------------------------------
describe("AdminAuthService — the per-admin two-step switch (Amendment 1)", () => {
  it("two-step OFF: the emailed code alone mints a session (no TOTP, no enrolment, no marker)", async () => {
    const d = setup({
      account: { id: ADMIN_ID, role: "ops_admin", status: "active", mfaEnrolled: false, mfaEnabled: false },
    });
    const res = await d.svc.verifyLogin({ email: EMAIL, code: "123456" }, CTX);

    expect(res).toMatchObject({ access_token: "admin-jwt", token_type: "Bearer", admin_id: ADMIN_ID });
    expect(d.sessions.create).toHaveBeenCalledWith(ADMIN_ID, "ops_admin", 0);
    // No second-factor machinery runs for an admin who has it off.
    expect(d.mfaStore.markOtpPassed).not.toHaveBeenCalled();
    expect(d.mfaStore.save).not.toHaveBeenCalled();
    const started = d.events.emit.mock.calls.find((c) => c[0].event_name === "admin.session_started");
    expect(started).toBeDefined();
    assertNoPiiInEvents(d.events);
  });

  it("an account still on its TEMPORARY password cannot skip the forced change via the emailed code", async () => {
    const d = setup({
      account: {
        id: ADMIN_ID,
        role: "ops_admin",
        status: "active",
        mfaEnrolled: false,
        mfaEnabled: false,
        mustChangePassword: true,
      },
    });
    await expect(d.svc.verifyLogin({ email: EMAIL, code: "123456" }, CTX)).rejects.toThrow(
      MUST_CHANGE_VIA_PASSWORD,
    );
    expect(d.sessions.create).not.toHaveBeenCalled();
    expect(d.mfaStore.markOtpPassed).not.toHaveBeenCalled();
  });

  it("two-step OFF even when ENROLLED (the owner's own row after 0144): no TOTP asked", async () => {
    const d = setup({
      account: { id: ADMIN_ID, role: "super_admin", status: "active", mfaEnrolled: true, mfaEnabled: false },
    });
    const res = await d.svc.verifyLogin({ email: EMAIL, code: "123456" }, CTX);
    expect(res).toMatchObject({ access_token: "admin-jwt", role: "super_admin" });
  });

  it("two-step OFF ignores a presented device token (nothing to skip, no Redis read)", async () => {
    const d = setup({
      account: { id: ADMIN_ID, role: "support", status: "active", mfaEnrolled: true, mfaEnabled: false },
    });
    await d.svc.verifyLogin({ email: EMAIL, code: "123456", device_token: "x".repeat(43) }, CTX);
    expect(d.devices.isTrusted).not.toHaveBeenCalled();
    expect(d.sessions.create).toHaveBeenCalledTimes(1);
  });

  it("two-step ON + enrolled: the emailed code alone gets mfa_required, never a session", async () => {
    const d = setup({
      account: { id: ADMIN_ID, role: "support", status: "active", mfaEnrolled: true, mfaEnabled: true },
    });
    const res = await d.svc.verifyLogin({ email: EMAIL, code: "123456" }, CTX);
    expect(res).toEqual({ status: "mfa_required", needs_enrollment: false });
    expect(d.sessions.create).not.toHaveBeenCalled();
  });

  it("two-step ON but NOT enrolled (a super_admin reset): the gate hands back an enrolment QR", async () => {
    const d = setup({
      account: { id: ADMIN_ID, role: "support", status: "active", mfaEnrolled: false, mfaEnabled: true },
    });
    const res = await d.svc.verifyLogin({ email: EMAIL, code: "123456" }, CTX);
    expect(res).toMatchObject({ status: "mfa_required", needs_enrollment: true });
    expect(d.sessions.create).not.toHaveBeenCalled();
  });

  it("ADMIN_MFA_REQUIRED=false is OFF for everyone — even an admin whose switch is ON", async () => {
    const d = setup({
      account: { id: ADMIN_ID, role: "support", status: "active", mfaEnrolled: true, mfaEnabled: true },
      mfaRequired: false,
    });
    const res = await d.svc.verifyLogin({ email: EMAIL, code: "123456" }, CTX);
    expect(res).toMatchObject({ access_token: "admin-jwt" });
  });
});

describe("AdminAuthService — trusted device at the MFA gate (0144)", () => {
  const ENROLLED_ON = {
    id: ADMIN_ID,
    role: "support" as const,
    status: "active" as const,
    mfaEnrolled: true,
    mfaEnabled: true,
  };
  const DEVICE = "d".repeat(43);

  it("a TRUSTED device skips the TOTP step — session minted from the first factor", async () => {
    const d = setup({ account: ENROLLED_ON, trusted: true });
    const res = await d.svc.verifyLogin({ email: EMAIL, code: "123456", device_token: DEVICE }, CTX);
    expect(res).toMatchObject({ access_token: "admin-jwt", admin_id: ADMIN_ID });
    // Checked against THIS admin's row — the device service decides on the live credentials.
    expect(d.devices.isTrusted).toHaveBeenCalledWith(DEVICE, expect.objectContaining({ id: ADMIN_ID }));
    expect(d.mfaStore.markOtpPassed).not.toHaveBeenCalled();
  });

  it("an UNTRUSTED device token falls through to the TOTP step (no session)", async () => {
    const d = setup({ account: ENROLLED_ON, trusted: false });
    const res = await d.svc.verifyLogin({ email: EMAIL, code: "123456", device_token: DEVICE }, CTX);
    expect(res).toEqual({ status: "mfa_required", needs_enrollment: false });
    expect(d.sessions.create).not.toHaveBeenCalled();
    expect(d.mfaStore.markOtpPassed).toHaveBeenCalledWith(ADMIN_ID, 0);
  });

  it("no device token → the device store is never consulted", async () => {
    const d = setup({ account: ENROLLED_ON, trusted: true });
    await d.svc.verifyLogin({ email: EMAIL, code: "123456" }, CTX);
    expect(d.devices.isTrusted).not.toHaveBeenCalled();
    expect(d.sessions.create).not.toHaveBeenCalled();
  });

  it("mfa/verify with trust_device=true returns a device token + emits a value-free admin_device_trusted", async () => {
    const { secret } = generateTotpEnrollment("BadaBhai Admin", ADMIN_ID);
    const d = setup({ account: ENROLLED_ON, storedSecret: secret });
    const res = await d.svc.verifyMfa(
      { email: EMAIL, code: currentTotpCode(secret), trust_device: true },
      CTX,
    );

    expect(res).toMatchObject({
      access_token: "admin-jwt",
      device_token: "device-token-raw-0123456789abcdef",
      device_expires_in_seconds: 2592000,
    });
    expect(d.devices.issue).toHaveBeenCalledWith(expect.objectContaining({ id: ADMIN_ID }));
    const trusted = d.events.emit.mock.calls.find(
      (c) => (c[0].payload as { action_code?: string }).action_code === "admin_device_trusted",
    );
    expect(trusted![0].payload).toEqual({
      admin_id: ADMIN_ID,
      action_code: "admin_device_trusted",
      target_type: "admin_session",
      target_id: ADMIN_ID,
    });
    // The raw device token NEVER rides an event.
    expect(JSON.stringify(d.events.emit.mock.calls)).not.toContain("device-token-raw");
    assertNoPiiInEvents(d.events);
    // And the payload validates against the shipped registry schema.
    const built = validateEvent({
      event_id: "11111111-1111-4111-8111-111111111111",
      event_name: "admin.action_performed",
      event_version: 1,
      occurred_at: "2026-11-03T00:00:00.000Z",
      actor: { actor_type: "admin", actor_id: ADMIN_ID },
      subject: { subject_type: "admin_session", subject_id: ADMIN_ID },
      source: "api",
      correlation_id: "22222222-2222-4222-8222-222222222222",
      causation_id: null,
      payload: trusted![0].payload,
      metadata: { environment: "test", service: "api" },
    });
    expect(built.success).toBe(true);
  });

  it("mfa/verify WITHOUT trust_device issues nothing and the body has no device fields", async () => {
    const { secret } = generateTotpEnrollment("BadaBhai Admin", ADMIN_ID);
    const d = setup({ account: ENROLLED_ON, storedSecret: secret });
    const res = await d.svc.verifyMfa({ email: EMAIL, code: currentTotpCode(secret) }, CTX);
    expect(d.devices.issue).not.toHaveBeenCalled();
    expect(res).not.toHaveProperty("device_token");
    expect(res).not.toHaveProperty("device_expires_in_seconds");
  });

  it("trust_device=true while the feature is OFF (issue → null): no device fields, no event", async () => {
    const { secret } = generateTotpEnrollment("BadaBhai Admin", ADMIN_ID);
    const d = setup({ account: ENROLLED_ON, storedSecret: secret, issuedDevice: null });
    const res = await d.svc.verifyMfa(
      { email: EMAIL, code: currentTotpCode(secret), trust_device: true },
      CTX,
    );
    expect(res).not.toHaveProperty("device_token");
    const codes = d.events.emit.mock.calls.map(
      (c) => (c[0].payload as { action_code?: string }).action_code,
    );
    expect(codes).not.toContain("admin_device_trusted");
  });
});

describe("AdminAuthService.accountFlags — the GET /admin/me additions (0144)", () => {
  it("maps the live row to three booleans — never the hash, the seed or a timestamp", async () => {
    const d = setup();
    d.admins.findById.mockResolvedValueOnce({
      id: ADMIN_ID,
      passwordHash: "password-v1.salt.hash",
      mustChangePassword: true,
      mfaEnabled: false,
      mfaSecretEnc: "v1.seed",
    } as never);
    const flags = await d.svc.accountFlags(ADMIN_ID);
    expect(flags).toEqual({ has_password: true, must_change_password: true, mfa_enabled: false });
  });

  it("an admin with no password reads has_password=false", async () => {
    const d = setup();
    d.admins.findById.mockResolvedValueOnce({
      id: ADMIN_ID,
      passwordHash: null,
      mustChangePassword: false,
      mfaEnabled: true,
    } as never);
    expect(await d.svc.accountFlags(ADMIN_ID)).toEqual({
      has_password: false,
      must_change_password: false,
      mfa_enabled: true,
    });
  });

  it("a vanished row is the neutral session 401", async () => {
    const d = setup();
    d.admins.findById.mockResolvedValueOnce(undefined as never);
    await expect(d.svc.accountFlags(ADMIN_ID)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

// ---------------------------------------------------------------------------
// Security review B1 — the per-admin TOTP attempt cap on POST /admin/mfa/verify.
// ---------------------------------------------------------------------------
describe("AdminAuthService.verifyMfa — per-admin TOTP attempt cap (B1)", () => {
  const ENROLLED_ON = {
    id: ADMIN_ID,
    role: "support" as const,
    status: "active" as const,
    mfaEnrolled: true,
    mfaEnabled: true,
  };
  const KEY = `admin_mfa_login:attempts:${ADMIN_ID}`;
  const wrong = (secret: string) => (currentTotpCode(secret) === "000000" ? "111111" : "000000");

  it("a wrong TOTP is COUNTED in the mfa_login scope", async () => {
    const { secret } = generateTotpEnrollment("BadaBhai Admin", ADMIN_ID);
    const d = setup({ account: ENROLLED_ON, storedSecret: secret });
    await expect(d.svc.verifyMfa({ email: EMAIL, code: wrong(secret) }, CTX)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(d.redis.store.get(KEY)).toBe("1");
  });

  it("a MISSING secret is counted too (from outside it is a guess that did not land)", async () => {
    const d = setup({ account: ENROLLED_ON, storedSecret: null });
    await expect(d.svc.verifyMfa({ email: EMAIL, code: "123456" }, CTX)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(d.redis.store.get(KEY)).toBe("1");
  });

  it("LOCKED: even the correct TOTP is the same neutral 401, and the marker is NOT consumed", async () => {
    const { secret } = generateTotpEnrollment("BadaBhai Admin", ADMIN_ID);
    const d = setup({ account: ENROLLED_ON, storedSecret: secret });
    d.redis.store.set(KEY, "5");
    const err = await d.svc
      .verifyMfa({ email: EMAIL, code: currentTotpCode(secret) }, CTX)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as Error).message).toBe("Incorrect or expired code");
    expect(d.mfaStore.consumeOtpPending).not.toHaveBeenCalled();
    expect(d.sessions.create).not.toHaveBeenCalled();
  });

  it("a correct TOTP clears the counter", async () => {
    const { secret } = generateTotpEnrollment("BadaBhai Admin", ADMIN_ID);
    const d = setup({ account: ENROLLED_ON, storedSecret: secret });
    d.redis.store.set(KEY, "3");
    await d.svc.verifyMfa({ email: EMAIL, code: currentTotpCode(secret) }, CTX);
    expect(d.redis.store.has(KEY)).toBe(false);
  });

  it("FAILS CLOSED: an unreadable counter is a 503 — and no marker is burned, no session minted", async () => {
    const { secret } = generateTotpEnrollment("BadaBhai Admin", ADMIN_ID);
    const d = setup({ account: ENROLLED_ON, storedSecret: secret, redisThrowOn: "get" });
    await expect(
      d.svc.verifyMfa({ email: EMAIL, code: currentTotpCode(secret) }, CTX),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(d.mfaStore.consumeOtpPending).not.toHaveBeenCalled();
    expect(d.sessions.create).not.toHaveBeenCalled();
  });

  it("a FIRST factor (emailed code) never touches the TOTP counter", async () => {
    const d = setup({ account: ENROLLED_ON });
    d.redis.store.set(KEY, "4");
    await d.svc.verifyLogin({ email: EMAIL, code: "123456" }, CTX);
    expect(d.redis.store.get(KEY)).toBe("4");
  });

  it("the session minted after a TOTP carries the row's credential epoch (B2)", async () => {
    const { secret } = generateTotpEnrollment("BadaBhai Admin", ADMIN_ID);
    const setAt = new Date("2026-11-03T10:00:00.250Z");
    const d = setup({ account: { ...ENROLLED_ON, passwordSetAt: setAt }, storedSecret: secret });
    await d.svc.verifyMfa({ email: EMAIL, code: currentTotpCode(secret) }, CTX);
    expect(d.sessions.create).toHaveBeenCalledWith(ADMIN_ID, "support", setAt.getTime());
  });
});
