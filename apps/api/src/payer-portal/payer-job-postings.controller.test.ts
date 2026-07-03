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
    pauseForPayer: vi.fn(
      async (_id: string, _orgId: string, _payerId: string, _ctx: unknown) => ({ id: POSTING }),
    ),
    resumeForPayer: vi.fn(
      async (_id: string, _orgId: string, _payerId: string, _ctx: unknown) => ({ id: POSTING }),
    ),
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
    topUpQuotaForPayer: vi.fn(
      async (_id: string, _payerId: string, _dto: unknown, _ctx: unknown) => ({
        plan: { id: "plan-1", quotaTopupCount: 10 },
      }),
    ),
  };
  const ctrl = new PayerJobPostingsController(jobPostings as never, plans as never);
  return { ctrl, jobPostings, plans };
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

  it("pause forwards the session ORG as the ownership key + the session payer as actor (B1; Inc 3)", async () => {
    await d.ctrl.pause(POSTING, ORG_A, PAYER_A, CTX);
    expect(d.jobPostings.pauseForPayer).toHaveBeenCalledWith(POSTING, ORG_A.orgId, PAYER_A.id, CTX);
  });

  it("resume forwards the session ORG as the ownership key + the session payer as actor (B1; Inc 3)", async () => {
    await d.ctrl.resume(POSTING, ORG_B, PAYER_B, CTX);
    expect(d.jobPostings.resumeForPayer).toHaveBeenCalledWith(POSTING, ORG_B.orgId, PAYER_B.id, CTX);
  });
});

/**
 * B3 / LC-1 → ADR-0027 B5.x Inc 3: the payer-authed money routes (buy-plan / buy-boost).
 * OWNERSHIP is asserted via `getOneForPayer(id, org.orgId)` BEFORE any purchase — this is the
 * MERGE-BREAK FIX: the controller previously passed `payer.id` (≠ org_id) into the org-scoped
 * `getOneForPayer`, which ALWAYS 404'd. The `payer_id` forwarded to the service stays the
 * SESSION payer (the service resolves the SAME org from it). Proves a member can only buy
 * against their OWN org's posting and can never inject another payer's/org's id.
 */
describe("PayerJobPostingsController — buy plan/boost is org-ownership-gated + session-payer-scoped (B3/LC-1, Inc 3 merge-break fix)", () => {
  let d: ReturnType<typeof makeCtrl>;
  beforeEach(() => {
    d = makeCtrl();
  });

  it("buyPlan checks ownership on the ORG key FIRST (the fix), then buys with the SESSION payer id", async () => {
    const dto = { tier: "standard" as const };
    await d.ctrl.buyPlan(POSTING, dto, ORG_A, PAYER_A, CTX);
    // THE FIX: the ownership read keys on org.orgId (was payer.id → always-404 merge break).
    expect(d.jobPostings.getOneForPayer).toHaveBeenCalledWith(POSTING, ORG_A.orgId);
    expect(d.jobPostings.getOneForPayer).not.toHaveBeenCalledWith(POSTING, PAYER_A.id);
    // The service still takes the SESSION payer id (it resolves the org internally).
    expect(d.plans.buyPlanForPayer).toHaveBeenCalledWith(POSTING, PAYER_A.id, dto, CTX);
    // The service is only reached AFTER the ownership read resolves.
    expect(d.jobPostings.getOneForPayer.mock.invocationCallOrder[0]!).toBeLessThan(
      d.plans.buyPlanForPayer.mock.invocationCallOrder[0]!,
    );
    // No payer_id is ever forwarded from the controller (it isn't in the payer DTO).
    expect(d.plans.buyPlanForPayer.mock.calls[0]![2]).not.toHaveProperty("payer_id");
  });

  it("buyBoost checks ownership on the ORG key FIRST (the fix), then buys with the SESSION payer id", async () => {
    const dto = { tier: "all_candidates" as const };
    await d.ctrl.buyBoost(POSTING, dto, ORG_B, PAYER_B, CTX);
    expect(d.jobPostings.getOneForPayer).toHaveBeenCalledWith(POSTING, ORG_B.orgId);
    expect(d.jobPostings.getOneForPayer).not.toHaveBeenCalledWith(POSTING, PAYER_B.id);
    expect(d.plans.buyBoostForPayer).toHaveBeenCalledWith(POSTING, PAYER_B.id, dto, CTX);
    expect(d.plans.buyBoostForPayer.mock.calls[0]![2]).not.toHaveProperty("payer_id");
  });

  it("MERGE-BREAK regression: buyPlan reaches the money path for the OWNER (no longer always-404)", async () => {
    // With the fix, an owner's ownership read RESOLVES (the mock returns the posting) and the
    // purchase proceeds — under the pre-fix payer.id arg this would have thrown a neutral 404.
    d.jobPostings.getOneForPayer.mockResolvedValueOnce({ id: POSTING });
    await d.ctrl.buyPlan(POSTING, { tier: "pro" as const }, ORG_A, PAYER_A, CTX);
    expect(d.plans.buyPlanForPayer).toHaveBeenCalledTimes(1);
  });

  it("buyPlan on an unknown OR foreign-org posting (404) NEVER reaches the money path", async () => {
    d.jobPostings.getOneForPayer.mockRejectedValueOnce(new Error("Job posting not found"));
    await expect(d.ctrl.buyPlan(POSTING, { tier: "pro" }, ORG_A, PAYER_A, CTX)).rejects.toThrow();
    expect(d.plans.buyPlanForPayer).not.toHaveBeenCalled();
  });

  it("buyBoost on an unknown OR foreign-org posting (404) NEVER reaches the money path", async () => {
    d.jobPostings.getOneForPayer.mockRejectedValueOnce(new Error("Job posting not found"));
    await expect(
      d.ctrl.buyBoost(POSTING, { tier: "all_candidates" }, ORG_A, PAYER_A, CTX),
    ).rejects.toThrow();
    expect(d.plans.buyBoostForPayer).not.toHaveBeenCalled();
  });
});

