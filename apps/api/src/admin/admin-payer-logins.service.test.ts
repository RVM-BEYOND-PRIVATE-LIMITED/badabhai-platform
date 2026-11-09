import "reflect-metadata";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { createEvent, validateEvent, type CreateEventInput } from "@badabhai/event-schema";
import { PasswordPolicySchema } from "../common/password-policy";
import type { RequestContext } from "../common/request-context";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { ADMIN_ACTION_CODES } from "./admin-actions.service";
import { AdminPayerLoginsService } from "./admin-payer-logins.service";
import { AdminCreatePayerLoginSchema } from "./admin-payer-logins.dto";

const CTX: RequestContext = {
  correlationId: "11111111-1111-4111-8111-111111111111",
  requestId: "req-1",
};
const ADMIN = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  sid: "s1",
  role: "ops_admin",
} as AuthenticatedAdmin;
const REASON = {
  reason_code: "login_created",
  reason_text: "Created for the client onboarding call",
};

function setup() {
  const payers = {
    createOrGet: vi.fn(async () => ({ id: "p1", created: true })),
    findByEmail: vi.fn(async () => undefined),
    findByPhone: vi.fn(async () => []),
    findById: vi.fn(async () => ({
      id: "p1",
      role: "employer",
      status: "active",
      emailEnc: "email-enc",
      emailHash: "email-hash",
      phoneEnc: null,
      orgNameEnc: "org-enc",
      passwordRevokedAt: null,
      mustChangePassword: true,
    })),
    setTemporaryPassword: vi.fn(async () => ({})),
    revokePassword: vi.fn(async () => ({})),
    activate: vi.fn(async () => ({ id: "p1" })),
    recordLogin: vi.fn(async () => undefined),
  };
  const orgs = {
    findOrgById: vi.fn(async () => ({
      id: "org-1",
      rootPayerId: "root-1",
      nameEnc: "org-enc",
      status: "active" as const,
    })),
    ensureSoloOrg: vi.fn(async () => ({ orgId: "org-1", orgRole: "owner" })),
    createActiveMember: vi.fn(async () => ({ id: "member-1" })),
  };
  const sessions = { revokeAllForPayer: vi.fn(async () => 0) };
  const lockStates = {
    lockStates: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, false]))),
    clear: vi.fn(async () => undefined),
  };
  const identity = {
    resolve: vi.fn(async (_admin: AuthenticatedAdmin, surface: string, ids: string[]) => {
      if (surface === "payer_logins") {
        return new Map(ids.map((id) => [id, `${id}@example.com`]));
      }
      return new Map(ids.map((id) => [id, `Org ${id}`]));
    }),
  };
  const events = { emit: vi.fn(async () => undefined) };
  const pii = { hashPassword: (v: string) => `hash<${v}>` };
  const freeTier = { grantQuietly: vi.fn(async () => undefined) };
  const notice = { notify: vi.fn(async () => undefined) };
  const config = { PAYER_TEMP_PASSWORD_TTL_HOURS: 168 } as never;
  const repo = {
    withTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({})),
    listAccounts: vi.fn(async () => ({ rows: [], nextCursor: null })),
    activeMemberships: vi.fn(async () => []),
    orgsByRootPayer: vi.fn(async () => []),
    orgsByIds: vi.fn(async () => []),
    writeAuditReason: vi.fn(async () => undefined),
    writeConflictAudit: vi.fn(async () => undefined),
  };
  const svc = new AdminPayerLoginsService(
    config as never,
    repo as never,
    payers as never,
    orgs as never,
    sessions as never,
    lockStates as never,
    identity as never,
    events as never,
    pii as never,
    freeTier as never,
    notice as never,
  );
  return { svc, repo, payers, orgs, sessions, lockStates, identity, events, pii, freeTier, notice };
}

function actionEvents(events: { emit: { mock: { calls: unknown[][] } } }) {
  return events.emit.mock.calls
    .map(
      (c) =>
        c[0] as {
          event_name: string;
          payload: Record<string, unknown>;
          actor: { actor_type: string; actor_id?: string };
          subject: { subject_type: string; subject_id: string | null };
        },
    )
    .filter((e) => e.event_name === "admin.action_performed");
}

function eventNamed(events: { emit: { mock: { calls: unknown[][] } } }, name: string) {
  return events.emit.mock.calls
    .map(
      (c) =>
        c[0] as {
          event_name: string;
          payload: Record<string, unknown>;
          actor: { actor_type: string; actor_id?: string };
        },
    )
    .filter((e) => e.event_name === name);
}

