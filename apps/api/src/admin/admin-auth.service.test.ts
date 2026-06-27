import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { UnauthorizedException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { AdminRole, AdminStatus } from "@badabhai/db";
import { validateEvent } from "@badabhai/event-schema";
import type { RequestContext } from "../common/request-context";
import { AdminAuthService } from "./admin-auth.service";
import { currentTotpCode, generateTotpEnrollment } from "./admin-mfa";

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
};

function setup(
  over: {
    account?: Account;
    noAccount?: boolean;
    mfaRequired?: boolean;
    storedSecret?: string | null;
    otpPending?: boolean;
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
    : (over.account ?? { id: ADMIN_ID, role: "ops_admin", status: "active", mfaEnrolled: false });

  const admins = {
    emailHash: (email: string) => `hmac<${email}>`,
    findByEmailHash: vi.fn(async () => account as never),
    setMfaEnrolled: vi.fn(async () => account as never),
    touchLastLogin: vi.fn(async () => undefined),
  };
  const otp = {
    issueAndSend: vi.fn(async () => ({ resendInSeconds: 30 })),
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

  const svc = new AdminAuthService(
    config,
    admins as never,
    otp as never,
    sessions as never,
    mfaStore as never,
    events as never,
  );
  return { svc, admins, otp, sessions, mfaStore, events };
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

    expect(d.sessions.create).toHaveBeenCalledWith(ADMIN_ID, "support");
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
    expect(d.mfaStore.consumeOtpPending).toHaveBeenCalledWith(ADMIN_ID);
  });

  it("the MFA branch of verifyLogin sets the OTP-pending marker (binds OTP→MFA in one flow)", async () => {
    const d = setup({
      account: { id: ADMIN_ID, role: "support", status: "active", mfaEnrolled: true },
    });
    await d.svc.verifyLogin({ email: EMAIL, code: "123456" }, CTX);
    expect(d.mfaStore.markOtpPassed).toHaveBeenCalledWith(ADMIN_ID);
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
    expect(d.sessions.create).toHaveBeenCalledWith(ADMIN_ID, "ops_admin");
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
  it("requestLogin for an ACTIVE account issues+delivers; for an unknown one runs the no-delivery reserve", async () => {
    const active = setup({ account: { id: ADMIN_ID, role: "support", status: "active", mfaEnrolled: true } });
    const a = await active.svc.requestLogin({ email: EMAIL });
    expect(active.otp.issueAndSend).toHaveBeenCalledTimes(1);
    expect(active.otp.issueWithoutDelivery).not.toHaveBeenCalled();

    const unknown = setup({ noAccount: true });
    const b = await unknown.svc.requestLogin({ email: "ghost@nowhere.com" });
    expect(unknown.otp.issueWithoutDelivery).toHaveBeenCalledTimes(1);
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
    const res = await d.svc.refresh(ADMIN_ID, "sid-1", "ops_admin");
    expect(d.sessions.mint).toHaveBeenCalledWith(ADMIN_ID, "sid-1", "ops_admin");
    expect(res).toMatchObject({ access_token: "fresh-admin-jwt", token_type: "Bearer" });
  });
});
