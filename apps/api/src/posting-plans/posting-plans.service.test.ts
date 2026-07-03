import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { DEFAULT_CATALOG, parseCatalog, type Catalog } from "@badabhai/pricing";
import { PostingPlansService } from "./posting-plans.service";

const POSTING = "33333333-3333-4333-8333-333333333333";
const PAYER = "44444444-4444-4444-8444-444444444444";
// ADR-0027 B5.x Inc 3: OWNERSHIP + the capacity allowance key on ORG, resolved from the
// acting payer. ORG_A is PAYER's org; PAYER_A2 is a SECOND member of ORG_A (shared-org);
// PAYER_B belongs to ORG_B (a foreign org for the cross-org IDOR path).
const ORG_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const PAYER_A2 = "a2a2a2a2-0000-4000-8000-0000000000a2";
const PAYER_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const ORG_B = "0b0b0b0b-0000-4000-8000-00000000000b";
const CTX = { correlationId: "22222222-2222-4222-8222-222222222222", requestId: "req-1" };

/** The default payer→org map: PAYER + PAYER_A2 → ORG_A; PAYER_B → ORG_B. */
const DEFAULT_ORG_MAP: Record<string, string> = {
  [PAYER]: ORG_A,
  [PAYER_A2]: ORG_A,
  [PAYER_B]: ORG_B,
};

function make(
  opts: {
    catalog?: Catalog;
    activeBoost?: boolean;
    couponUsage?: { total: number; perPayer: number };
    postingExists?: boolean;
    // Capacity-chokepoint knobs (ADR-0016):
    capacity?: { maxActiveVacancies: number } | null; // null/undefined → no row (config default)
    activeCount?: number; // currently-active plans for the ORG
    capacityDefault?: number; // config default allowance
    enforceCapacity?: boolean; // ADR-0016 posture B flag (default OFF = shadow)
    pausedPlans?: { id: string; jobPostingId: string; expiresAt: Date | null }[];
    // B2 quota top-up knobs:
    activeTopupPlan?: { id: string; quotaTopupCount: number } | null; // null → no active plan (409)
    topupRaced?: boolean; // addQuotaTopup returns undefined (plan raced to expiry) → 409
    // ADR-0027 B5.x Inc 3 org-resolution knobs:
    orgMap?: Record<string, string | null>; // payer→org override; null → unresolvable (fail-closed)
    resolveThrows?: boolean; // resolveOrgForPayer throws → fail closed to null
  } = {},
) {
  const emit = vi.fn().mockResolvedValue(undefined);
  const postingExists = vi.fn().mockResolvedValue(opts.postingExists ?? true);
  const insertPlan = vi.fn().mockImplementation(async (input: Record<string, unknown>) => ({ id: "p-1", ...input }));
  const insertBoost = vi.fn().mockImplementation(async (input: Record<string, unknown>) => ({ id: "b-1", ...input }));
  const findActiveBoost = vi.fn().mockResolvedValue(opts.activeBoost ? { id: "b-old" } : undefined);
  const couponUsage = vi.fn().mockResolvedValue(opts.couponUsage ?? { total: 0, perPayer: 0 });
  // B2: default to an active plan with 0 prior top-ups; addQuotaTopup returns it with the
  // delta applied (unless topupRaced → undefined, the expiry-race 409 path).
  const topupPlan = opts.activeTopupPlan === undefined ? { id: "p-1", quotaTopupCount: 0 } : opts.activeTopupPlan;
  const findActivePlanForPostingAndOrg = vi.fn().mockResolvedValue(topupPlan ?? undefined);
  const addQuotaTopup = vi.fn().mockImplementation(async (planId: string, _orgId: string, delta: number) =>
    opts.topupRaced || !topupPlan ? undefined : { id: planId, quotaTopupCount: topupPlan.quotaTopupCount + delta },
  );
  // The transaction simply runs its callback with a sentinel tx (the repo methods below
  // are all mocked, so the sentinel is never really used by Drizzle).
  const withTransaction = vi.fn().mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work({}));
  const lockOrg = vi.fn().mockResolvedValue(undefined);
  const getCapacity = vi.fn().mockResolvedValue(opts.capacity ?? undefined);
  const countActivePlansForOrg = vi.fn().mockResolvedValue(opts.activeCount ?? 0);
  const upsertCapacity = vi.fn().mockImplementation(async (input: Record<string, unknown>) => ({ id: "cap-1", ...input }));
  const listPausedPlansForOrg = vi.fn().mockResolvedValue(opts.pausedPlans ?? []);
  const setPlanStatus = vi.fn().mockResolvedValue(undefined);
  const getActiveCatalog = vi.fn().mockResolvedValue({ catalog: opts.catalog ?? DEFAULT_CATALOG, revision: 1, source: "db" });
  // The org resolver (PayerOrgsRepository): map the acting payer → their org. A payer not in
  // the map (or mapped to null) resolves to null → the service fails closed.
  const orgMap = opts.orgMap ?? DEFAULT_ORG_MAP;
  const resolveOrgForPayer = vi.fn().mockImplementation(async (payerId: string) => {
    if (opts.resolveThrows) throw new Error("org resolve failed");
    const orgId = orgMap[payerId] ?? null;
    return orgId === null ? null : { orgId, orgRole: "owner" };
  });
  const service = new PostingPlansService(
    {
      postingExists,
      insertPlan,
      insertBoost,
      findActiveBoost,
      couponUsage,
      withTransaction,
      lockOrg,
      getCapacity,
      countActivePlansForOrg,
      upsertCapacity,
      listPausedPlansForOrg,
      setPlanStatus,
      findActivePlanForPostingAndOrg,
      addQuotaTopup,
    } as never,
    { emit } as never,
    { getActiveCatalog } as never,
    { resolveOrgForPayer } as never,
    {
      PAYMENTS_ENABLE_REAL: false,
      CAPACITY_DEFAULT_MAX_ACTIVE_VACANCIES: opts.capacityDefault ?? 1,
      CAPACITY_ENFORCEMENT_ENABLED: opts.enforceCapacity ?? false,
    } as never,
  );
  const names = () => emit.mock.calls.map((c) => c[0].event_name);
  return {
    service,
    emit,
    names,
    insertPlan,
    insertBoost,
    couponUsage,
    upsertCapacity,
    setPlanStatus,
    lockOrg,
    withTransaction,
    getCapacity,
    countActivePlansForOrg,
    findActivePlanForPostingAndOrg,
    addQuotaTopup,
    resolveOrgForPayer,
  };
}