/**
 * B2 → ADR-0027 B5.x Inc 3: quota top-up is org-ownership-gated + session-payer-scoped. Posting
 * OWNERSHIP is asserted via `getOneForPayer(id, org.orgId)` BEFORE the paid top-up (the same
 * merge-break fix) — an unknown/foreign-org posting can never reach the money path.
 */
describe("PayerJobPostingsController — quota top-up is org-ownership-gated + session-payer-scoped (B2, Inc 3 merge-break fix)", () => {
  let d: ReturnType<typeof makeCtrl>;
  beforeEach(() => {
    d = makeCtrl();
  });

  it("checks ownership on the ORG key FIRST (the fix), then tops up with the SESSION payer id", async () => {
    const dto = { tier: "topup_10" as const };
    await d.ctrl.topUpQuota(POSTING, dto, ORG_A, PAYER_A, CTX);
    expect(d.jobPostings.getOneForPayer).toHaveBeenCalledWith(POSTING, ORG_A.orgId);
    expect(d.jobPostings.getOneForPayer).not.toHaveBeenCalledWith(POSTING, PAYER_A.id);
    expect(d.plans.topUpQuotaForPayer).toHaveBeenCalledWith(POSTING, PAYER_A.id, dto, CTX);
    expect(d.jobPostings.getOneForPayer.mock.invocationCallOrder[0]!).toBeLessThan(
      d.plans.topUpQuotaForPayer.mock.invocationCallOrder[0]!,
    );
    expect(d.plans.topUpQuotaForPayer.mock.calls[0]![2]).not.toHaveProperty("payer_id");
  });

  it("MERGE-BREAK regression: topUpQuota reaches the money path for the OWNER (no longer always-404)", async () => {
    d.jobPostings.getOneForPayer.mockResolvedValueOnce({ id: POSTING });
    await d.ctrl.topUpQuota(POSTING, { tier: "topup_10" as const }, ORG_A, PAYER_A, CTX);
    expect(d.plans.topUpQuotaForPayer).toHaveBeenCalledTimes(1);
  });

  it("on an unknown OR foreign-org posting (404) NEVER reaches the money path", async () => {
    d.jobPostings.getOneForPayer.mockRejectedValueOnce(new Error("Job posting not found"));
    await expect(d.ctrl.topUpQuota(POSTING, { tier: "topup_10" }, ORG_A, PAYER_A, CTX)).rejects.toThrow();
    expect(d.plans.topUpQuotaForPayer).not.toHaveBeenCalled();
  });
});
