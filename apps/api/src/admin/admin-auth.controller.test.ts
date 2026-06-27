import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { HttpException, HttpStatus, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import type { ServerConfig } from "@badabhai/config";
import type { AdminRole } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import { AdminAuthGuard, type AuthenticatedAdmin } from "./admin-auth.guard";
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
const ADMIN: AuthenticatedAdmin = { id: ADMIN_ID, role: ROLE, sid: SID };

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
  };
  const ipRateLimit = { assertWithinHourlyIpCap: vi.fn(async () => undefined) };
  const config = { ADMIN_AUTH_MAX_PER_IP_PER_HOUR: IP_CAP } as unknown as ServerConfig;
  const ctrl = new AdminAuthController(auth as never, ipRateLimit as never, config);
  return { ctrl, auth, ipRateLimit, sessionResponse };
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
    expect(d.auth.refresh).toHaveBeenCalledWith(ADMIN_ID, SID, ROLE);
    expect(res).toMatchObject({ access_token: "fresh-admin-jwt", token_type: "Bearer" });
  });

  it("logout revokes the GUARD admin's own session (id, sid) + threads context for the event", async () => {
    await d.ctrl.logout(ADMIN, CTX);
    expect(d.auth.logout).toHaveBeenCalledWith(ADMIN_ID, SID, CTX);
  });

  it("logout resolves void (204) and never returns a body", async () => {
    await expect(d.ctrl.logout(ADMIN, CTX)).resolves.toBeUndefined();
  });

  it("me is built by the controller from the GUARD admin — id + role ONLY (no service call)", () => {
    const res = d.ctrl.me(ADMIN);
    expect(res).toEqual({ admin_id: ADMIN_ID, role: ROLE });
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

  it("me's body is the opaque id + RBAC role ONLY — no email, no sid, no token", () => {
    const res = d.ctrl.me(ADMIN);
    assertPiiFree(res);
    expect(Object.keys(res).sort()).toEqual(["admin_id", "role"]);
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

  it("the half-life rolling refresh is the GUARD's x-session-token header, not a me/logout body", () => {
    // me and logout never carry a token in their JSON; the rolling token (when emitted past the
    // half-life) is set by AdminAuthGuard on the response header — proven here by absence in body.
    const meRes = d.ctrl.me(ADMIN);
    expect(JSON.stringify(meRes)).not.toContain("admin-jwt");
    expect(JSON.stringify(meRes)).not.toContain("x-session-token");
  });

  it("logout produces no token in any body (the session is revoked, not re-minted)", async () => {
    const res = await d.ctrl.logout(ADMIN, CTX);
    expect(res).toBeUndefined();
    expect(d.auth.logout).toHaveBeenCalledWith(ADMIN_ID, SID, CTX);
  });
});