describe("PostingPlansService.buyPlan", () => {
  it("resolves price, stamps quota/window, and emits payment + purchase (mock real_call=false)", async () => {
    const { service, emit, names, insertPlan } = make();
    const { plan, quote } = await service.buyPlan(POSTING, { payer_id: PAYER, tier: "standard" }, CTX);
    expect(quote.finalInr).toBe(1000);
    expect(insertPlan).toHaveBeenCalledWith(
      // ADR-0027 B5.x Inc 3: the plan row stamps BOTH org_id (ownership) + payer_id (acting).
      expect.objectContaining({ jobPostingId: POSTING, orgId: ORG_A, payerId: PAYER, tier: "standard", applicantVisibilityQuota: 10, status: "active" }),
      expect.anything(),
    );
    expect(plan.id).toBe("p-1");
    expect(names()).toEqual(["payment.authorized", "payment.captured", "job_posting.purchased"]);
    const purchased = emit.mock.calls.find((c) => c[0].event_name === "job_posting.purchased")![0];
    expect(purchased.payload).toMatchObject({ tier: "standard", price_inr: 1000, coupon_applied: false, real_call: false, validity_days: 14 });
  });

  it("404s for an unknown posting", async () => {
    const { service } = make({ postingExists: false });
    await expect(service.buyPlan(POSTING, { payer_id: PAYER, tier: "standard" }, CTX)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("resolves the pro tier (₹2500 / 30 views / 30 days)", async () => {
    const { service } = make();
    const { plan, quote } = await service.buyPlan(POSTING, { payer_id: PAYER, tier: "pro" }, CTX);
    expect(quote.finalInr).toBe(2500);
    expect(plan.applicantVisibilityQuota).toBe(30);
  });

  it("applies a valid coupon and emits coupon.redeemed", async () => {
    const cat = parseCatalog({
      ...DEFAULT_CATALOG,
      coupons: [
        {
          code: "save10",
          scope: { productCode: "job_posting", tierCode: "standard" },
          kind: "percent",
          value: 10,
          from: "2026-01-01T00:00:00.000Z",
          until: "2027-01-01T00:00:00.000Z",
          totalUsageCap: 100,
          perPayerLimit: 5,
        },
      ],
    });
    const { service, emit, names } = make({ catalog: cat });
    const { quote } = await service.buyPlan(POSTING, { payer_id: PAYER, tier: "standard", coupon: "save10" }, CTX);
    expect(quote.finalInr).toBe(900);
    expect(quote.couponApplied).toBe("save10");
    expect(names()).toContain("coupon.redeemed");
    const redeemed = emit.mock.calls.find((c) => c[0].event_name === "coupon.redeemed")![0];
    expect(redeemed.payload).toMatchObject({ coupon_code: "save10", product: "job_posting", tier: "standard", discount_inr: 100 });
  });

  it("ignores an over-cap coupon (full price, no redemption event)", async () => {
    const cat = parseCatalog({
      ...DEFAULT_CATALOG,
      coupons: [
        { code: "save10", scope: { productCode: "job_posting" }, kind: "percent", value: 10, from: "2026-01-01T00:00:00.000Z", until: "2027-01-01T00:00:00.000Z", totalUsageCap: 5, perPayerLimit: 5 },
      ],
    });
    const { service, names } = make({ catalog: cat, couponUsage: { total: 5, perPayer: 0 } });
    const { quote } = await service.buyPlan(POSTING, { payer_id: PAYER, tier: "standard", coupon: "save10" }, CTX);
    expect(quote.finalInr).toBe(1000);
    expect(quote.couponApplied).toBeNull();
    expect(names()).not.toContain("coupon.redeemed");
  });
});

describe("PostingPlansService.buyPlan — per-payer capacity chokepoint (ADR-0016)", () => {
  it("writes status='active' when the payer stays within their allowance (no pause event)", async () => {
    const { service, names, insertPlan } = make({ activeCount: 0, capacityDefault: 1 });
    const { paused, wouldPause } = await service.buyPlan(POSTING, { payer_id: PAYER, tier: "standard" }, CTX);
    expect(paused).toBe(false);
    expect(wouldPause).toBe(false);
    expect(insertPlan).toHaveBeenCalledWith(expect.objectContaining({ status: "active" }), expect.anything());
    expect(names()).not.toContain("posting_plan.paused");
  });

  it("ENFORCEMENT ON: writes status='paused' + emits posting_plan.paused when over the config default", async () => {
    // default allowance 1, already 1 active → this purchase (1+1 > 1) is paused (enforced).
    const { service, names, insertPlan } = make({ activeCount: 1, capacityDefault: 1, enforceCapacity: true });
    const { paused, wouldPause } = await service.buyPlan(POSTING, { payer_id: PAYER, tier: "standard" }, CTX);
    expect(paused).toBe(true);
    expect(wouldPause).toBe(true);
    expect(insertPlan).toHaveBeenCalledWith(expect.objectContaining({ status: "paused" }), expect.anything());
    expect(names()).toContain("posting_plan.paused");
    // payment + purchase still emitted (the receipt is real; a paused plan just does not serve).
    expect(names()).toEqual(["payment.authorized", "payment.captured", "job_posting.purchased", "posting_plan.paused"]);
  });

  it("ENFORCEMENT OFF (default/shadow): over-cap writes status='active', emits NO pause event, returns wouldPause=true", async () => {
    // Same over-cap inputs as the enforced case, but enforcement is OFF (the default).
    const { service, names, insertPlan } = make({ activeCount: 1, capacityDefault: 1 });
    const { paused, wouldPause } = await service.buyPlan(POSTING, { payer_id: PAYER, tier: "standard" }, CTX);
    expect(paused).toBe(false); // nothing actually paused in shadow mode
    expect(wouldPause).toBe(true); // but the would-pause decision is surfaced
    expect(insertPlan).toHaveBeenCalledWith(expect.objectContaining({ status: "active" }), expect.anything());
    // NO posting_plan.paused — pausing nothing must not emit a pause (event↔state honesty).
    expect(names()).not.toContain("posting_plan.paused");
    expect(names()).toEqual(["payment.authorized", "payment.captured", "job_posting.purchased"]);
  });

  it("uses the payer's own capacity row over the config default", async () => {
    // payer row allows 3; 2 already active → 2+1 = 3 ≤ 3 → active.
    const { service, insertPlan } = make({ activeCount: 2, capacity: { maxActiveVacancies: 3 }, capacityDefault: 1 });
    const { paused, wouldPause } = await service.buyPlan(POSTING, { payer_id: PAYER, tier: "standard" }, CTX);
    expect(paused).toBe(false);
    expect(wouldPause).toBe(false);
    expect(insertPlan).toHaveBeenCalledWith(expect.objectContaining({ status: "active" }), expect.anything());
  });

  it("count-and-write runs inside the per-ORG advisory-locked transaction (lock key == org)", async () => {
    const { service, lockOrg, countActivePlansForOrg, withTransaction } = make();
    await service.buyPlan(POSTING, { payer_id: PAYER, tier: "standard" }, CTX);
    expect(withTransaction).toHaveBeenCalledTimes(1);
    // ADR-0027 B5.x Inc 3: the advisory lock AND the active-plan count share the SAME org key
    // (chokepoint atomicity) — resolved from the acting payer, NOT the payer id itself.
    expect(lockOrg).toHaveBeenCalledWith(expect.anything(), ORG_A);
    expect(countActivePlansForOrg).toHaveBeenCalledWith(expect.anything(), ORG_A, expect.any(Date));
  });
});

describe("PostingPlansService.buyCapacity (ADR-0016 — purchase + auto-resume)", () => {
  it("resolves the capacity tier, upserts the allowance, and emits capacity.purchased + payment.*", async () => {
    const { service, names, upsertCapacity } = make();
    const res = await service.buyCapacity(PAYER, { tier: "cap_5" }, CTX);
    expect(res.max_active_vacancies).toBe(5);
    expect(res.quote.finalInr).toBe(5000);
    expect(upsertCapacity).toHaveBeenCalledWith(
      // ADR-0027 B5.x Inc 3: the capacity row keys on org_id + stamps the acting payer_id.
      expect.objectContaining({ orgId: ORG_A, payerId: PAYER, maxActiveVacancies: 5, sourceTier: "cap_5" }),
      expect.anything(),
    );
    expect(names()).toEqual(["payment.authorized", "payment.captured", "capacity.purchased"]);
  });

  it("auto-resumes paused plans oldest-first up to the new headroom and emits posting_plan.resumed", async () => {
    // new allowance 5, 0 active now → headroom 5; two paused plans both resume.
    const paused = [
      { id: "old-1", jobPostingId: "jp-1", expiresAt: new Date(Date.now() + 86_400_000) },
      { id: "old-2", jobPostingId: "jp-2", expiresAt: null },
    ];
    const { service, names, setPlanStatus } = make({ activeCount: 0, pausedPlans: paused });
    const res = await service.buyCapacity(PAYER, { tier: "cap_5" }, CTX);
    expect(res.resumed_plan_ids).toEqual(["old-1", "old-2"]);
    expect(setPlanStatus).toHaveBeenCalledWith(expect.anything(), "old-1", "active");
    expect(setPlanStatus).toHaveBeenCalledWith(expect.anything(), "old-2", "active");
    const resumedCount = names().filter((n) => n === "posting_plan.resumed").length;
    expect(resumedCount).toBe(2);
  });

  it("resumes only up to the available headroom (allowed − active)", async () => {
    // allowance 5, already 4 active → headroom 1 → only the oldest paused plan resumes.
    const paused = [
      { id: "old-1", jobPostingId: "jp-1", expiresAt: null },
      { id: "old-2", jobPostingId: "jp-2", expiresAt: null },
    ];
    const { service, setPlanStatus } = make({ activeCount: 4, pausedPlans: paused });
    const res = await service.buyCapacity(PAYER, { tier: "cap_5" }, CTX);
    expect(res.resumed_plan_ids).toEqual(["old-1"]);
    expect(setPlanStatus).toHaveBeenCalledTimes(1);
  });

  it("does not resume an expired paused plan", async () => {
    const paused = [{ id: "stale", jobPostingId: "jp-x", expiresAt: new Date(Date.now() - 86_400_000) }];
    const { service, setPlanStatus } = make({ activeCount: 0, pausedPlans: paused });
    const res = await service.buyCapacity(PAYER, { tier: "cap_5" }, CTX);
    expect(res.resumed_plan_ids).toEqual([]);
    expect(setPlanStatus).not.toHaveBeenCalled();
  });

  it("auto-resume runs under the per-ORG advisory lock (lock key == org)", async () => {
    const { service, lockOrg, withTransaction } = make();
    await service.buyCapacity(PAYER, { tier: "cap_5" }, CTX);
    expect(withTransaction).toHaveBeenCalledTimes(1);
    // ADR-0027 B5.x Inc 3: keyed on the resolved org, not the acting payer id.
    expect(lockOrg).toHaveBeenCalledWith(expect.anything(), ORG_A);
  });

  it("400s for an unknown capacity tier (fail-closed pricing)", async () => {
    const { service } = make();
    await expect(service.buyCapacity(PAYER, { tier: "cap_999" }, CTX)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("UPGRADE (cap_5 → cap_15, D4): raises the allowance to 15 and auto-resumes against the higher headroom", async () => {
    // D4 + GREATEST guard (ADR-0016): a payer already on cap_5 (allowance 5) upgrades to
    // cap_15 (allowance 15). The service upserts the catalog grant (15) — the GREATEST
    // guard is the DB-side onConflict (raises, never lowers); the e2e proves the SQL, the
    // unit proves the service passes the RAISED grant through AND resumes against it.
    //
    // Set the scene so resume headroom is what distinguishes 5 from 15: 5 already active
    // (i.e. AT the old cap_5 ceiling → zero headroom under cap_5) + many paused plans.
    // Under cap_15 the headroom is 15 − 5 = 10, so up to 10 paused plans resume.
    const paused = Array.from({ length: 12 }, (_, i) => ({
      id: `paused-${String(i).padStart(2, "0")}`,
      jobPostingId: `jp-${i}`,
      expiresAt: null,
    }));
    const { service, upsertCapacity, setPlanStatus, names } = make({ activeCount: 5, pausedPlans: paused });

    const res = await service.buyCapacity(PAYER, { tier: "cap_15" }, CTX);

    // The allowance after the upgrade is the cap_15 grant (15) — the service stamps the
    // raised grant; it does not re-read its own in-tx write (see service comment).
    expect(res.max_active_vacancies).toBe(15);
    expect(res.source_tier).toBe("cap_15");
    expect(upsertCapacity).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_A, payerId: PAYER, maxActiveVacancies: 15, sourceTier: "cap_15" }),
      expect.anything(),
    );

    // Resume runs against the RAISED headroom (15 − 5 = 10), NOT the old cap_5 (which gave
    // zero headroom). Exactly 10 paused plans flip active, oldest-first, deterministically.
    expect(res.resumed_plan_ids).toHaveLength(10);
    expect(res.resumed_plan_ids).toEqual(paused.slice(0, 10).map((p) => p.id));
    expect(setPlanStatus).toHaveBeenCalledTimes(10);
    expect(setPlanStatus).toHaveBeenCalledWith(expect.anything(), "paused-00", "active");
    expect(setPlanStatus).toHaveBeenCalledWith(expect.anything(), "paused-09", "active");
    expect(setPlanStatus).not.toHaveBeenCalledWith(expect.anything(), "paused-10", "active");

    // One posting_plan.resumed per resumed plan + the capacity/payment spine events.
    expect(names().filter((n) => n === "posting_plan.resumed")).toHaveLength(10);
    expect(names()).toContain("capacity.purchased");
  });
});

describe("PostingPlansService.buyBoost", () => {
  it("creates a boost and emits payment + boosted", async () => {
    const { service, names, insertBoost } = make();
    const { boost, quote } = await service.buyBoost(POSTING, { payer_id: PAYER, tier: "all_candidates" }, CTX);
    expect(quote.finalInr).toBe(1200);
    // ADR-0027 B5.x Inc 3: the boost row stamps BOTH org_id (ownership) + payer_id (acting).
    expect(insertBoost).toHaveBeenCalledWith(expect.objectContaining({ jobPostingId: POSTING, orgId: ORG_A, payerId: PAYER, status: "active" }));
    expect(boost.id).toBe("b-1");
    expect(names()).toEqual(["payment.authorized", "payment.captured", "job_posting.boosted"]);
  });

  it("rejects an overlapping active boost (B-R3)", async () => {
    const { service } = make({ activeBoost: true });
    await expect(service.buyBoost(POSTING, { payer_id: PAYER, tier: "all_candidates" }, CTX)).rejects.toBeInstanceOf(ConflictException);
  });
});

// SESSION_PAYER acts within SESSION_ORG (ADR-0027 B5.x Inc 3): the wrappers resolve the org
// from the session payer, key ownership on it, and stamp BOTH ids on the row.
const SESSION_PAYER = "55555555-5555-4555-8555-555555555555";
const SESSION_ORG = "50505050-5050-4050-8050-505050505050";
const SESSION_MAP = { [SESSION_PAYER]: SESSION_ORG };

describe("PostingPlansService payer-authed wrappers (B3/LC-1 — session payer_id stamped, org-owned)", () => {
  it("buyPlanForPayer stamps the SESSION payer_id + resolved org_id onto the plan + the purchased event", async () => {
    const { service, insertPlan, emit } = make({ orgMap: SESSION_MAP });
    const { plan, quote } = await service.buyPlanForPayer(
      POSTING,
      SESSION_PAYER,
      { tier: "standard" },
      CTX,
    );
    // The plan row stamps the resolved org (ownership) + the SESSION payer id (acting) — the
    // events still carry ONLY the session payer id (never a body value; schema unchanged).
    expect(insertPlan).toHaveBeenCalledWith(
      expect.objectContaining({ jobPostingId: POSTING, orgId: SESSION_ORG, payerId: SESSION_PAYER }),
      expect.anything(),
    );
    const purchased = emit.mock.calls.find((c) => c[0].event_name === "job_posting.purchased")![0];
    expect(purchased.actor).toEqual({ actor_type: "payer", actor_id: SESSION_PAYER });
    expect(purchased.payload.payer_id).toBe(SESSION_PAYER);
    expect(plan.payerId).toBe(SESSION_PAYER);
    expect(quote.finalInr).toBeGreaterThanOrEqual(0);
  });

  it("buyBoostForPayer stamps the SESSION payer_id + resolved org_id onto the boost", async () => {
    const { service, insertBoost, emit } = make({ orgMap: SESSION_MAP });
    const { boost } = await service.buyBoostForPayer(
      POSTING,
      SESSION_PAYER,
      { tier: "all_candidates" },
      CTX,
    );
    expect(insertBoost).toHaveBeenCalledWith(
      expect.objectContaining({ jobPostingId: POSTING, orgId: SESSION_ORG, payerId: SESSION_PAYER }),
    );
    const boosted = emit.mock.calls.find((c) => c[0].event_name === "job_posting.boosted")![0];
    expect(boosted.payload.payer_id).toBe(SESSION_PAYER);
    expect(boost.payerId).toBe(SESSION_PAYER);
  });
});

describe("PostingPlansService.topUpQuotaForPayer (B2 — pricing-engine refill on an active plan)", () => {
  it("resolves the top-up price, atomically increments quota_topup_count (org-scoped), and emits payment + quota_topped", async () => {
    const { service, emit, names, addQuotaTopup } = make({ orgMap: SESSION_MAP });
    const { plan, quote } = await service.topUpQuotaForPayer(POSTING, SESSION_PAYER, { tier: "topup_10" }, CTX);
    expect(quote.finalInr).toBe(1000);
    // Atomic increment is now ORG-scoped (the resolved org, not the payer id) + the catalog
    // grant (10 views). The event payload still carries the acting session payer id.
    expect(addQuotaTopup).toHaveBeenCalledWith("p-1", SESSION_ORG, 10, expect.any(Date));
    expect(plan.quotaTopupCount).toBe(10);
    expect(names()).toEqual(["payment.authorized", "payment.captured", "posting_plan.quota_topped"]);
    const topped = emit.mock.calls.find((c) => c[0].event_name === "posting_plan.quota_topped")![0];
    expect(topped.actor).toEqual({ actor_type: "payer", actor_id: SESSION_PAYER });
    expect(topped.subject).toEqual({ subject_type: "posting_plan", subject_id: "p-1" });
    expect(topped.payload).toMatchObject({
      plan_id: "p-1",
      job_posting_id: POSTING,
      payer_id: SESSION_PAYER,
      tier: "topup_10",
      quota_added: 10,
      quota_topup_total: 10,
      price_inr: 1000,
      real_call: false,
    });
  });

  it("accumulates on top of prior top-ups (quota_topup_total reflects the running total)", async () => {
    const { service } = make({ orgMap: SESSION_MAP, activeTopupPlan: { id: "p-1", quotaTopupCount: 30 } });
    const { plan } = await service.topUpQuotaForPayer(POSTING, SESSION_PAYER, { tier: "topup_30" }, CTX);
    expect(plan.quotaTopupCount).toBe(60); // 30 prior + 30 added
  });

  it("409s when the posting has no active plan to top up (no payment emitted)", async () => {
    const { service, names } = make({ orgMap: SESSION_MAP, activeTopupPlan: null });
    await expect(
      service.topUpQuotaForPayer(POSTING, SESSION_PAYER, { tier: "topup_10" }, CTX),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(names()).not.toContain("payment.authorized");
    expect(names()).not.toContain("posting_plan.quota_topped");
  });

  it("409s (no phantom grant/payment) when the plan raced to expiry between read and increment", async () => {
    const { service, names } = make({ orgMap: SESSION_MAP, topupRaced: true });
    await expect(
      service.topUpQuotaForPayer(POSTING, SESSION_PAYER, { tier: "topup_10" }, CTX),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(names()).not.toContain("payment.authorized");
    expect(names()).not.toContain("posting_plan.quota_topped");
  });

  it("rejects an unknown top-up tier fail-closed (unavailable → 400)", async () => {
    const { service } = make({ orgMap: SESSION_MAP });
    await expect(
      service.topUpQuotaForPayer(POSTING, SESSION_PAYER, { tier: "nope" }, CTX),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("fail-closed: an unresolvable org (no membership) 409s WITHOUT reaching the plan lookup/payment", async () => {
    // SESSION_PAYER is NOT in the org map → resolveOrgForPayer returns null → the SAME neutral
    // 409 as "no active plan" (no oracle), and no plan read / payment / event happens.
    const { service, names, findActivePlanForPostingAndOrg, addQuotaTopup } = make({ orgMap: {} });
    await expect(
      service.topUpQuotaForPayer(POSTING, SESSION_PAYER, { tier: "topup_10" }, CTX),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(findActivePlanForPostingAndOrg).not.toHaveBeenCalled();
    expect(addQuotaTopup).not.toHaveBeenCalled();
    expect(names()).toEqual([]);
  });
});

describe("PostingPlansService.getCapacity (ADR-0016 / ADR-0027 B5.x Inc 3 — org-derived allowance + count)", () => {
  it("returns active_plan_count from the ORG count (3 active → 3), keyed on the resolved org", async () => {
    const { service, countActivePlansForOrg } = make({ capacity: { maxActiveVacancies: 10 }, activeCount: 3 });
    const view = await service.getCapacity(PAYER);
    expect(countActivePlansForOrg).toHaveBeenCalledTimes(1);
    expect(countActivePlansForOrg).toHaveBeenCalledWith(expect.anything(), ORG_A, expect.any(Date));
    expect(view).toMatchObject({
      // payer_id stays the acting payer (response-contract stability); counts are org-derived.
      payer_id: PAYER,
      max_active_vacancies: 10,
      active_plan_count: 3,
      source_tier: null,
      expires_at: null,
    });
  });

  it("reflects a different real count (repo returns 0 → active_plan_count === 0)", async () => {
    const { service } = make({ capacity: { maxActiveVacancies: 5 }, activeCount: 0 });
    const view = await service.getCapacity(PAYER);
    expect(view.active_plan_count).toBe(0);
  });

  it("falls back to the config default allowance when the org has no capacity row (count still derived)", async () => {
    const { service } = make({ capacity: null, activeCount: 2, capacityDefault: 1 });
    const view = await service.getCapacity(PAYER);
    expect(view.max_active_vacancies).toBe(1);
    expect(view.active_plan_count).toBe(2);
  });

  it("fail-closed READ: an unresolvable org reads the config default allowance + zero active plans (no tx)", async () => {
    // PAYER_UNKNOWN is not in the map → null org → the read never opens a tx and reports the
    // config default allowance + 0 active plans (never a distinguishable error).
    const { service, withTransaction, countActivePlansForOrg } = make({
      orgMap: {},
      capacityDefault: 4,
    });
    const view = await service.getCapacity(PAYER);
    expect(view.max_active_vacancies).toBe(4);
    expect(view.active_plan_count).toBe(0);
    expect(view.payer_id).toBe(PAYER);
    expect(withTransaction).not.toHaveBeenCalled();
    expect(countActivePlansForOrg).not.toHaveBeenCalled();
  });
});

describe("PostingPlansService — ADR-0027 B5.x Inc 3 tenancy: cross-org IDOR, shared-org, chokepoint, fail-closed, stamping", () => {
  it("cross-org: PAYER_B (ORG_B) buying a plan keys on ORG_B — never ORG_A (no cross-org write)", async () => {
    // The posting/plan ownership + the capacity lock/count are ALL keyed on the BUYER's own
    // org (ORG_B), resolved from PAYER_B — a member of one org can never write against another.
    const { service, insertPlan, lockOrg, countActivePlansForOrg } = make();
    await service.buyPlan(POSTING, { payer_id: PAYER_B, tier: "standard" }, CTX);
    expect(insertPlan).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_B, payerId: PAYER_B }),
      expect.anything(),
    );
    expect(lockOrg).toHaveBeenCalledWith(expect.anything(), ORG_B);
    expect(countActivePlansForOrg).toHaveBeenCalledWith(expect.anything(), ORG_B, expect.any(Date));
    expect(lockOrg).not.toHaveBeenCalledWith(expect.anything(), ORG_A);
  });

  it("shared-org: PAYER and PAYER_A2 BOTH resolve ORG_A — a plan bought by one counts against the other's allowance", async () => {
    // A2's buy locks + counts on ORG_A (the SAME shared allowance PAYER draws on) — so an org's
    // active-plan count is team-wide, not per-payer (the point of the org flip).
    const { service, lockOrg, countActivePlansForOrg, insertPlan } = make({ activeCount: 2, capacityDefault: 5 });
    await service.buyPlan(POSTING, { payer_id: PAYER_A2, tier: "standard" }, CTX);
    expect(lockOrg).toHaveBeenCalledWith(expect.anything(), ORG_A);
    expect(countActivePlansForOrg).toHaveBeenCalledWith(expect.anything(), ORG_A, expect.any(Date));
    expect(insertPlan).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_A, payerId: PAYER_A2 }),
      expect.anything(),
    );
  });

  it("chokepoint (enforcement ON): the org allowance caps under the ORG lock — an over-org-cap buy pauses", async () => {
    // ORG_A already has 3 active (team-wide) against a default allowance of 3 → 3+1 > 3 → the
    // buy pauses (enforced). The count that drives the decision is the ORG count under the ORG lock.
    const { service, insertPlan, names, lockOrg, countActivePlansForOrg } = make({
      activeCount: 3,
      capacityDefault: 3,
      enforceCapacity: true,
    });
    const { paused } = await service.buyPlan(POSTING, { payer_id: PAYER_A2, tier: "standard" }, CTX);
    expect(paused).toBe(true);
    expect(insertPlan).toHaveBeenCalledWith(expect.objectContaining({ status: "paused" }), expect.anything());
    expect(names()).toContain("posting_plan.paused");
    // lock key == count key == org (the chokepoint invariant).
    expect(lockOrg).toHaveBeenCalledWith(expect.anything(), ORG_A);
    expect(countActivePlansForOrg).toHaveBeenCalledWith(expect.anything(), ORG_A, expect.any(Date));
  });

  it("fail-closed WRITE (buyPlan): an unresolvable org 404s WITHOUT touching the capacity tx/insert", async () => {
    const { service, withTransaction, insertPlan } = make({ orgMap: {} });
    await expect(
      service.buyPlan(POSTING, { payer_id: PAYER, tier: "standard" }, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(withTransaction).not.toHaveBeenCalled();
    expect(insertPlan).not.toHaveBeenCalled();
  });

  it("fail-closed WRITE (buyBoost): an unresolvable org 404s WITHOUT inserting a boost", async () => {
    const { service, insertBoost } = make({ orgMap: {} });
    await expect(
      service.buyBoost(POSTING, { payer_id: PAYER, tier: "all_candidates" }, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(insertBoost).not.toHaveBeenCalled();
  });

  it("fail-closed WRITE (buyCapacity): an unresolvable org 404s WITHOUT upserting the allowance", async () => {
    const { service, upsertCapacity, withTransaction } = make({ orgMap: {} });
    await expect(service.buyCapacity(PAYER, { tier: "cap_5" }, CTX)).rejects.toBeInstanceOf(NotFoundException);
    expect(upsertCapacity).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it("fail-closed: a THROWN resolveOrgForPayer collapses to null org (never leaks the error)", async () => {
    const { service, insertPlan } = make({ resolveThrows: true });
    await expect(
      service.buyPlan(POSTING, { payer_id: PAYER, tier: "standard" }, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(insertPlan).not.toHaveBeenCalled();
  });

  it("NOT-NULL stamping: every plan/boost/capacity insert carries BOTH org_id + payer_id", async () => {
    const plan = make();
    await plan.service.buyPlan(POSTING, { payer_id: PAYER, tier: "standard" }, CTX);
    const planArg = plan.insertPlan.mock.calls[0]![0] as Record<string, unknown>;
    expect(planArg.orgId).toBe(ORG_A);
    expect(planArg.payerId).toBe(PAYER);

    const boost = make();
    await boost.service.buyBoost(POSTING, { payer_id: PAYER, tier: "all_candidates" }, CTX);
    const boostArg = boost.insertBoost.mock.calls[0]![0] as Record<string, unknown>;
    expect(boostArg.orgId).toBe(ORG_A);
    expect(boostArg.payerId).toBe(PAYER);

    const cap = make();
    await cap.service.buyCapacity(PAYER, { tier: "cap_5" }, CTX);
    const capArg = cap.upsertCapacity.mock.calls[0]![0] as Record<string, unknown>;
    expect(capArg.orgId).toBe(ORG_A);
    expect(capArg.payerId).toBe(PAYER);
  });
});
