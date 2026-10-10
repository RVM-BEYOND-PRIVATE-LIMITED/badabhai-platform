import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  INVITE_NOT_ACCEPTABLE_MESSAGE,
  INVITE_NOT_SENDABLE_MESSAGE,
  PayerOrgMembersService,
} from "./payer-org-members.service";
import type { ResolvedOrg } from "../payers/payer-orgs.repository";
import type { ActiveMembershipFacts } from "../payers/payer-tenant-scope";

const ORG: ResolvedOrg = { orgId: "org-1", orgRole: "owner" };
const OWNER = "aaaaaaaa-0000-4000-8000-000000000001";
const ACCEPTER = "bbbbbbbb-0000-4000-8000-000000000002";
const OWNER_ELSEWHERE = "cccccccc-0000-4000-8000-000000000003";
const CTX = { correlationId: "11111111-1111-4111-8111-111111111111", requestId: "req-1" };
const EMAIL = "hire@acmestaffing.example";
const RAW_TOKEN = "tok-raw-0123456789abcdef";

/** Reversible fake crypto: enc<x>/dec, keyed hmac<x>. Mirrors the PiiCryptoService contract. */
const pii = {
  encrypt: (v: string) => `enc<${v}>`,
  decrypt: (v: string) => v.replace(/^enc<(.*)>$/, "$1"),
  hmac: (v: string) => `hmac<${v}>`,
};

function memberRow(over: Record<string, unknown> = {}) {
  return {
    id: "mem-1",
    orgId: ORG.orgId,
    memberPayerId: null,
    emailEnc: `enc<${EMAIL}>`,
    emailHash: `hmac<${EMAIL}>`,
    orgRole: "recruiter",
    status: "invited",
    invitedBy: OWNER,
    inviteTokenHash: `hmac<${RAW_TOKEN}>`,
    inviteExpiresAt: new Date("2026-07-08T00:00:00.000Z"),
    invitedAt: new Date("2026-07-01T00:00:00.000Z"),
    acceptedAt: null,
    removedAt: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    ...over,
  };
}

/** An ACTIVE membership of the accepter, as the tenancy read returns it (ADR-0053 R1). */
function membershipOf(
  anchorPayerId: string,
  over: Partial<ActiveMembershipFacts> = {},
): ActiveMembershipFacts {
  return {
    orgId: `org-of-${anchorPayerId}`,
    orgRole: anchorPayerId === ACCEPTER ? "owner" : "recruiter",
    acceptedAt: new Date("2026-06-01T00:00:00.000Z"),
    orgStatus: "active",
    anchorPayerId,
    anchorRole: "employer",
    anchorStatus: "active",
    memberRole: "employer",
    ...over,
  };
}

/** The transaction handle the fake `withTransaction` hands its callback (identity-compared). */
const TX = { tx: "payer-orgs" } as const;