describe("AdminPayerLoginsService — create (#2563)", () => {
  it("rejects a co-owner: the only team-member org_role is `recruiter`", () => {
    const base = {
      email: "member@example.com",
      member_of_org_id: "11111111-1111-4111-8111-111111111111",
      reason_code: "login_created",
      reason_text: "Added to the client's recruiting team",
    };
    expect(AdminCreatePayerLoginSchema.safeParse(base).success).toBe(true);
    expect(AdminCreatePayerLoginSchema.safeParse({ ...base, org_role: "recruiter" }).success).toBe(
      true,
    );
    expect(AdminCreatePayerLoginSchema.safeParse({ ...base, org_role: "owner" }).success).toBe(
      false,
    );
  });

  it("rejects a reason carrying an email, phone or other hard identifier", () => {
    const base = {
      role: "employer",
      email: "owner@example.com",
      org_name: "Acme",
      reason_code: "login_created",
    };
    expect(
      AdminCreatePayerLoginSchema.safeParse({
        ...base,
        reason_text: "Created for the client onboarding call",
      }).success,
    ).toBe(true);
    expect(
      AdminCreatePayerLoginSchema.safeParse({
        ...base,
        reason_text: "Created for owner@example.com after the call",
      }).success,
    ).toBe(false);
    expect(
      AdminCreatePayerLoginSchema.safeParse({
        ...base,
        reason_text: "Created after calling +91 98765 43210 about it",
      }).success,
    ).toBe(false);
  });

  it("creates an owner login with a policy-valid 14-character temporary password, in one transaction", async () => {
    const d = setup();
    const res = await d.svc.createLogin(
      ADMIN,
      {
        role: "employer",
        email: "owner@example.com",
        org_name: "Acme",
        ...REASON,
      } as never,
      CTX,
    );

    expect(res.payer_id).toBe("p1");
    expect(res.must_change_password).toBe(true);
    expect(res.temporary_password).toHaveLength(14);
    expect(PasswordPolicySchema.safeParse(res.temporary_password).success).toBe(true);
    expect(d.payers.createOrGet).toHaveBeenCalledWith(
      { role: "employer", email: "owner@example.com", phone: undefined, orgName: "Acme" },
      {},
    );
    expect(d.orgs.ensureSoloOrg).toHaveBeenCalledWith("p1", {});
    // BLOCKER review fix — the schema default is `pending`; the admin create ACTIVATES it.
    expect(d.payers.activate).toHaveBeenCalledWith("p1", {});
    expect(eventNamed(d.events, "payer.activated")[0]).toMatchObject({
      actor: { actor_type: "admin", actor_id: ADMIN.id },
      payload: { payer_id: "p1", previous_status: "pending", new_status: "active" },
    });
    expect(eventNamed(d.events, "payer.created")[0]).toMatchObject({
      actor: { actor_type: "admin", actor_id: ADMIN.id },
    });
    expect(d.payers.setTemporaryPassword).toHaveBeenCalledWith(
      "p1",
      { hash: `hash<${res.temporary_password}>`, pepperVersion: 1 },
      {},
    );
    expect(d.repo.writeAuditReason).toHaveBeenCalledWith(
      {},
      {
        adminId: ADMIN.id,
        payerId: "p1",
        action: ADMIN_ACTION_CODES.payer_login_created,
        reasonCode: REASON.reason_code,
        reasonText: REASON.reason_text,
      },
    );
    expect(actionEvents(d.events)[0]?.payload).toMatchObject({
      admin_id: ADMIN.id,
      action_code: "payer_login_created",
      target_type: "payer",
      target_id: "p1",
    });
    expect(d.freeTier.grantQuietly).toHaveBeenCalledWith("p1");
    expect(d.sessions.revokeAllForPayer).toHaveBeenCalledWith("p1");
    expect(d.notice.notify).toHaveBeenCalledWith("p1", "setup");
  });

  it("409 when the email/phone already exists — no credential, no audit row, no event", async () => {
    const d = setup();
    d.payers.createOrGet.mockResolvedValueOnce({ id: "p1", created: false });

    await expect(
      d.svc.createLogin(
        ADMIN,
        { role: "agent", email: "taken@example.com", org_name: "Agency", ...REASON } as never,
        CTX,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(d.payers.setTemporaryPassword).not.toHaveBeenCalled();
    expect(d.repo.writeAuditReason).not.toHaveBeenCalled();
    expect(d.events.emit).not.toHaveBeenCalled();
    // Review fix 11 — the rolled-back check still leaves a value-free audit trace.
    expect(d.repo.writeConflictAudit).toHaveBeenCalledWith(
      ADMIN.id,
      "p1",
      ADMIN_ACTION_CODES.payer_login_create_conflict,
    );
  });

  it("a team member gets an ACTIVE membership with no invite token, no solo org and no free-tier grant", async () => {
    const d = setup();
    d.payers.findById
      .mockResolvedValueOnce({ id: "root-1", role: "agent", orgNameEnc: "root-org-enc" } as never)
      .mockResolvedValueOnce({
        id: "p1",
        emailEnc: "member-email-enc",
        emailHash: "member-email-hash",
      } as never);

    const res = await d.svc.createLogin(
      ADMIN,
      {
        email: "member@example.com",
        member_of_org_id: "org-1",
        org_role: "recruiter",
        ...REASON,
      } as never,
      CTX,
    );

    expect(res.payer_id).toBe("p1");
    expect(d.payers.createOrGet).toHaveBeenCalledWith(
      {
        role: "agent",
        email: "member@example.com",
        phone: undefined,
        orgNameEnc: "org-enc",
      },
      {},
    );
    expect(d.orgs.createActiveMember).toHaveBeenCalledWith(
      {
        orgId: "org-1",
        memberPayerId: "p1",
        emailEnc: "member-email-enc",
        emailHash: "member-email-hash",
        orgRole: "recruiter",
      },
      {},
    );
    expect(d.orgs.ensureSoloOrg).not.toHaveBeenCalled();
    expect(d.freeTier.grantQuietly).not.toHaveBeenCalled();
  });

  it("the temporary password never reaches an event, an audit row, or stdout/stderr", async () => {
    const d = setup();
    const out: string[] = [];
    const so = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    const se = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    try {
      const res = await d.svc.createLogin(
        ADMIN,
        { role: "employer", email: "owner@example.com", org_name: "Acme", ...REASON } as never,
        CTX,
      );
      const blob = JSON.stringify([
        d.events.emit.mock.calls,
        d.repo.writeAuditReason.mock.calls,
        out,
      ]);
      expect(blob).not.toContain(res.temporary_password);
    } finally {
      so.mockRestore();
      se.mockRestore();
    }
  });
});

describe("AdminPayerLoginsService — issue / revoke (#2563)", () => {
  it("issues a new temporary password, audits the reason, emits the action, and ends every session", async () => {
    const d = setup();
    const res = await d.svc.issueTemporaryPassword(
      ADMIN,
      "p1",
      { reason_code: "password_issued", reason_text: "Payer lost the onboarding email" } as never,
      CTX,
    );

    expect(res.temporary_password).toHaveLength(14);
    expect(PasswordPolicySchema.safeParse(res.temporary_password).success).toBe(true);
    expect(d.payers.setTemporaryPassword).toHaveBeenCalledWith(
      "p1",
      { hash: `hash<${res.temporary_password}>`, pepperVersion: 1 },
      {},
    );
    expect(actionEvents(d.events)[0]?.payload.action_code).toBe("payer_password_issued");
    expect(d.sessions.revokeAllForPayer).toHaveBeenCalledWith("p1");
    expect(d.lockStates.clear).toHaveBeenCalledWith("p1");
    expect(d.notice.notify).toHaveBeenCalledWith("p1", "reset");
  });

  it("sends the issue notice even when the session sweep throws", async () => {
    const d = setup();
    d.sessions.revokeAllForPayer.mockRejectedValueOnce(new Error("redis down"));
    await expect(
      d.svc.issueTemporaryPassword(
        ADMIN,
        "p1",
        { reason_code: "password_issued", reason_text: "Payer lost the onboarding email" } as never,
        CTX,
      ),
    ).rejects.toThrow("redis down");
    expect(d.notice.notify).toHaveBeenCalledWith("p1", "reset");
  });

  it("activates a PENDING self-signup and emits payer.activated with the admin as actor", async () => {
    const d = setup();
    d.payers.findById.mockResolvedValueOnce({
      id: "p1",
      status: "pending",
      passwordSetAt: null,
      passwordRevokedAt: null,
      mustChangePassword: false,
    } as never);

    await d.svc.issueTemporaryPassword(
      ADMIN,
      "p1",
      {
        reason_code: "password_issued",
        reason_text: "Admin vouched for this self-signup",
      } as never,
      CTX,
    );

    expect(d.payers.activate).toHaveBeenCalledWith("p1", {});
    expect(eventNamed(d.events, "payer.activated")[0]).toMatchObject({
      actor: { actor_type: "admin", actor_id: ADMIN.id },
      payload: { payer_id: "p1", previous_status: "pending", new_status: "active" },
    });
  });

  it("refuses to issue on a SUSPENDED account (reinstate first)", async () => {
    const d = setup();
    d.payers.findById.mockResolvedValueOnce({
      id: "p1",
      status: "suspended",
      passwordSetAt: null,
      passwordRevokedAt: null,
      mustChangePassword: false,
    } as never);

    await expect(
      d.svc.issueTemporaryPassword(
        ADMIN,
        "p1",
        {
          reason_code: "password_issued",
          reason_text: "Admin tried to reset a suspended login",
        } as never,
        CTX,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(d.payers.setTemporaryPassword).not.toHaveBeenCalled();
    expect(d.payers.activate).not.toHaveBeenCalled();
  });

  it("revokes password sign-in, audits the reason, emits the action, and ends every session", async () => {
    const d = setup();
    d.payers.findById.mockResolvedValueOnce({
      id: "p1",
      passwordRevokedAt: null,
      mustChangePassword: false,
    } as never);

    await expect(
      d.svc.revokePassword(
        ADMIN,
        "p1",
        { reason_code: "password_revoked", reason_text: "Credential reported as shared" } as never,
        CTX,
      ),
    ).resolves.toEqual({ payer_id: "p1", changed: true });

    expect(d.payers.revokePassword).toHaveBeenCalledWith("p1", {});
    expect(actionEvents(d.events)[0]?.payload.action_code).toBe("payer_password_revoked");
    expect(d.sessions.revokeAllForPayer).toHaveBeenCalledWith("p1");
    expect(d.notice.notify).toHaveBeenCalledWith("p1", "revoked");
  });

  it("sends the revoke notice even when the session sweep throws", async () => {
    const d = setup();
    d.payers.findById.mockResolvedValueOnce({
      id: "p1",
      passwordRevokedAt: null,
      mustChangePassword: false,
      status: "active",
    } as never);
    d.sessions.revokeAllForPayer.mockRejectedValueOnce(new Error("redis down"));
    await expect(
      d.svc.revokePassword(
        ADMIN,
        "p1",
        { reason_code: "password_revoked", reason_text: "Credential reported as shared" } as never,
        CTX,
      ),
    ).rejects.toThrow("redis down");
    expect(d.notice.notify).toHaveBeenCalledWith("p1", "revoked");
  });

  it("is idempotent when the password is already revoked: no write, no event", async () => {
    const d = setup();
    d.payers.findById.mockResolvedValueOnce({
      id: "p1",
      passwordRevokedAt: new Date("2026-11-04T00:00:00Z"),
      mustChangePassword: false,
    } as never);

    await expect(
      d.svc.revokePassword(
        ADMIN,
        "p1",
        { reason_code: "password_revoked", reason_text: "Credential reported as shared" } as never,
        CTX,
      ),
    ).resolves.toEqual({ payer_id: "p1", changed: false });

    expect(d.payers.revokePassword).not.toHaveBeenCalled();
    expect(d.events.emit).not.toHaveBeenCalled();
    // Review fix 12 — the session sweep is idempotent and STILL runs on a retry.
    expect(d.sessions.revokeAllForPayer).toHaveBeenCalledWith("p1");
  });

  it("404 for an unknown payer", async () => {
    const d = setup();
    d.payers.findById.mockResolvedValueOnce(undefined as never);
    await expect(
      d.svc.issueTemporaryPassword(
        ADMIN,
        "p1",
        { reason_code: "password_issued", reason_text: "Payer lost the onboarding email" } as never,
        CTX,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("the admin.action_performed payload validates against the registry", async () => {
    const d = setup();
    await d.svc.issueTemporaryPassword(
      ADMIN,
      "p1",
      { reason_code: "password_issued", reason_text: "Payer lost the onboarding email" } as never,
      CTX,
    );
    const emitted = actionEvents(d.events)[0]!;
    const payerUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const built = createEvent<"admin.action_performed">({
      event_name: "admin.action_performed",
      payload: {
        ...emitted.payload,
        target_id: payerUuid,
      } as CreateEventInput<"admin.action_performed">["payload"],
      source: "api",
      correlation_id: CTX.correlationId,
      metadata: { environment: "test", service: "api", request_id: CTX.requestId },
      actor: { actor_type: "admin", actor_id: ADMIN.id },
      subject: { subject_type: "payer", subject_id: payerUuid },
    });
    expect(validateEvent(built).success).toBe(true);
  });
});

describe("AdminPayerLoginsService — accounts list (#2563)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("resolves login IDs and organisation names through the identity layer and derives type/state/locked", async () => {
    const d = setup();
    d.repo.listAccounts.mockResolvedValueOnce({
      rows: [
        {
          id: "owner-1",
          role: "employer",
          status: "active",
          createdAt: new Date("2026-11-01T00:00:00Z"),
          lastLoginAt: new Date("2026-11-03T00:00:00Z"),
          passwordSetAt: new Date("2026-11-02T00:00:00Z"),
          passwordRevokedAt: null,
          mustChangePassword: false,
          hasPassword: true,
        },
        {
          id: "member-1",
          role: "agent",
          status: "active",
          createdAt: new Date("2026-11-01T00:00:00Z"),
          lastLoginAt: null,
          // A temp password is PENDING only inside PAYER_TEMP_PASSWORD_TTL_HOURS (default 168).
          // A fixed 2026-11-02 date expired on 2026-11-09 and turned this case into a calendar
          // time bomb; the assertion is about the STATE, not the wall clock.
          passwordSetAt: new Date(Date.now() - 60 * 60 * 1000),
          passwordRevokedAt: null,
          mustChangePassword: true,
          hasPassword: true,
        },
      ],
      nextCursor: "next",
    } as never);
    d.repo.activeMemberships.mockResolvedValueOnce([
      { memberPayerId: "member-1", orgId: "org-1", orgRole: "recruiter" },
    ] as never);
    d.repo.orgsByRootPayer.mockResolvedValueOnce([
      { id: "org-1", rootPayerId: "owner-1" },
    ] as never);
    d.repo.orgsByIds.mockResolvedValueOnce([{ id: "org-1", rootPayerId: "owner-1" }] as never);

    const page = await d.svc.listAccounts(ADMIN, { limit: 25 } as never, CTX);

    expect(page.nextCursor).toBe("next");
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      id: "owner-1",
      login_id: "owner-1@example.com",
      organisation: "Org owner-1",
      type: "company_owner",
      password_state: "set",
      locked: false,
    });
    expect(page.items[1]).toMatchObject({
      id: "member-1",
      login_id: "member-1@example.com",
      // A team member's organisation is the PARENT org, not their own row.
      organisation: "Org owner-1",
      type: "team_member",
      password_state: "temporary_pending",
    });
    expect(d.identity.resolve).toHaveBeenNthCalledWith(
      1,
      ADMIN,
      "payer_logins",
      ["owner-1", "member-1"],
      null,
      CTX,
    );
    expect(d.identity.resolve).toHaveBeenNthCalledWith(2, ADMIN, "payers", ["owner-1"], null, CTX);
  });

  it("omits login_id and organisation when the identity layer discloses nothing", async () => {
    const d = setup();
    d.repo.listAccounts.mockResolvedValueOnce({
      rows: [
        {
          id: "owner-1",
          role: "agent",
          status: "active",
          createdAt: new Date(),
          lastLoginAt: null,
          passwordSetAt: null,
          passwordRevokedAt: null,
          mustChangePassword: false,
          hasPassword: false,
        },
      ],
      nextCursor: null,
    } as never);
    d.identity.resolve.mockResolvedValue(null as never);

    const page = await d.svc.listAccounts(ADMIN, { limit: 25 } as never, CTX);
    expect(page.items[0]).not.toHaveProperty("login_id");
    expect(page.items[0]).not.toHaveProperty("organisation");
    expect(page.items[0]).toMatchObject({ type: "agency_owner", password_state: "none" });
  });

  it("marks a temporary password past the TTL as temporary_expired", async () => {
    const d = setup();
    d.repo.listAccounts.mockResolvedValueOnce({
      rows: [
        {
          id: "owner-1",
          role: "employer",
          status: "active",
          createdAt: new Date(),
          lastLoginAt: null,
          passwordSetAt: new Date(Date.now() - 169 * 3_600_000),
          passwordRevokedAt: null,
          mustChangePassword: true,
          hasPassword: true,
        },
      ],
      nextCursor: null,
    } as never);
    d.identity.resolve.mockResolvedValue(null as never);

    const page = await d.svc.listAccounts(ADMIN, { limit: 25 } as never, CTX);
    expect(page.items[0]).toMatchObject({ password_state: "temporary_expired" });
  });
});
