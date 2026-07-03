import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PayerOrgMembersController } from "./payer-org-members.controller";
import type { AuthenticatedPayer } from "../payers/payer-auth.guard";
import type { PayerOrgContext } from "../payers/payer-org-role.guard";
import type { RequestContext } from "../common/request-context";

const PAYER: AuthenticatedPayer = { id: "aaaaaaaa-0000-4000-8000-000000000001", sid: "sid", role: "employer" };
const ORG: PayerOrgContext = { orgId: "org-1", orgRole: "owner" };
const CTX: RequestContext = { correlationId: "11111111-1111-4111-8111-111111111111", requestId: "req-1" };
const MEMBER = "cccccccc-0000-4000-8000-000000000003";

function makeCtrl() {
  const members = {
    list: vi.fn(async (_org: unknown, _payerId: string) => []),
    invite: vi.fn(async (_org: unknown, _payerId: string, _dto: unknown, _ctx: unknown) => ({
      member_id: "mem-1",
    })),
    remove: vi.fn(async (_org: unknown, _payerId: string, _id: string, _ctx: unknown) => ({
      member_id: MEMBER,
      status: "removed",
    })),
  };
  const ctrl = new PayerOrgMembersController(members as never);
  return { ctrl, members };
}

/**
 * XB-A at the org-member boundary: every action binds to the SESSION payer + the RESOLVED org
 * (`@CurrentOrg`, from the verified membership) — the body/param never supplies an org_id or
 * invited_by. So a payer can only ever read/mutate THEIR OWN org's members.
 */
describe("PayerOrgMembersController — org + actor from the session, never the body", () => {
  let d: ReturnType<typeof makeCtrl>;
  beforeEach(() => {
    d = makeCtrl();
  });

  it("list forwards the resolved org + the session payer", async () => {
    await d.ctrl.list(ORG, PAYER);
    expect(d.members.list).toHaveBeenCalledWith(ORG, PAYER.id);
  });

  it("invite forwards the resolved org + session actor; the DTO carries no org_id/invited_by", async () => {
    const dto = { email: "hire@acme.example", org_role: "recruiter" as const };
    await d.ctrl.invite(dto, ORG, PAYER, CTX);
    expect(d.members.invite).toHaveBeenCalledWith(ORG, PAYER.id, dto, CTX);
    expect(d.members.invite.mock.calls[0]![2]).not.toHaveProperty("org_id");
    expect(d.members.invite.mock.calls[0]![2]).not.toHaveProperty("invited_by");
  });

  it("remove forwards the resolved org + session actor + the path member id", async () => {
    await d.ctrl.remove(MEMBER, ORG, PAYER, CTX);
    expect(d.members.remove).toHaveBeenCalledWith(ORG, PAYER.id, MEMBER, CTX);
  });
});