function make(configOver: Record<string, unknown> = {}) {
  /** Every repository call and every event, in the order they happened (R65 ordering checks). */
  const order: string[] = [];
  const seen =
    <A extends unknown[], R>(name: string, impl: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      order.push(name);
      return impl(...args);
    };
  const orgs = {
    // R65: ONE transaction per invite / accept; the fake runs the work on TX and records it.
    withTransaction: vi.fn(
      seen("withTransaction", async (work: (tx: typeof TX) => Promise<unknown>) => work(TX)),
    ),
    lockPayerForMembership: vi.fn(
      seen("lockPayerForMembership", async (_tx: unknown, _id: string) => true),
    ),
    // The inviting org's anchor (invites are owner-only; the owner is the anchor).
    lockOrgAnchorForMembership: vi.fn(
      seen(
        "lockOrgAnchorForMembership",
        async (_tx: unknown, _orgId: string): Promise<string | null> => OWNER,
      ),
    ),
    // ADR-0053 §3.5 reads. Default: every payer has only their own solo org, the accepter anchors
    // no team, and the inviting org's anchor shares their vertical role — every invariant holds.
    listActiveMembershipsWithAnchor: vi.fn(
      seen("listActiveMembershipsWithAnchor", async (payerId: string, _tx?: unknown) => [
        membershipOf(payerId, { orgRole: "owner" }),
      ]),
    ),
    anchorsTeamOrg: vi.fn(seen("anchorsTeamOrg", async (_payerId: string, _tx?: unknown) => false)),
    findAnchorRole: vi.fn(
      seen(
        "findAnchorRole",
        async (_orgId: string, _tx?: unknown): Promise<"employer" | "agent" | null> => "employer",
      ),
    ),
    listMembers: vi.fn(async () => [memberRow()]),
    findMember: vi.fn(async () => memberRow({ orgRole: "recruiter", status: "invited" })),
    findActiveOrInvitedByEmail: vi.fn(
      seen("findActiveOrInvitedByEmail", async (..._args: unknown[]) => undefined as unknown),
    ),
    countActiveOrInvited: vi.fn(seen("countActiveOrInvited", async (..._args: unknown[]) => 1)),
    inviteMember: vi.fn(
      seen("inviteMember", async (input: Record<string, unknown>, _tx?: unknown) =>
        memberRow({ ...input, id: "mem-1" }),
      ),
    ),
    findByInviteTokenHash: vi.fn(async (_tokenHash: string, _now: Date) => memberRow()),
    acceptInvite: vi.fn(
      seen(
        "acceptInvite",
        async (_input: Record<string, unknown>, _tx?: unknown) =>
          memberRow({
            status: "active",
            memberPayerId: ACCEPTER,
            inviteTokenHash: null,
          }) as unknown,
      ),
    ),
    softRemoveMember: vi.fn(async () => memberRow({ status: "removed" })),
  };
  const events = {
    emit: vi.fn(
      seen(
        "emit",
        async (_evt: { event_name: string; payload: Record<string, unknown> }) => undefined,
      ),
    ),
  };
  const payers = {
    // The accepting payer's verified email hash matches the invite by default.
    findById: vi.fn(async (_id: string) => ({
      id: ACCEPTER,
      emailHash: `hmac<${EMAIL}>`,
      role: "employer",
    })),
  };
  const mailer = {
    send: vi.fn(seen("mail", async (_input: { email: string; acceptUrl: string }) => undefined)),
  };
  const config = {
    MEMBER_INVITE_MAX_PER_ORG: 25,
    MEMBER_INVITE_ACCEPT_URL: undefined,
    ...configOver,
  };
  const svc = new PayerOrgMembersService(
    orgs as never,
    pii as never,
    events as never,
    payers as never,
    config as never,
    mailer as never,
  );
  return { svc, orgs, events, payers, mailer, order };
}

/** The raw email/token must NEVER appear in any emitted event. */
function assertNoPiiInEvents(events: { emit: ReturnType<typeof vi.fn> }) {
  const blob = JSON.stringify(events.emit.mock.calls);
  expect(blob).not.toContain(EMAIL);
  expect(blob).not.toContain("acmestaffing");
  expect(blob).not.toContain(RAW_TOKEN);
}

describe("PayerOrgMembersService.list — faceless, masked", () => {
  it("masks the email (never the raw address) and flags the caller's own row", async () => {
    const d = make();
    d.orgs.listMembers.mockResolvedValueOnce([
      memberRow({ id: "mem-self", memberPayerId: OWNER, orgRole: "owner", status: "active" }),
      memberRow({ id: "mem-2", memberPayerId: "other", orgRole: "recruiter", status: "invited" }),
    ]);
    const out = await d.svc.list(ORG, OWNER);
    expect(out[0]).toMatchObject({ member_id: "mem-self", org_role: "owner", is_self: true });
    expect(out[1]).toMatchObject({ member_id: "mem-2", is_self: false });
    // Masked, never raw.
    expect(out[0]!.email_masked).toBe("h•••@acmestaffing.example");
    expect(JSON.stringify(out)).not.toContain(EMAIL);
  });
});

