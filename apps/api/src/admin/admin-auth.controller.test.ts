import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { HttpException, HttpStatus, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import type { ServerConfig } from "@badabhai/config";
import type { AdminRole } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import { AdminAuthGuard, type AuthenticatedAdminSession } from "./admin-auth.guard";
import { AdminAuthController } from "./admin-auth.controller";

/**
 * Unit tests for the thin admin-auth HTTP surface (ADR-0025 ADMIN-1). The controller owns
 * only TWO behaviours of its own; everything else is delegation to {@link AdminAuthService}:
 *   1. The per-IP cap (XB-H) runs BEFORE the service on the three PUBLIC routes.
 *   2. The privileged routes (refresh/logout/me) take their identity from the GUARD-attached
 *      admin ({@link AuthenticatedAdmin}) — never from the body.
 *
 * Every assertion pins a BadaBhai invariant where relevant:
 *   - INVARIANT #2 (no raw PII): no admin email / OTP code / TOTP secret may appear in any
 *     response body the controller produces or returns. The login identifier (email) is
 *     accepted but never echoed back.
 *   - FAIL CLOSED: a tripped / Redis-down per-IP cap must DENY (the cap throws) and the
 *     service must NOT be reached — an outage can never uncap or auto-allow the public routes.
 *   - NO-ENUMERATION ORACLE: the controller returns the service's neutral shape verbatim and
 *     maps the service's neutral 401 through unchanged (no known/unknown distinction is added).
 *   - SESSION TOKEN CHANNEL: the rolling/fresh token rides the service's structured response
 *     (`access_token`) or the guard's `x-session-token` header — never a raw token baked into a
 *     controller-built JSON body. `GET /admin/me` carries id + role ONLY.
 */

const CORRELATION_ID = "11111111-1111-4111-8111-111111111111";
const CTX: RequestContext = { correlationId: CORRELATION_ID, requestId: "req-1" };

const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const SID = "sid-a";
const ROLE: AdminRole = "ops_admin";
// B2 — what the guard attaches: the identity PLUS the credential epoch it validated against.
const EPOCH = 1_793_700_000_500;
const ADMIN: AuthenticatedAdminSession = { id: ADMIN_ID, role: ROLE, sid: SID, passwordEpoch: EPOCH };

// The login identifier (ADMIN-class PII) + the secret material that must NEVER round-trip.
const EMAIL = "ops.admin@badabhai.in";
const OTP_CODE = "123456";
const MFA_SECRET = "JBSWY3DPEHPK3PXP";

const CLIENT_IP = "203.0.113.7";
const req = { ip: CLIENT_IP } as unknown as Request;
const IP_CAP = 20;

function makeCtrl() {
  // The minted-session shape the service returns AFTER both OTP + MFA pass. NO email/code/secret.
  const sessionResponse = {
    access_token: "admin-jwt",
    token_type: "Bearer" as const,
    expires_in_seconds: 2592000,
    admin_id: ADMIN_ID,
    role: ROLE,
  };
  const auth = {
    requestLogin: vi.fn(async () => ({ status: "code_sent", resend_in_seconds: 30 })),
    verifyLogin: vi.fn(async () => ({ status: "mfa_required", needs_enrollment: false })),
    verifyMfa: vi.fn(async () => sessionResponse),
    refresh: vi.fn(async () => ({ access_token: "fresh-admin-jwt", token_type: "Bearer" as const, expires_in_seconds: 2592000 })),
    logout: vi.fn(async () => undefined),
    // 0144 — the three account booleans GET /admin/me adds, read from the live row.
    accountFlags: vi.fn(async () => ({ has_password: true, must_change_password: false, mfa_enabled: false })),
  };
  // 0144 — the password + two-step-switch seams.
  const passwords = {
    loginWithPassword: vi.fn(async () => ({ status: "mfa_required", needs_enrollment: false })),
    requestReset: vi.fn(async () => ({ status: "code_sent", resend_in_seconds: 30 })),
    resetPassword: vi.fn(async () => ({ status: "password_reset", next: "sign_in" })),
    changeOwnPassword: vi.fn(async () => sessionResponse),
  };
  const mfaSelf = {
    enable: vi.fn(async () => ({ enrollment: { secret: MFA_SECRET, otpauth_uri: "otpauth://totp/x" } })),
    confirm: vi.fn(async () => ({ mfa_enabled: true })),
    disable: vi.fn(async () => ({ mfa_enabled: false })),
  };
  const ipRateLimit = { assertWithinHourlyIpCap: vi.fn(async () => undefined) };
  const config = { ADMIN_AUTH_MAX_PER_IP_PER_HOUR: IP_CAP } as unknown as ServerConfig;
  const ctrl = new AdminAuthController(
    auth as never,
    ipRateLimit as never,
    config,
    passwords as never,
    mfaSelf as never,
  );
  return { ctrl, auth, ipRateLimit, sessionResponse, passwords, mfaSelf };
}

/** No raw admin PII / secret material may appear anywhere in `value` (recursively JSON-scanned). */
function assertPiiFree(value: unknown): void {
  const blob = JSON.stringify(value ?? null);
  expect(blob).not.toContain(EMAIL);
  expect(blob).not.toContain("badabhai.in");
  expect(blob).not.toContain(OTP_CODE);
  expect(blob).not.toContain(MFA_SECRET);
}

// ---------------------------------------------------------------------------
// XB-H per-IP cap — runs BEFORE the service on EVERY public route (fail-closed).
// ---------------------------------------------------------------------------
describe("AdminAuthController — per-IP cap on the public auth routes (XB-H)", () => {
  let d: ReturnType<typeof makeCtrl>;
  beforeEach(() => {
    d = makeCtrl();
  });

  it("requestLogin / verifyLogin / verifyMfa each enforce the per-IP cap with the admin scope", async () => {
    await d.ctrl.requestLogin({ email: EMAIL }, req);
    await d.ctrl.verifyLogin({ email: EMAIL, code: OTP_CODE }, req, CTX);
    await d.ctrl.verifyMfa({ email: EMAIL, code: OTP_CODE }, req, CTX);

    expect(d.ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledTimes(3);
    // The admin auth routes use their OWN scope + the admin per-IP cap from config.
    expect(d.ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledWith("admin_auth", CLIENT_IP, IP_CAP);
  });

  it("falls back to 'unknown' when req.ip is absent (the cap still applies — never skipped)", async () => {
    await d.ctrl.requestLogin({ email: EMAIL }, { ip: undefined } as unknown as Request);
    expect(d.ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledWith("admin_auth", "unknown", IP_CAP);
  });

  it("a tripped IP cap (429) blocks requestLogin BEFORE the service — no OTP is reserved", async () => {
    d.ipRateLimit.assertWithinHourlyIpCap.mockRejectedValueOnce(
      new HttpException("Too many requests from this network; please try again later", HttpStatus.TOO_MANY_REQUESTS),
    );
    await expect(d.ctrl.requestLogin({ email: EMAIL }, req)).rejects.toBeInstanceOf(HttpException);
    expect(d.auth.requestLogin).not.toHaveBeenCalled();
  });

  it("a Redis-down cap (fail-closed 429) blocks verifyLogin BEFORE the service — never auto-allow", async () => {
    // IpRateLimit fails CLOSED (throws 429) when Redis is unreachable; the controller must
    // propagate that and NOT reach the verify path (no session, no oracle from an outage).
    d.ipRateLimit.assertWithinHourlyIpCap.mockRejectedValueOnce(
      new HttpException("This is temporarily unavailable; please retry shortly", HttpStatus.TOO_MANY_REQUESTS),
    );
    await expect(d.ctrl.verifyLogin({ email: EMAIL, code: OTP_CODE }, req, CTX)).rejects.toBeInstanceOf(HttpException);
    expect(d.auth.verifyLogin).not.toHaveBeenCalled();
  });

  it("a tripped IP cap blocks verifyMfa BEFORE the service — a leaked TOTP can't bypass the cap", async () => {
    d.ipRateLimit.assertWithinHourlyIpCap.mockRejectedValueOnce(
      new HttpException("Too many requests from this network; please try again later", HttpStatus.TOO_MANY_REQUESTS),
    );
    await expect(d.ctrl.verifyMfa({ email: EMAIL, code: OTP_CODE }, req, CTX)).rejects.toBeInstanceOf(HttpException);
    expect(d.auth.verifyMfa).not.toHaveBeenCalled();
  });

  it("the cap is asserted BEFORE the delegate (ordering proof via call sequence)", async () => {
    const order: string[] = [];
    d.ipRateLimit.assertWithinHourlyIpCap.mockImplementationOnce(async () => {
      order.push("cap");
    });
    d.auth.requestLogin.mockImplementationOnce(async () => {
      order.push("service");
      return { status: "code_sent", resend_in_seconds: 30 };
    });
    await d.ctrl.requestLogin({ email: EMAIL }, req);
    expect(order).toEqual(["cap", "service"]);
  });
});

// ---------------------------------------------------------------------------
// DELEGATION + DTO threading — the controller passes the body/ctx straight through.
// ---------------------------------------------------------------------------
describe("AdminAuthController — delegation to AdminAuthService", () => {
  let d: ReturnType<typeof makeCtrl>;
  beforeEach(() => {
    d = makeCtrl();
  });

  it("requestLogin forwards the validated DTO to the service and returns its neutral shape", async () => {
    const res = await d.ctrl.requestLogin({ email: EMAIL }, req);
    expect(d.auth.requestLogin).toHaveBeenCalledWith({ email: EMAIL });
    expect(res).toEqual({ status: "code_sent", resend_in_seconds: 30 });
  });

  it("verifyLogin forwards the DTO + request context (threaded for tracing into events)", async () => {
    await d.ctrl.verifyLogin({ email: EMAIL, code: OTP_CODE }, req, CTX);
    expect(d.auth.verifyLogin).toHaveBeenCalledWith({ email: EMAIL, code: OTP_CODE }, CTX);
  });

  it("verifyMfa forwards the DTO + context and returns the minted session unchanged", async () => {
    const res = await d.ctrl.verifyMfa({ email: EMAIL, code: OTP_CODE }, req, CTX);
    expect(d.auth.verifyMfa).toHaveBeenCalledWith({ email: EMAIL, code: OTP_CODE }, CTX);
    expect(res).toBe(d.sessionResponse);
  });

  it("refresh takes identity from the GUARD admin (id, sid, role) — never from a body", async () => {
    const res = await d.ctrl.refresh(ADMIN);
    // B2 — the VALIDATED epoch is passed through verbatim (never re-read).
    expect(d.auth.refresh).toHaveBeenCalledWith(ADMIN_ID, SID, ROLE, EPOCH);
    expect(res).toMatchObject({ access_token: "fresh-admin-jwt", token_type: "Bearer" });
  });

  it("logout revokes the GUARD admin's own session (id, sid) + threads context for the event", async () => {
    await d.ctrl.logout(ADMIN, CTX);
    expect(d.auth.logout).toHaveBeenCalledWith(ADMIN_ID, SID, CTX);
  });

  it("logout resolves void (204) and never returns a body", async () => {
    await expect(d.ctrl.logout(ADMIN, CTX)).resolves.toBeUndefined();
  });

  it("me is built from the GUARD admin + the live account flags (keyed on the session id only)", async () => {
    const res = await d.ctrl.me(ADMIN);
    // The only service read is the three 0144 booleans, keyed on the GUARD admin's id.
    expect(d.auth.accountFlags).toHaveBeenCalledWith(ADMIN_ID);
    // LITERAL, not `capabilitiesFor(ROLE)` — comparing the endpoint to the function it calls
    // would pass no matter what either one did. ops_admin's exact grant per ADR-0025 §3.1:
    expect(res).toEqual({
      admin_id: ADMIN_ID,
      role: ROLE,
      has_password: true,
      must_change_password: false,
      mfa_enabled: false,
      capabilities: [
        "read_events",
        // BP-1 — the faceless entity reads (ADR-0025 §3.1 row 2, all four roles).
        "read_entities",
        // Owner ruling 2026-08-18 — the NAMES behind those ids. super_admin/ops_admin/support;
        // `analyst` denied. This list is what the portal reads to decide whether an absent
        // `full_name` means "not entitled" or "over budget", so a missing entry here would
        // silently make every capped page look like a permissions problem.
        "read_identity",
        "export",
        "suspend_payer",
        "grant_credits",
        "force_close_posting",
        "flag_worker",
        // Migration 0093 — RECORD a review decision on one skill candidate. On the governed-write
        // allow-set, so `ops_admin` holds it: taxonomy authorship is queue work whose corpus
        // consequence is gated by a second human offline, not a PII or break-glass act. Listed
        // LAST because this literal is order-sensitive against `ADMIN_CAPABILITIES`, and the new
        // row was appended at the tail of the write block precisely so no existing entry moves.
        "review_skill_candidates",
        // #2563 — payer credential administration (super_admin, ops_admin, support).
        "manage_payer_credentials",
        // ADR-0062 §3.8 (#2560) — the Candidates full-detail read, all four roles. Appended at the
        // TAIL of the vocabulary, so it closes the list and moves no existing entry.
        "read_candidates",
        // #2562 — worker account control (super_admin, ops_admin, support). Tail-appended too.
        "manage_worker_account",
        // #2566 — admin posting control (super_admin, ops_admin). Tail-appended.
        "manage_postings",
        // #2564 — company records (super_admin, ops_admin). Tail-appended.
        "manage_companies",
        // #2561 — candidate-field corrections (super_admin, ops_admin, support). Tail-appended.
        "edit_candidates",
      ],
    });
  });

  it("me OMITS the three capabilities ops_admin is denied — an over-grant here misleads the UI", async () => {
    const res = await d.ctrl.me(ADMIN);
    // The portal hides controls based on this list. Shipping a capability the server will
    // then 403 is a broken screen; shipping `reveal_pii` invites a PII control that no
    // ops_admin may actually use.
    expect(res.capabilities).not.toContain("toggle_kill_switch");
    expect(res.capabilities).not.toContain("reveal_pii");
    expect(res.capabilities).not.toContain("manage_admins");
  });

  it("me reflects the SESSION's role, not a fixed list — a support admin gets a different set", async () => {
    const res = await d.ctrl.me({ ...ADMIN, role: "support" });
    // support is the mirror image of ops_admin on the two that matter: it MAY reveal PII and
    // may NOT export (ADR-0025 §3.1 — the PII-reveal role must not also bulk-export).
    expect(res.capabilities).toContain("reveal_pii");
    expect(res.capabilities).not.toContain("export");
    expect(res.capabilities).not.toContain("suspend_payer");
  });
});

// ---------------------------------------------------------------------------
// NO RAW PII (invariant #2) — nothing the controller returns echoes email/code/secret.
// ---------------------------------------------------------------------------
describe("AdminAuthController — PII-free response bodies (invariant #2)", () => {
  let d: ReturnType<typeof makeCtrl>;
  beforeEach(() => {
    d = makeCtrl();
  });

  it("requestLogin's body carries ONLY status + resend_in_seconds (no email)", async () => {
    const res = await d.ctrl.requestLogin({ email: EMAIL }, req);
    assertPiiFree(res);
    expect(Object.keys(res).sort()).toEqual(["resend_in_seconds", "status"]);
  });

  it("verifyLogin's mfa_required body carries no session token, no code, no secret", async () => {
    const res = await d.ctrl.verifyLogin({ email: EMAIL, code: OTP_CODE }, req, CTX);
    assertPiiFree(res);
    // The MFA-pending shape never carries an access_token (must-fix #1 — no session yet).
    expect(res).not.toHaveProperty("access_token");
  });

  it("verifyLogin's enrollment branch never echoes the email/code (secret is shown once by design)", async () => {
    // When enrollment material IS present, it is the otpauth secret (intended one-time), but the
    // login PII (email + OTP code) must still not appear.
    d.auth.verifyLogin.mockResolvedValueOnce({
      status: "mfa_required",
      needs_enrollment: true,
      enrollment: { secret: MFA_SECRET, otpauth_uri: `otpauth://totp/BadaBhai:${ADMIN_ID}?secret=${MFA_SECRET}` },
    } as never);
    const res = await d.ctrl.verifyLogin({ email: EMAIL, code: OTP_CODE }, req, CTX);
    const blob = JSON.stringify(res);
    expect(blob).not.toContain(EMAIL);
    expect(blob).not.toContain("badabhai.in");
    expect(blob).not.toContain(OTP_CODE);
    // The otpauth label binds to the OPAQUE admin id, never the email (PII out of the QR).
    expect(blob).toContain(ADMIN_ID);
  });

  it("verifyMfa's minted-session body carries id/role/token only — never email/code/secret", async () => {
    const res = await d.ctrl.verifyMfa({ email: EMAIL, code: OTP_CODE }, req, CTX);
    assertPiiFree(res);
    expect(Object.keys(res).sort()).toEqual(
      ["access_token", "admin_id", "expires_in_seconds", "role", "token_type"].sort(),
    );
  });

  it("refresh's body is token material only — never PII", async () => {
    const res = await d.ctrl.refresh(ADMIN);
    assertPiiFree(res);
    expect(Object.keys(res).sort()).toEqual(["access_token", "expires_in_seconds", "token_type"].sort());
  });

  it("me's body is the opaque id + RBAC role + capabilities + three booleans — no email, no sid, no token", async () => {
    const res = await d.ctrl.me(ADMIN);
    assertPiiFree(res);
    // Capability names are a closed vocabulary of role verbs; they carry no worker or admin
    // identity, so widening the body to include them does not widen the PII surface. The 0144
    // additions are booleans — derived from the row, carrying none of it.
    expect(Object.keys(res).sort()).toEqual([
      "admin_id",
      "capabilities",
      "has_password",
      "mfa_enabled",
      "must_change_password",
      "role",
    ]);
    // The session id is identity-internal; it must not leak into the public identity view.
    expect(JSON.stringify(res)).not.toContain(SID);
  });
});

// ---------------------------------------------------------------------------
// NO-ENUMERATION ORACLE — the controller relays the service's neutral 401 unchanged.
// ---------------------------------------------------------------------------
describe("AdminAuthController — neutral error mapping (no enumeration oracle)", () => {
  let d: ReturnType<typeof makeCtrl>;
  beforeEach(() => {
    d = makeCtrl();
  });

  it("verifyLogin relays the service's neutral 401 verbatim (unknown vs wrong code are identical)", async () => {
    const neutral = new UnauthorizedException("Incorrect or expired code");
    // Both an unknown email and a wrong code surface the SAME service rejection — the controller
    // adds no branch, so the caller cannot distinguish them.
    d.auth.verifyLogin.mockRejectedValue(neutral);

    const unknown = d.ctrl.verifyLogin({ email: "ghost@nowhere.com", code: "999999" }, req, CTX);
    const wrong = d.ctrl.verifyLogin({ email: EMAIL, code: "000000" }, req, CTX);
    await expect(unknown).rejects.toBe(neutral);
    await expect(wrong).rejects.toBe(neutral);
  });

  it("verifyMfa relays the same neutral 401 for a bad TOTP / inactive account (no oracle)", async () => {
    const neutral = new UnauthorizedException("Incorrect or expired code");
    d.auth.verifyMfa.mockRejectedValueOnce(neutral);
    await expect(d.ctrl.verifyMfa({ email: EMAIL, code: "000000" }, req, CTX)).rejects.toBe(neutral);
  });

  it("the neutral 401 message carries no email/code — the error itself leaks no PII", async () => {
    d.auth.verifyMfa.mockRejectedValueOnce(new UnauthorizedException("Incorrect or expired code"));
    await expect(d.ctrl.verifyMfa({ email: EMAIL, code: OTP_CODE }, req, CTX)).rejects.toMatchObject({
      message: expect.not.stringContaining("@"),
    });
  });
});

// ---------------------------------------------------------------------------
// GUARD ORDERING — privileged routes are behind AdminAuthGuard; public routes are not.
// ---------------------------------------------------------------------------
describe("AdminAuthController — guard placement (must-fix #4)", () => {
  const GUARDS_METADATA = "__guards__";
  function methodGuardNames(method: string): string[] {
    const target = (AdminAuthController.prototype as unknown as Record<string, object>)[method];
    const g = Reflect.getMetadata(GUARDS_METADATA, target as object) as
      | Array<{ name?: string; constructor?: { name: string } }>
      | undefined;
    return (g ?? []).map((x) => x.name ?? x.constructor?.name ?? "anonymous");
  }

  it("refresh, logout, and me are each behind AdminAuthGuard (the session is required)", () => {
    for (const method of ["refresh", "logout", "me"]) {
      expect(methodGuardNames(method), `${method} must be behind AdminAuthGuard`).toContain(AdminAuthGuard.name);
    }
  });

  it("the three public routes carry NO AdminAuthGuard (the pre-session boundary)", () => {
    for (const method of ["requestLogin", "verifyLogin", "verifyMfa"]) {
      expect(methodGuardNames(method), `${method} must stay public`).not.toContain(AdminAuthGuard.name);
    }
  });

  it("the controller has NO class-level guard (auth is applied per-method, not blanket)", () => {
    const classGuards = (Reflect.getMetadata(GUARDS_METADATA, AdminAuthController) as unknown[] | undefined) ?? [];
    expect(classGuards).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SESSION TOKEN CHANNEL — the raw token rides the structured response / header, not a leak.
// ---------------------------------------------------------------------------
describe("AdminAuthController — session token channel (rolling refresh / x-session-token)", () => {
  let d: ReturnType<typeof makeCtrl>;
  beforeEach(() => {
    d = makeCtrl();
  });

  it("refresh returns the fresh rolling token in the structured access_token field (Bearer channel)", async () => {
    const res = await d.ctrl.refresh(ADMIN);
    // The rolling token is delivered as a typed field the admin web stores httpOnly — it is the
    // ONLY place a token appears, and it is never an opaque string baked into an unrelated body.
    expect(res.access_token).toBe("fresh-admin-jwt");
    expect(res.token_type).toBe("Bearer");
  });

  it("the half-life rolling refresh is the GUARD's x-session-token header, not a me/logout body", async () => {
    // me and logout never carry a token in their JSON; the rolling token (when emitted past the
    // half-life) is set by AdminAuthGuard on the response header — proven here by absence in body.
    const meRes = await d.ctrl.me(ADMIN);
    expect(JSON.stringify(meRes)).not.toContain("admin-jwt");
    expect(JSON.stringify(meRes)).not.toContain("x-session-token");
  });

  it("logout produces no token in any body (the session is revoked, not re-minted)", async () => {
    const res = await d.ctrl.logout(ADMIN, CTX);
    expect(res).toBeUndefined();
    expect(d.auth.logout).toHaveBeenCalledWith(ADMIN_ID, SID, CTX);
  });
});

// ---------------------------------------------------------------------------
// Migration 0144 — password door, forgot/reset, self-service password + two-step switch.
// ---------------------------------------------------------------------------
describe("AdminAuthController — 0144 public password routes (IP-capped, then delegated)", () => {
  let d: ReturnType<typeof makeCtrl>;
  beforeEach(() => {
    d = makeCtrl();
  });

  const PASSWORD = "Temp-pass-1234";

  it("login/password, password/forgot and password/reset each run the admin per-IP cap", async () => {
    await d.ctrl.loginWithPassword({ email: EMAIL, password: PASSWORD }, req, CTX);
    await d.ctrl.forgotPassword({ email: EMAIL }, req);
    await d.ctrl.resetPassword({ email: EMAIL, code: OTP_CODE, new_password: "N3w-password" }, req, CTX);
    expect(d.ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledTimes(3);
    for (const call of d.ipRateLimit.assertWithinHourlyIpCap.mock.calls) {
      expect(call).toEqual(["admin_auth", CLIENT_IP, IP_CAP]);
    }
  });

  it("a tripped cap blocks every public password route BEFORE the service", async () => {
    const tripped = () =>
      d.ipRateLimit.assertWithinHourlyIpCap.mockRejectedValueOnce(
        new HttpException("Too many requests", HttpStatus.TOO_MANY_REQUESTS),
      );
    tripped();
    await expect(d.ctrl.loginWithPassword({ email: EMAIL, password: PASSWORD }, req, CTX)).rejects.toBeInstanceOf(HttpException);
    tripped();
    await expect(d.ctrl.forgotPassword({ email: EMAIL }, req)).rejects.toBeInstanceOf(HttpException);
    tripped();
    await expect(
      d.ctrl.resetPassword({ email: EMAIL, code: OTP_CODE, new_password: "N3w-password" }, req, CTX),
    ).rejects.toBeInstanceOf(HttpException);
    expect(d.passwords.loginWithPassword).not.toHaveBeenCalled();
    expect(d.passwords.requestReset).not.toHaveBeenCalled();
    expect(d.passwords.resetPassword).not.toHaveBeenCalled();
  });

  it("each forwards the validated DTO (+ context) and returns the service shape verbatim", async () => {
    const dto = { email: EMAIL, password: PASSWORD, device_token: "t".repeat(43) };
    await d.ctrl.loginWithPassword(dto, req, CTX);
    expect(d.passwords.loginWithPassword).toHaveBeenCalledWith(dto, CTX);
    expect(await d.ctrl.forgotPassword({ email: EMAIL }, req)).toEqual({
      status: "code_sent",
      resend_in_seconds: 30,
    });
    expect(
      await d.ctrl.resetPassword({ email: EMAIL, code: OTP_CODE, new_password: "N3w-password" }, req, CTX),
    ).toEqual({ status: "password_reset", next: "sign_in" });
  });
});

describe("AdminAuthController — 0144 self routes take identity from the GUARD only", () => {
  let d: ReturnType<typeof makeCtrl>;
  beforeEach(() => {
    d = makeCtrl();
  });

  it("me/password passes the guard admin (id + sid) and returns the fresh session", async () => {
    const res = await d.ctrl.changeOwnPassword(ADMIN, { new_password: "N3w-password" }, CTX);
    expect(d.passwords.changeOwnPassword).toHaveBeenCalledWith(ADMIN, { new_password: "N3w-password" }, CTX);
    expect(res).toBe(d.sessionResponse);
  });

  it("me/mfa/enable|confirm|disable are keyed on the guard admin's id — never a body id", async () => {
    await d.ctrl.enableMfa(ADMIN);
    await d.ctrl.confirmMfa(ADMIN, { code: "123456" }, CTX);
    await d.ctrl.disableMfa(ADMIN, { code: "654321" }, CTX);
    expect(d.mfaSelf.enable).toHaveBeenCalledWith(ADMIN_ID);
    expect(d.mfaSelf.confirm).toHaveBeenCalledWith(ADMIN_ID, "123456", CTX);
    expect(d.mfaSelf.disable).toHaveBeenCalledWith(ADMIN_ID, "654321", CTX);
  });

  it("me/mfa/enable (which returns a TOTP secret) is marked Cache-Control: no-store", () => {
    const handler = (AdminAuthController.prototype as unknown as Record<string, object>).enableMfa!;
    const headers = (Reflect.getMetadata("__headers__", handler) as { name: string; value: string }[]) ?? [];
    expect(headers).toContainEqual({ name: "Cache-Control", value: "no-store" });
  });

  it("the 0144 self routes are behind AdminAuthGuard; the 0144 public routes are not", () => {
    const guardsOf = (method: string): string[] => {
      const target = (AdminAuthController.prototype as unknown as Record<string, object>)[method];
      const g = (Reflect.getMetadata("__guards__", target as object) as Array<{ name?: string }> | undefined) ?? [];
      return g.map((x) => x.name ?? "anonymous");
    };
    for (const m of ["changeOwnPassword", "enableMfa", "confirmMfa", "disableMfa"]) {
      expect(guardsOf(m), m).toContain(AdminAuthGuard.name);
    }
    for (const m of ["loginWithPassword", "forgotPassword", "resetPassword"]) {
      expect(guardsOf(m), m).not.toContain(AdminAuthGuard.name);
    }
  });
});
