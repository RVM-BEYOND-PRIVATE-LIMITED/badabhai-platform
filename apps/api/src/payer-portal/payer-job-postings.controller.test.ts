import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PayerJobPostingsController } from "./payer-job-postings.controller";
import type { AuthenticatedPayer } from "../payers/payer-auth.guard";
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
const CTX: RequestContext = {
  correlationId: "11111111-1111-4111-8111-111111111111",
  requestId: "req-1",
};
const POSTING = "cccccccc-0000-4000-8000-000000000003";

function makeCtrl() {
  const jobPostings = {
    createForPayer: vi.fn(async (_payerId: string, _dto: unknown, _ctx: unknown) => ({
      id: POSTING,
    })),
    listForPayer: vi.fn(async () => []),
    getOneForPayer: vi.fn(async () => ({ id: POSTING })),
    updateForPayer: vi.fn(async () => ({ id: POSTING })),
    closeForPayer: vi.fn(async () => ({ id: POSTING })),
  };
  const ctrl = new PayerJobPostingsController(jobPostings as never);
  return { ctrl, jobPostings };
}

/**
 * XB-A at the payer posting boundary: every action is bound to the SESSION payer
 * (`req.payer.id`); the body/query never supplies a `payer_id` or `created_by`. Proves
 * a payer cannot create-for / read / mutate another payer's postings from the edge —
 * the owner-scoped reads/writes + no-oracle 404 are proven in job-postings.service.test.ts.
 */
describe("PayerJobPostingsController — identity from the session, never the body (ADR-0019 XB-A)", () => {
  let d: ReturnType<typeof makeCtrl>;
  beforeEach(() => {
    d = makeCtrl();
  });

  it("create stamps the SESSION payer as owner (the DTO carries no created_by / payer_id)", async () => {
    const dto = { org_label: "Acme", role_title: "VMC Operator", vacancy_band: "2-5" as const };
    await d.ctrl.create(dto, PAYER_A, CTX);
    expect(d.jobPostings.createForPayer).toHaveBeenCalledWith(PAYER_A.id, dto, CTX);
    // No created_by/payer_id is ever forwarded from the controller (they aren't in the DTO).
    expect(d.jobPostings.createForPayer.mock.calls[0]![1]).not.toHaveProperty("created_by");
    expect(d.jobPostings.createForPayer.mock.calls[0]![1]).not.toHaveProperty("payer_id");
  });

  it("list scopes to the SESSION payer", async () => {
    await d.ctrl.list({ status: "open" }, PAYER_B);
    expect(d.jobPostings.listForPayer).toHaveBeenCalledWith(PAYER_B.id, { status: "open" });
    expect(d.jobPostings.listForPayer).not.toHaveBeenCalledWith(PAYER_A.id, expect.anything());
  });

  it("getOne forwards the SESSION payer as the ownership key", async () => {
    await d.ctrl.getOne(POSTING, PAYER_A);
    expect(d.jobPostings.getOneForPayer).toHaveBeenCalledWith(POSTING, PAYER_A.id);
  });

  it("update forwards the SESSION payer as the ownership key", async () => {
    const dto = { role_title: "CNC Operator" };
    await d.ctrl.update(POSTING, dto, PAYER_A, CTX);
    expect(d.jobPostings.updateForPayer).toHaveBeenCalledWith(POSTING, PAYER_A.id, dto, CTX);
  });

  it("close forwards the SESSION payer as the ownership key", async () => {
    await d.ctrl.close(POSTING, PAYER_A, CTX);
    expect(d.jobPostings.closeForPayer).toHaveBeenCalledWith(POSTING, PAYER_A.id, CTX);
  });
});
