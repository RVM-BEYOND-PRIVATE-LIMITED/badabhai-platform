import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PayerJobPostingsController } from "./payer-job-postings.controller";
import type { AuthenticatedPayer } from "../payers/payer-auth.guard";
import type { PayerOrgContext } from "../payers/payer-org-role.guard";
import type { RequestContext } from "../common/request-context";

// job-postings is a SHARED demand surface (any payer role); cover both an agent and an
// employer session. `role` is required on AuthenticatedPayer since the ADR-0022 role claim.
const PAYER_A: AuthenticatedPayer = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  sid: "sid-a",
  role: "agent",
};
const PAYER_B: AuthenticatedPayer = {
  id: "bbbbbbbb-0000-4000-8000-000000000002",
  sid: "sid-b",
  role: "employer",
};
// ADR-0027 B5.x Inc 1: ownership is the caller's ORG (resolved server-side by
// PayerOrgRoleGuard, surfaced via @CurrentOrg) — the controller forwards org.orgId
// (never a body/param value) as the ownership key, and the SESSION payer id alongside.
const ORG_A: PayerOrgContext = { orgId: "0a0a0a0a-0000-4000-8000-00000000000a", orgRole: "owner" };
const ORG_B: PayerOrgContext = {
  orgId: "0b0b0b0b-0000-4000-8000-00000000000b",
  orgRole: "recruiter",
};
const CTX: RequestContext = {
  correlationId: "11111111-1111-4111-8111-111111111111",
  requestId: "req-1",
};
const POSTING = "cccccccc-0000-4000-8000-000000000003";

function makeCtrl() {
  const jobPostings = {
    createForPayer: vi.fn(
      async (_orgId: string, _payerId: string, _dto: unknown, _ctx: unknown) => ({
        id: POSTING,
      }),
    ),
    listForPayer: vi.fn(async () => []),
    getOneForPayer: vi.fn(async () => ({ id: POSTING })),
    updateForPayer: vi.fn(async () => ({ id: POSTING })),
    closeForPayer: vi.fn(async () => ({ id: POSTING })),
  };
  const ctrl = new PayerJobPostingsController(jobPostings as never);
  return { ctrl, jobPostings };
}

/**
 * XB-A at the payer posting boundary: OWNERSHIP is the SESSION-resolved ORG
 * (`@CurrentOrg().orgId`); the SESSION payer id rides alongside for the create actor /
 * created_by. The body/query never supplies an `org_id`, `payer_id`, or `created_by`.
 * Proves a member cannot create-for / read / mutate another ORG's postings from the edge
 * — the org-scoped reads/writes + no-oracle 404 are proven in job-postings.service.test.ts.
 */
describe("PayerJobPostingsController — ownership is the session ORG, never the body (ADR-0027 B5.x Inc 1)", () => {
  let d: ReturnType<typeof makeCtrl>;
  beforeEach(() => {
    d = makeCtrl();
  });

  it("create stamps the session ORG as owner AND the session payer as creator (DTO carries neither id)", async () => {
    const dto = { org_label: "Acme", role_title: "VMC Operator", vacancy_band: "2-5" as const };
    await d.ctrl.create(dto, ORG_A, PAYER_A, CTX);
    // org_id (ownership) first, then the session payer id (actor / created_by).
    expect(d.jobPostings.createForPayer).toHaveBeenCalledWith(ORG_A.orgId, PAYER_A.id, dto, CTX);
    // Neither created_by nor payer_id/org_id is ever forwarded FROM the DTO body.
    expect(d.jobPostings.createForPayer.mock.calls[0]![2]).not.toHaveProperty("created_by");
    expect(d.jobPostings.createForPayer.mock.calls[0]![2]).not.toHaveProperty("payer_id");
    expect(d.jobPostings.createForPayer.mock.calls[0]![2]).not.toHaveProperty("org_id");
  });

  it("list scopes to the session ORG (not the payer)", async () => {
    await d.ctrl.list({ status: "open" }, ORG_B);
    expect(d.jobPostings.listForPayer).toHaveBeenCalledWith(ORG_B.orgId, { status: "open" });
    expect(d.jobPostings.listForPayer).not.toHaveBeenCalledWith(ORG_A.orgId, expect.anything());
  });

  it("getOne forwards the session ORG as the ownership key", async () => {
    await d.ctrl.getOne(POSTING, ORG_A);
    expect(d.jobPostings.getOneForPayer).toHaveBeenCalledWith(POSTING, ORG_A.orgId);
  });

  it("update forwards the session ORG as the ownership key + the session payer as actor", async () => {
    const dto = { role_title: "CNC Operator" };
    await d.ctrl.update(POSTING, dto, ORG_A, PAYER_A, CTX);
    expect(d.jobPostings.updateForPayer).toHaveBeenCalledWith(
      POSTING,
      ORG_A.orgId,
      PAYER_A.id,
      dto,
      CTX,
    );
  });

  it("close forwards the session ORG as the ownership key + the session payer as actor", async () => {
    await d.ctrl.close(POSTING, ORG_A, PAYER_A, CTX);
    expect(d.jobPostings.closeForPayer).toHaveBeenCalledWith(
      POSTING,
      ORG_A.orgId,
      PAYER_A.id,
      CTX,
    );
  });

  it("two DIFFERENT payers of the SAME org resolve the SAME ownership key (shared-org)", async () => {
    // ORG_A is the caller's resolved org regardless of WHICH member calls — so an owner
    // (PAYER_A) and a recruiter (PAYER_B) acting in ORG_A both scope every write to
    // ORG_A.orgId (the ownership key), differing only as the opaque event actor.
    await d.ctrl.update(POSTING, { role_title: "CNC Operator" }, ORG_A, PAYER_A, CTX);
    await d.ctrl.update(POSTING, { role_title: "VMC Operator" }, ORG_A, PAYER_B, CTX);
    // Both edits scope to the SAME org; only the (payer) actor differs.
    expect(d.jobPostings.updateForPayer).toHaveBeenNthCalledWith(
      1,
      POSTING,
      ORG_A.orgId,
      PAYER_A.id,
      { role_title: "CNC Operator" },
      CTX,
    );
    expect(d.jobPostings.updateForPayer).toHaveBeenNthCalledWith(
      2,
      POSTING,
      ORG_A.orgId,
      PAYER_B.id,
      { role_title: "VMC Operator" },
      CTX,
    );
  });
});