describe("PayerOrgMembersService.invite (owner-only via guard)", () => {
  let d: ReturnType<typeof make>;
  beforeEach(() => {
    d = make();
  });

  it("encrypts the email + stores only a token HASH, emits a PII-free payer_member.invited, and delivers via the mailer", async () => {
    const view = await d.svc.invite(ORG, OWNER, { email: EMAIL, org_role: "recruiter" }, CTX);
    const insert = d.orgs.inviteMember.mock.calls[0]![0];
    expect(insert.emailEnc).toBe(`enc<${EMAIL}>`);
    expect(insert.emailHash).toBe(`hmac<${EMAIL}>`);
    expect(insert.inviteTokenHash).toMatch(/^hmac</); // token stored as a HASH, not raw
    // Event carries ids + role enum only.
    const evt = d.events.emit.mock.calls[0]![0];
    expect(evt.event_name).toBe("payer_member.invited");
    expect(evt.payload).toEqual({
      member_id: "mem-1",
      org_id: "org-1",
      org_role: "recruiter",
      invited_by: OWNER,
    });
    expect(view.email_masked).toBe("h•••@acmestaffing.example");
    // The mailer is the ONLY place the raw email + accept link (raw token) appear.
    const delivery = d.mailer.send.mock.calls[0]![0];
    expect(delivery.email).toBe(EMAIL);
    expect(delivery.acceptUrl).toContain("token=");
    assertNoPiiInEvents(d.events);
  });

  it("rejects re-inviting an already ACTIVE member (409)", async () => {
    d.orgs.findActiveOrInvitedByEmail.mockResolvedValueOnce(
      memberRow({ status: "active" }) as never,
    );
    await expect(
      d.svc.invite(ORG, OWNER, { email: EMAIL, org_role: "recruiter" }, CTX),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(d.orgs.inviteMember).not.toHaveBeenCalled();
  });

  it("rejects a NEW seat once the per-org member cap is reached (409)", async () => {
    const c = make({ MEMBER_INVITE_MAX_PER_ORG: 2 });
    c.orgs.countActiveOrInvited.mockResolvedValueOnce(2);
    await expect(
      c.svc.invite(ORG, OWNER, { email: EMAIL, org_role: "recruiter" }, CTX),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(c.orgs.inviteMember).not.toHaveBeenCalled();
  });

  it("surfaces a delivery failure as 503 (the invite is still recorded + evented)", async () => {
    d.mailer.send.mockRejectedValueOnce(new Error("invite email delivery failed"));
    await expect(
      d.svc.invite(ORG, OWNER, { email: EMAIL, org_role: "recruiter" }, CTX),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(d.orgs.inviteMember).toHaveBeenCalled();
    expect(d.events.emit).toHaveBeenCalled();
  });
});

describe("PayerOrgMembersService.accept (any authed payer, single-use token)", () => {
  let d: ReturnType<typeof make>;
  beforeEach(() => {
    d = make();
  });

  it("activates the member, binds member_payer_id, and emits a PII-free payer_member.accepted", async () => {
    const view = await d.svc.accept(ACCEPTER, { token: RAW_TOKEN }, CTX);
    // Resolves by the token HASH (never the raw token), and consumes it via the guarded write.
    expect(d.orgs.findByInviteTokenHash.mock.calls[0]![0]).toBe(`hmac<${RAW_TOKEN}>`);
    expect(d.orgs.acceptInvite).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: "mem-1", memberPayerId: ACCEPTER }),
      TX,
    );
    const evt = d.events.emit.mock.calls[0]![0];
    expect(evt.event_name).toBe("payer_member.accepted");
    expect(evt.payload).toEqual({ member_id: "mem-1", org_id: "org-1", member_payer_id: ACCEPTER });
    expect(view.status).toBe("active");
    assertNoPiiInEvents(d.events);
  });

  it("404s a missing/expired/consumed token (no-oracle)", async () => {
    d.orgs.findByInviteTokenHash.mockResolvedValueOnce(undefined as never);
    await expect(d.svc.accept(ACCEPTER, { token: RAW_TOKEN }, CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(d.orgs.acceptInvite).not.toHaveBeenCalled();
  });

  it("403s when the invite email does not match the accepting account", async () => {
    d.payers.findById.mockResolvedValueOnce({
      id: ACCEPTER,
      emailHash: "hmac<someone@else.example>",
    } as never);
    await expect(d.svc.accept(ACCEPTER, { token: RAW_TOKEN }, CTX)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(d.orgs.acceptInvite).not.toHaveBeenCalled();
  });

  it("409s when the guarded accept write is a no-op (double-accept / raced expiry)", async () => {
    d.orgs.acceptInvite.mockResolvedValueOnce(undefined as never);
    await expect(d.svc.accept(ACCEPTER, { token: RAW_TOKEN }, CTX)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe("PayerOrgMembersService.accept — ADR-0053 §3.5 membership invariants", () => {
  let d: ReturnType<typeof make>;
  beforeEach(() => {
    d = make();
  });

  /** Accept, expecting the ONE neutral refusal; returns the body for byte comparison. */
  async function refused(): Promise<unknown> {
    const err = await d.svc.accept(ACCEPTER, { token: RAW_TOKEN }, CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    const body = (err as ConflictException).getResponse();
    expect(JSON.stringify(body)).toContain(INVITE_NOT_ACCEPTABLE_MESSAGE);
    // A refusal writes nothing: the token is consumed ONLY by the guarded accept write, which
    // never ran, and nothing reached the spine (an accept is evented only on success).
    expect(d.orgs.acceptInvite).not.toHaveBeenCalled();
    expect(d.events.emit).not.toHaveBeenCalled();
    return body;
  }

  it("the happy path reads all three facts for the ACCEPTER and the inviting org", async () => {
    await d.svc.accept(ACCEPTER, { token: RAW_TOKEN }, CTX);
    expect(d.orgs.listActiveMembershipsWithAnchor).toHaveBeenCalledWith(ACCEPTER, TX);
    expect(d.orgs.anchorsTeamOrg).toHaveBeenCalledWith(ACCEPTER, TX);
    expect(d.orgs.findAnchorRole).toHaveBeenCalledWith("org-1", TX);
    expect(d.orgs.acceptInvite).toHaveBeenCalledTimes(1);
  });

  it("A1: an active member of another org's team cannot accept a second team invite", async () => {
    d.orgs.listActiveMembershipsWithAnchor.mockResolvedValueOnce([
      membershipOf(ACCEPTER),
      membershipOf(OWNER_ELSEWHERE),
    ]);
    await refused();
  });

  it("A1 counts only TEAM memberships: the accepter's own solo org is not one", async () => {
    // The default read is exactly the solo org; a recruiter role on it (never real) or a second
    // solo-anchored row must not read as "already in a team".
    d.orgs.listActiveMembershipsWithAnchor.mockResolvedValueOnce([
      membershipOf(ACCEPTER, { orgRole: "recruiter" }),
    ]);
    await expect(d.svc.accept(ACCEPTER, { token: RAW_TOKEN }, CTX)).resolves.toMatchObject({
      status: "active",
    });
  });

  it("A2: the anchor of a team org (another non-removed member) cannot join another org", async () => {
    d.orgs.anchorsTeamOrg.mockResolvedValueOnce(true);
    await refused();
  });

  it("A3 (O-9): the accepter's vertical role must equal the inviting org's anchor role", async () => {
    d.orgs.findAnchorRole.mockResolvedValueOnce("agent");
    await refused();
  });

  it("A3 fails CLOSED when the inviting org's anchor role cannot be read", async () => {
    d.orgs.findAnchorRole.mockResolvedValueOnce(null);
    await refused();
  });

  it("an agent accepting an agency org's invite is admitted (A3 compares, it does not pin employer)", async () => {
    d.payers.findById.mockResolvedValueOnce({
      id: ACCEPTER,
      emailHash: `hmac<${EMAIL}>`,
      role: "agent",
    } as never);
    d.orgs.listActiveMembershipsWithAnchor.mockResolvedValueOnce([
      membershipOf(ACCEPTER, { anchorRole: "agent", memberRole: "agent" }),
    ]);
    d.orgs.findAnchorRole.mockResolvedValueOnce("agent");
    await expect(d.svc.accept(ACCEPTER, { token: RAW_TOKEN }, CTX)).resolves.toMatchObject({
      status: "active",
    });
  });

  it("all three refusals are the SAME body (no rule-name oracle)", async () => {
    d.orgs.listActiveMembershipsWithAnchor.mockResolvedValueOnce([membershipOf(OWNER_ELSEWHERE)]);
    const a1 = await refused();
    d = make();
    d.orgs.anchorsTeamOrg.mockResolvedValueOnce(true);
    const a2 = await refused();
    d = make();
    d.orgs.findAnchorRole.mockResolvedValueOnce("agent");
    const a3 = await refused();
    expect(a2).toEqual(a1);
    expect(a3).toEqual(a1);
  });

  it("the invariants are read only AFTER the invite is proven the caller's (token + email)", async () => {
    // A caller holding someone else's token learns nothing about the invariants: they get the
    // existing 403, and the tenancy facts are never read on their behalf.
    d.payers.findById.mockResolvedValueOnce({
      id: ACCEPTER,
      emailHash: "hmac<someone@else.example>",
      role: "employer",
    } as never);
    d.orgs.anchorsTeamOrg.mockResolvedValueOnce(true);
    await expect(d.svc.accept(ACCEPTER, { token: RAW_TOKEN }, CTX)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(d.orgs.listActiveMembershipsWithAnchor).not.toHaveBeenCalled();
    expect(d.orgs.anchorsTeamOrg).not.toHaveBeenCalled();
    expect(d.orgs.findAnchorRole).not.toHaveBeenCalled();
  });
});

/**
 * Risk R65 (ADR-0053 §3.5; ORG_TENANCY_PLAN §5 item 5). A1/A2 are check-then-write, so the reads
 * and the write must run in ONE transaction that FIRST takes the membership lock: the accepter's
 * row on accept, the inviting org's ANCHOR's row on invite (the same row an accept by that anchor
 * locks). These pin the ORDER and the handle; `payer-org-tenancy.db.test.ts` ("R65") races the
 * real thing against Postgres.
 */
describe("PayerOrgMembersService — R65: the A-rule checks and the write run under one membership lock", () => {
  let d: ReturnType<typeof make>;
  beforeEach(() => {
    d = make();
  });

  it("accept: one transaction; the ACCEPTER's lock comes first, then A1–A3 and the write, all on that transaction; the event follows", async () => {
    await d.svc.accept(ACCEPTER, { token: RAW_TOKEN }, CTX);
    expect(d.order).toEqual([
      "withTransaction",
      "lockPayerForMembership",
      "listActiveMembershipsWithAnchor",
      "anchorsTeamOrg",
      "findAnchorRole",
      "acceptInvite",
      "emit",
    ]);
    expect(d.orgs.withTransaction).toHaveBeenCalledTimes(1);
    expect(d.orgs.lockPayerForMembership).toHaveBeenCalledWith(TX, ACCEPTER);
    expect(d.orgs.acceptInvite.mock.calls[0]![1]).toBe(TX);
  });

  it("accept: a refusal decided under the lock writes nothing and emits nothing", async () => {
    d.orgs.anchorsTeamOrg.mockImplementationOnce(async () => {
      d.order.push("anchorsTeamOrg");
      return true;
    });
    await expect(d.svc.accept(ACCEPTER, { token: RAW_TOKEN }, CTX)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(d.order).toEqual([
      "withTransaction",
      "lockPayerForMembership",
      "listActiveMembershipsWithAnchor",
      "anchorsTeamOrg",
    ]);
  });

  it("accept: an accepter whose payers row is gone under the lock is refused (403); nothing is read or written", async () => {
    d.orgs.lockPayerForMembership.mockResolvedValueOnce(false);
    await expect(d.svc.accept(ACCEPTER, { token: RAW_TOKEN }, CTX)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(d.orgs.listActiveMembershipsWithAnchor).not.toHaveBeenCalled();
    expect(d.orgs.acceptInvite).not.toHaveBeenCalled();
    expect(d.events.emit).not.toHaveBeenCalled();
  });

  it("invite: one transaction; the org ANCHOR's lock comes first (derived from the org), then the checks and the insert on that transaction; event and mail follow", async () => {
    await d.svc.invite(ORG, OWNER, { email: EMAIL, org_role: "recruiter" }, CTX);
    expect(d.order).toEqual([
      "withTransaction",
      "lockOrgAnchorForMembership",
      "listActiveMembershipsWithAnchor",
      "findActiveOrInvitedByEmail",
      "countActiveOrInvited",
      "inviteMember",
      "emit",
      "mail",
    ]);
    expect(d.orgs.lockOrgAnchorForMembership).toHaveBeenCalledWith(TX, ORG.orgId);
    // The membership read is the ANCHOR's (the locked row), not the caller's by assumption.
    expect(d.orgs.listActiveMembershipsWithAnchor).toHaveBeenCalledWith(OWNER, TX);
    expect(d.orgs.findActiveOrInvitedByEmail.mock.calls[0]![2]).toBe(TX);
    expect(d.orgs.countActiveOrInvited.mock.calls[0]![1]).toBe(TX);
    expect(d.orgs.inviteMember.mock.calls[0]![1]).toBe(TX);
  });

  it("invite: an anchor who has JOINED another org's team cannot grow a team of their own — neutral 409, nothing written, no event, no mail (A2 from the invite side)", async () => {
    d.orgs.listActiveMembershipsWithAnchor.mockResolvedValueOnce([
      membershipOf(OWNER, { orgRole: "owner" }),
      membershipOf(OWNER_ELSEWHERE),
    ]);
    const err = await d.svc
      .invite(ORG, OWNER, { email: EMAIL, org_role: "recruiter" }, CTX)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(JSON.stringify((err as ConflictException).getResponse())).toContain(
      INVITE_NOT_SENDABLE_MESSAGE,
    );
    expect(d.orgs.inviteMember).not.toHaveBeenCalled();
    expect(d.events.emit).not.toHaveBeenCalled();
    expect(d.mailer.send).not.toHaveBeenCalled();
  });

  it("invite: an org that no longer resolves to an anchor is refused the same way (fail closed)", async () => {
    d.orgs.lockOrgAnchorForMembership.mockResolvedValueOnce(null);
    await expect(
      d.svc.invite(ORG, OWNER, { email: EMAIL, org_role: "recruiter" }, CTX),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(d.orgs.inviteMember).not.toHaveBeenCalled();
    expect(d.events.emit).not.toHaveBeenCalled();
    expect(d.mailer.send).not.toHaveBeenCalled();
  });
});

describe("PayerOrgMembersService.remove (owner-only via guard, soft-delete)", () => {
  let d: ReturnType<typeof make>;
  beforeEach(() => {
    d = make();
  });

  it("soft-removes a recruiter and emits a PII-free payer_member.removed", async () => {
    const out = await d.svc.remove(ORG, OWNER, "mem-1", CTX);
    expect(out).toEqual({ member_id: "mem-1", status: "removed" });
    const evt = d.events.emit.mock.calls[0]![0];
    expect(evt.event_name).toBe("payer_member.removed");
    expect(evt.payload).toEqual({ member_id: "mem-1", org_id: "org-1", removed_by: OWNER });
    assertNoPiiInEvents(d.events);
  });

  it("404s for an unknown OR another org's member (no-oracle)", async () => {
    d.orgs.findMember.mockResolvedValueOnce(undefined as never);
    await expect(d.svc.remove(ORG, OWNER, "ghost", CTX)).rejects.toBeInstanceOf(NotFoundException);
    expect(d.orgs.softRemoveMember).not.toHaveBeenCalled();
  });

  it("refuses to remove an owner (409)", async () => {
    d.orgs.findMember.mockResolvedValueOnce(
      memberRow({ orgRole: "owner", status: "active" }) as never,
    );
    await expect(d.svc.remove(ORG, OWNER, "mem-owner", CTX)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(d.orgs.softRemoveMember).not.toHaveBeenCalled();
  });
});
