import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PayerOrgInvitesController } from "./payer-org-invites.controller";
import type { AuthenticatedPayer } from "../payers/payer-auth.guard";
import type { RequestContext } from "../common/request-context";

const PAYER: AuthenticatedPayer = { id: "bbbbbbbb-0000-4000-8000-000000000002", sid: "sid", role: "employer" };
const CTX: RequestContext = { correlationId: "11111111-1111-4111-8111-111111111111", requestId: "req-1" };

function makeCtrl() {
  const members = {
    accept: vi.fn(async (_payerId: string, _dto: unknown, _ctx: unknown) => ({
      member_id: "mem-1",
      status: "active",
    })),
  };
  const ctrl = new PayerOrgInvitesController(members as never);
  return { ctrl, members };
}

/**
 * XB-A at the accept boundary: the accepting principal is the SESSION payer (`@CurrentPayer`),
 * never a body value; the body carries only the single-use token (no org_id / member_id).
 */
describe("PayerOrgInvitesController — actor from the session, org from the token", () => {
  let d: ReturnType<typeof makeCtrl>;
  beforeEach(() => {
    d = makeCtrl();
  });

  it("forwards the session payer + the token; the DTO carries no org_id/member_id", async () => {
    const dto = { token: "tok-raw-0123456789abcdef" };
    await d.ctrl.accept(dto, PAYER, CTX);
    expect(d.members.accept).toHaveBeenCalledWith(PAYER.id, dto, CTX);
    expect(d.members.accept.mock.calls[0]![1]).not.toHaveProperty("org_id");
    expect(d.members.accept.mock.calls[0]![1]).not.toHaveProperty("member_id");
  });
});
