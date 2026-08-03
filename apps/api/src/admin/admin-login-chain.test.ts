import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { AdminAuthService } from "./admin-auth.service";
import type { AdminRepository } from "./admin.repository";
import type { AdminOtpService } from "./admin-otp.service";

/**
 * ADR-0038 — THE UNBLOCK, end to end.
 *
 * Before this pair of changes the admin surface was complete and unreachable: `admin_users`
 * rows could only be created by an authenticated admin, and `issueAndSend` reserved a code
 * and logged "delivery deferred" rather than sending it. Two separate stoppages, either of
 * which alone is enough to make the Admin Portal unusable.
 *
 * The unit suites cover each piece. This file pins the JOIN between them — that the login
 * request actually reaches a real sender for exactly the accounts that should get mail —
 * because that is the property that was broken, and it lives in no single unit.
 */

const EMAIL = "ops.admin@badabhai.in";
const EMAIL_HASH = "9f3c1a7b2e5d4806c1f0a9b8d7e6f5a4";

function setup(account: { status: string } | undefined) {
  const admins = {
    emailHash: () => EMAIL_HASH,
    findByEmailHash: vi.fn(async () => account),
  } as unknown as AdminRepository;

  const otp = {
    issueAndSend: vi.fn(async () => ({ resendInSeconds: 30 })),
    issueWithoutDelivery: vi.fn(async () => ({ resendInSeconds: 30 })),
  } as unknown as AdminOtpService;

  // Constructor order: (config, admins, otp, sessions, mfaStore, events).
  const svc = new AdminAuthService(
    { ADMIN_OTP_RESEND_COOLDOWN_SECONDS: 30 } as never,
    admins,
    otp,
    {} as never,
    {} as never,
    {} as never,
  );
  return { svc, otp };
}

describe("admin login chain (ADR-0038) — the request reaches a real sender", () => {
  it("an ACTIVE admin gets a DELIVERED code, addressed to their raw email", async () => {
    // The bug: this used to route to a stub that sent nothing, so no admin could log in.
    const { svc, otp } = setup({ status: "active" });
    await svc.requestLogin({ email: EMAIL } as never);

    expect(otp.issueAndSend).toHaveBeenCalledTimes(1);
    // The RAW address must reach the sender — `emailHash` is the lookup key, not a
    // deliverable. Passing only the hash is exactly how this silently sends nowhere.
    expect(otp.issueAndSend).toHaveBeenCalledWith(EMAIL_HASH, EMAIL);
    expect(otp.issueWithoutDelivery).not.toHaveBeenCalled();
  });

  for (const status of ["pending", "suspended"]) {
    it(`a ${status.toUpperCase()} admin reserves a code but is sent NOTHING`, async () => {
      // Same neutral response either way (no enumeration), but no mail to an account that
      // cannot authenticate — the admin analogue of ADR-0037 Decision 5.
      const { svc, otp } = setup({ status });
      await svc.requestLogin({ email: EMAIL } as never);

      expect(otp.issueAndSend).not.toHaveBeenCalled();
      expect(otp.issueWithoutDelivery).toHaveBeenCalledTimes(1);
    });
  }

  it("an UNKNOWN email still reserves, so the response and its 429s match a known one", async () => {
    const { svc, otp } = setup(undefined);
    await svc.requestLogin({ email: EMAIL } as never);
    expect(otp.issueAndSend).not.toHaveBeenCalled();
    expect(otp.issueWithoutDelivery).toHaveBeenCalledTimes(1);
  });

  it("the response body is IDENTICAL for active, suspended and unknown", async () => {
    const active = await setup({ status: "active" }).svc.requestLogin({ email: EMAIL } as never);
    const banned = await setup({ status: "suspended" }).svc.requestLogin({ email: EMAIL } as never);
    const unknown = await setup(undefined).svc.requestLogin({ email: EMAIL } as never);
    expect(banned).toEqual(active);
    expect(unknown).toEqual(active);
  });
});
