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
    pauseForPayer: vi.fn(async () => ({ id: POSTING })),
    resumeForPayer: vi.fn(async () => ({ id: POSTING })),
  };
  const plans = {
    buyPlanForPayer: vi.fn(
      async (_id: string, _payerId: string, _dto: unknown, _ctx: unknown) => ({
        plan: { id: "plan-1" },
      }),
    ),
    buyBoostForPayer: vi.fn(
      async (_id: string, _payerId: string, _dto: unknown, _ctx: unknown) => ({
        boost: { id: "boost-1" },
      }),
    ),
  };
  const ctrl = new PayerJobPostingsController(jobPostings as never, plans as never);
  return { ctrl, jobPostings, plans };
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

  it("pause forwards the SESSION payer as the ownership key (B1)", async () => {
    await d.ctrl.pause(POSTING, PAYER_A, CTX);
    expect(d.jobPostings.pauseForPayer).toHaveBeenCalledWith(POSTING, PAYER_A.id, CTX);
  });

  it("resume forwards the SESSION payer as the ownership key (B1)", async () => {
    await d.ctrl.resume(POSTING, PAYER_B, CTX);
    expect(d.jobPostings.resumeForPayer).toHaveBeenCalledWith(POSTING, PAYER_B.id, CTX);
  });
});

/**
 * B3 / LC-1: the payer-authed money routes (buy-plan / buy-boost). The `payer_id` is the
 * SESSION payer (never the body), and OWNERSHIP is asserted via `getOneForPayer` BEFORE any
 * purchase. Proves a payer can only buy against their OWN posting and can never inject another
 * payer's id — the IDOR guarantee the ops routes lacked.
 */
describe("PayerJobPostingsController — buy plan/boost is session-scoped + ownership-gated (B3/LC-1)", () => {
  let d: ReturnType<typeof makeCtrl>;
  beforeEach(() => {
    d = makeCtrl();
  });

  it("buyPlan checks ownership FIRST, then buys with the SESSION payer id (no body payer_id)", async () => {
    const dto = { tier: "standard" as const };
    await d.ctrl.buyPlan(POSTING, dto, PAYER_A, CTX);
    expect(d.jobPostings.getOneForPayer).toHaveBeenCalledWith(POSTING, PAYER_A.id);
    expect(d.plans.buyPlanForPayer).toHaveBeenCalledWith(POSTING, PAYER_A.id, dto, CTX);
    // The service is only reached AFTER the ownership read resolves.
    expect(d.jobPostings.getOneForPayer.mock.invocationCallOrder[0]!).toBeLessThan(
      d.plans.buyPlanForPayer.mock.invocationCallOrder[0]!,
    );
    // No payer_id is ever forwarded from the controller (it isn't in the payer DTO).
    expect(d.plans.buyPlanForPayer.mock.calls[0]![2]).not.toHaveProperty("payer_id");
  });

  it("buyBoost checks ownership FIRST, then buys with the SESSION payer id", async () => {
    const dto = { tier: "all_candidates" as const };
    await d.ctrl.buyBoost(POSTING, dto, PAYER_B, CTX);
    expect(d.jobPostings.getOneForPayer).toHaveBeenCalledWith(POSTING, PAYER_B.id);
    expect(d.plans.buyBoostForPayer).toHaveBeenCalledWith(POSTING, PAYER_B.id, dto, CTX);
    expect(d.plans.buyBoostForPayer.mock.calls[0]![2]).not.toHaveProperty("payer_id");
  });

  it("buyPlan on an unknown OR foreign posting (404) NEVER reaches the money path", async () => {
    d.jobPostings.getOneForPayer.mockRejectedValueOnce(new Error("Job posting not found"));
    await expect(d.ctrl.buyPlan(POSTING, { tier: "pro" }, PAYER_A, CTX)).rejects.toThrow();
    expect(d.plans.buyPlanForPayer).not.toHaveBeenCalled();
  });

  it("buyBoost on an unknown OR foreign posting (404) NEVER reaches the money path", async () => {
    d.jobPostings.getOneForPayer.mockRejectedValueOnce(new Error("Job posting not found"));
    await expect(
      d.ctrl.buyBoost(POSTING, { tier: "all_candidates" }, PAYER_A, CTX),
    ).rejects.toThrow();
    expect(d.plans.buyBoostForPayer).not.toHaveBeenCalled();
  });
});
