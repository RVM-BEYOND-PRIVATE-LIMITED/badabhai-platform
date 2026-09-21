import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { UnauthorizedException } from "@nestjs/common";
import type { AdminUser } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import { AdminAuthService } from "./admin-auth.service";

/**
 * The ACCEPT half of the admin invite flow (`pending` → `active`).
 *
 * This is the transition that did not exist: `admin_users.status` defaulted to 'pending',
 * only an 'active' row may authenticate, and nothing ever flipped it — so every invite was a
 * dead end. These tests pin the behaviour that closes that loop AND the guarantees that keep
 * it from becoming a way in:
 *   - the raw token is never compared or stored (only its HMAC leaves the service),
 *   - unknown / expired / consumed / non-pending all fail IDENTICALLY (no oracle),
 *   - accepting does NOT mint a session (the MFA gate stays the only door),
 *   - the emitted event is PII-free and names the ACCEPTING admin as actor.
 */

const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const RAW_TOKEN = "raw-invite-token-value";
const CTX: RequestContext = {
  correlationId: "corr-1",
  requestId: "req-1",
} as unknown as RequestContext;

function activeRow(over: Partial<AdminUser> = {}): AdminUser {
  return {
    id: ADMIN_ID,
    emailEnc: "ciphertext",
    emailHash: "hash",
    role: "ops_admin",
    status: "active",
    mfaEnrolled: false,
    lastLoginAt: null,
    inviteTokenHash: null,
    inviteExpiresAt: null,
    createdAt: new Date("2026-09-11T00:00:00.000Z"),
    updatedAt: new Date("2026-09-11T00:00:00.000Z"),
    ...over,
  } as AdminUser;
}

function make(over: { accepted?: AdminUser | undefined } = {}) {
  const admins = {
    // Default: the guarded UPDATE matched and returned the now-active row. Params are declared
    // so the call-args are typed when a test asserts WHAT was passed.
    acceptInvite: vi.fn(async (_tokenHash: string, _now: Date) =>
      "accepted" in over ? over.accepted : activeRow(),
    ),
  };
  const events = { emit: vi.fn(async (_e: unknown) => undefined) };
  const sessions = { mint: vi.fn(), revoke: vi.fn() };
  const invites = { hashToken: vi.fn((raw: string) => `hmac:${raw}`) };

  const svc = new AdminAuthService(
    {} as never,
    admins as never,
    {} as never,
    sessions as never,
    {} as never,
    events as never,
    invites as never,
  );
  return { svc, admins, events, sessions, invites };
}

describe("AdminAuthService.acceptInvite — the missing pending→active transition", () => {
  let m: ReturnType<typeof make>;
  beforeEach(() => {
    m = make();
  });

  it("activates the invited admin and reports where to go next", async () => {
    const res = await m.svc.acceptInvite({ token: RAW_TOKEN }, CTX);

    expect(res).toEqual({
      admin_id: ADMIN_ID,
      role: "ops_admin",
      status: "active",
      next: "sign_in",
    });
  });

  it("resolves the row by the token HMAC — the RAW token never reaches the repository", async () => {
    await m.svc.acceptInvite({ token: RAW_TOKEN }, CTX);

    expect(m.invites.hashToken).toHaveBeenCalledWith(RAW_TOKEN);
    const [passedHash] = m.admins.acceptInvite.mock.calls[0]!;
    expect(passedHash).toBe(`hmac:${RAW_TOKEN}`);
    expect(passedHash).not.toBe(RAW_TOKEN);
  });

  it("does NOT mint a session — accepting cannot bypass the MFA gate (must-fix #1)", async () => {
    const res = (await m.svc.acceptInvite({ token: RAW_TOKEN }, CTX)) as unknown as Record<
      string,
      unknown
    >;

    // No session service call, and nothing token-shaped in the response: the freshly active
    // admin must still go through request-code → verify → TOTP enrolment like everyone else.
    expect(m.sessions.mint).not.toHaveBeenCalled();
    expect(res.access_token).toBeUndefined();
    expect(res.token_type).toBeUndefined();
  });

  it("emits ONE PII-free admin_invite_accepted naming the ACCEPTING admin as actor", async () => {
    await m.svc.acceptInvite({ token: RAW_TOKEN }, CTX);

    expect(m.events.emit).toHaveBeenCalledTimes(1);
    const e = m.events.emit.mock.calls[0]![0] as unknown as {
      event_name: string;
      actor: { actor_type: string; actor_id: string };
      payload: Record<string, unknown>;
    };
    expect(e.event_name).toBe("admin.action_performed");
    expect(e.payload.action_code).toBe("admin_invite_accepted");
    // The invitee acted — attributing this to the original inviter would misstate the audit.
    expect(e.actor).toEqual({ actor_type: "admin", actor_id: ADMIN_ID });

    // Nothing secret or personal anywhere in the serialized event.
    const blob = JSON.stringify(e);
    expect(blob).not.toContain(RAW_TOKEN);
    expect(blob).not.toContain("hmac:");
    expect(blob).not.toContain("@");
  });
});

describe("AdminAuthService.acceptInvite — no-oracle failure (every bad token looks the same)", () => {
  // The repository collapses unknown / expired / consumed / non-pending into one `undefined`,
  // so a caller cannot probe which invite links were ever issued.
  const CASES = [
    "an unknown token",
    "an expired link",
    "an already-consumed link",
    "a token whose admin is suspended, not pending",
  ];

  for (const label of CASES) {
    it(`${label} → 401, NO event, NO session`, async () => {
      const m = make({ accepted: undefined });

      await expect(m.svc.acceptInvite({ token: RAW_TOKEN }, CTX)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(m.events.emit).not.toHaveBeenCalled();
      expect(m.sessions.mint).not.toHaveBeenCalled();
    });
  }

  it("the rejection message reveals nothing about WHY it failed", async () => {
    const m = make({ accepted: undefined });

    await expect(m.svc.acceptInvite({ token: RAW_TOKEN }, CTX)).rejects.toThrow(
      /invalid or has expired/i,
    );
    // Deliberately fused: "expired" and "already used" must not be distinguishable, or the
    // endpoint becomes a probe for which links were issued.
    await expect(m.svc.acceptInvite({ token: RAW_TOKEN }, CTX)).rejects.not.toThrow(
      /already used|consumed|suspended|unknown/i,
    );
  });
});
