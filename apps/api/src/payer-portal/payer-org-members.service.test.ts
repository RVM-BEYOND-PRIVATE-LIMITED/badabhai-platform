import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { PayerOrgMembersService } from "./payer-org-members.service";
import type { ResolvedOrg } from "../payers/payer-orgs.repository";

const ORG: ResolvedOrg = { orgId: "org-1", orgRole: "owner" };
const OWNER = "aaaaaaaa-0000-4000-8000-000000000001";
const CTX = { correlationId: "11111111-1111-4111-8111-111111111111", requestId: "req-1" };
const EMAIL = "hire@acmestaffing.example";

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
    inviteTokenHash: "hmac<tok>",
    inviteExpiresAt: new Date("2026-07-08T00:00:00.000Z"),
    invitedAt: new Date("2026-07-01T00:00:00.000Z"),
    acceptedAt: null,
    removedAt: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    ...over,
  };
}

function make() {
  const orgs = {
    listMembers: vi.fn(async () => [memberRow()]),
    findMember: vi.fn(async () => memberRow({ orgRole: "recruiter", status: "invited" })),
    findActiveOrInvitedByEmail: vi.fn(async () => undefined),
    inviteMember: vi.fn(async (input: Record<string, unknown>) => memberRow({ ...input, id: "mem-1" })),
    softRemoveMember: vi.fn(async () => memberRow({ status: "removed" })),
  };
  const events = {
    emit: vi.fn(
      async (_evt: { event_name: string; payload: Record<string, unknown> }) => undefined,
    ),
  };
  const svc = new PayerOrgMembersService(orgs as never, pii as never, events as never);
  return { svc, orgs, events };
}

/** The raw email/token must NEVER appear in any emitted event. */
function assertNoPiiInEvents(events: { emit: ReturnType<typeof vi.fn> }) {
  const blob = JSON.stringify(events.emit.mock.calls);
  expect(blob).not.toContain(EMAIL);
  expect(blob).not.toContain("acmestaffing");
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

describe("PayerOrgMembersService.invite (MOCK, owner-only via guard)", () => {
  let d: ReturnType<typeof make>;
  beforeEach(() => {
    d = make();
  });

  it("encrypts the email + stores only a token HASH, and emits a PII-free payer_member.invited", async () => {
    const view = await d.svc.invite(ORG, OWNER, { email: EMAIL, org_role: "recruiter" }, CTX);
    // Persisted email is ciphertext + keyed hash; the token is stored as a hash, never raw.
    const insert = d.orgs.inviteMember.mock.calls[0]![0];
    // The service ENCRYPTS the email (pii.encrypt) + stores a keyed hash — never plaintext in a
    // raw column (the ciphertext being opaque is PiiCryptoService's guarantee; here the fake
    // crypto is deliberately reversible so decrypt works, so we assert the ENCRYPT was called).
    expect(insert.emailEnc).toBe(`enc<${EMAIL}>`);
    expect(insert.emailHash).toBe(`hmac<${EMAIL}>`);
    expect(insert.inviteTokenHash).toMatch(/^hmac</); // token stored as a HASH, not raw
    // Event carries ids + role enum only.
    const evt = d.events.emit.mock.calls[0]![0];
    expect(evt.event_name).toBe("payer_member.invited");
    expect(evt.payload).toEqual({ member_id: "mem-1", org_id: "org-1", org_role: "recruiter", invited_by: OWNER });
    expect(view.email_masked).toBe("h•••@acmestaffing.example");
    assertNoPiiInEvents(d.events);
  });

  it("rejects re-inviting an already ACTIVE member (409)", async () => {
    d.orgs.findActiveOrInvitedByEmail.mockResolvedValueOnce(memberRow({ status: "active" }) as never);
    await expect(
      d.svc.invite(ORG, OWNER, { email: EMAIL, org_role: "recruiter" }, CTX),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(d.orgs.inviteMember).not.toHaveBeenCalled();
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
    d.orgs.findMember.mockResolvedValueOnce(memberRow({ orgRole: "owner", status: "active" }) as never);
    await expect(d.svc.remove(ORG, OWNER, "mem-owner", CTX)).rejects.toBeInstanceOf(ConflictException);
    expect(d.orgs.softRemoveMember).not.toHaveBeenCalled();
  });
});
