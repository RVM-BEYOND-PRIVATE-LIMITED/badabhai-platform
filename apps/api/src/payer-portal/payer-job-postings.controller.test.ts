import "reflect-metadata";
import { createHash } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConflictException } from "@nestjs/common";
import type { Request } from "express";
import { RequestIdempotency } from "../common/idempotency/request-idempotency.service";
import { caught, renderedError } from "../common/idempotency/replay-fidelity.test-support";
import { assertExpectedPrice } from "../pricing/charge-price";
import { PayerJobPostingsController } from "./payer-job-postings.controller";
import type { AuthenticatedPayer } from "../payers/payer-auth.guard";
import type { RequestContext } from "../common/request-context";
import type { PostingStats } from "../posting-plans/posting-plans.service";

// Writes here are employer-only at the guard (#1885 — payer-job-postings-role-authz.test.ts);
// these tests call the controller directly (below the guard) to pin session-scoping, so they
// still cover both roles. `role` is required on AuthenticatedPayer since the ADR-0022 role claim.
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

/** A request carrying no `Idempotency-Key` — the unguarded path every legacy client takes. */
const NO_KEY = { header: () => undefined } as unknown as Request;

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
    topUpQuotaForPayer: vi.fn(
      async (_id: string, _payerId: string, _dto: unknown, _ctx: unknown) => ({
        plan: { id: "plan-1", quotaTopupCount: 10 },
      }),
    ),
    getPostingStats: vi.fn(
      async (_id: string, _payerId: string): Promise<PostingStats> => ({
        plan_tier: null,
        applicant_visibility_quota: null,
        applicants_viewed_count: null,
        boosted: false,
      }),
    ),
  };
  const disclosures = {
    countDisclosuresForPosting: vi.fn(async (_id: string, _payerId: string) => 0),
  };
  // #2085 — a PASS-THROUGH double: these cases send NO Idempotency-Key, which is exactly the
  // path where runOnce runs the work unchanged. The keyed cases use the REAL seam (below).
  const idempotency = {
    runOnce: vi.fn(async (o: { work: () => Promise<unknown> }) => o.work()),
  };
  const ctrl = new PayerJobPostingsController(
    jobPostings as never,
    plans as never,
    disclosures as never,
    idempotency as never,
  );
  return { ctrl, jobPostings, plans, disclosures };
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

  it("getOne resolves stats with the SESSION payer id (not the body/route)", async () => {
    await d.ctrl.getOne(POSTING, PAYER_A);
    expect(d.plans.getPostingStats).toHaveBeenCalledWith(POSTING, PAYER_A.id);
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
 * The My-jobs card shows HONEST per-posting stats: the list/getOne responses are
 * enriched with the active-plan quota + used + boosted flag (getPostingStats),
 * resolved per row against the SESSION payer's OWN plans. A plan-less posting
 * carries nulls/false — never a fabricated number.
 */
describe("PayerJobPostingsController — postings enriched with honest per-posting stats", () => {
  let d: ReturnType<typeof makeCtrl>;
  beforeEach(() => {
    d = makeCtrl();
  });

  it("list merges each posting's stats, keyed on the SESSION payer", async () => {
    d.jobPostings.listForPayer.mockResolvedValueOnce([
      { id: "p1", role_title: "CNC Operator" },
      { id: "p2", role_title: "Fitter" },
    ] as never);
    d.plans.getPostingStats.mockImplementation(async (id: string) =>
      id === "p1"
        ? {
            plan_tier: "pro",
            applicant_visibility_quota: 40,
            applicants_viewed_count: 12,
            boosted: true,
          }
        : {
            plan_tier: null,
            applicant_visibility_quota: null,
            applicants_viewed_count: null,
            boosted: false,
          },
    );

    d.disclosures.countDisclosuresForPosting.mockImplementation(async (id: string) =>
      id === "p1" ? 5 : 0,
    );

    const result = await d.ctrl.list({}, PAYER_A);

    expect(d.plans.getPostingStats).toHaveBeenCalledWith("p1", PAYER_A.id);
    expect(d.plans.getPostingStats).toHaveBeenCalledWith("p2", PAYER_A.id);
    expect(d.disclosures.countDisclosuresForPosting).toHaveBeenCalledWith("p1", PAYER_A.id);
    expect(result[0]).toMatchObject({
      id: "p1",
      role_title: "CNC Operator",
      applicant_visibility_quota: 40,
      applicants_viewed_count: 12,
      boosted: true,
      disclosures_count: 5,
    });
    // A plan-less posting stays honest: nulls + not boosted + 0 downloads, never faked.
    expect(result[1]).toMatchObject({
      id: "p2",
      applicant_visibility_quota: null,
      applicants_viewed_count: null,
      boosted: false,
      disclosures_count: 0,
    });
  });

  it("getOne merges the posting's stats into the response", async () => {
    d.jobPostings.getOneForPayer.mockResolvedValueOnce({
      id: POSTING,
      role_title: "VMC Operator",
    } as never);
    d.plans.getPostingStats.mockResolvedValueOnce({
      plan_tier: "standard",
      applicant_visibility_quota: 20,
      applicants_viewed_count: 3,
      boosted: false,
    });
    d.disclosures.countDisclosuresForPosting.mockResolvedValueOnce(3);

    const result = await d.ctrl.getOne(POSTING, PAYER_A);

    expect(result).toMatchObject({
      id: POSTING,
      role_title: "VMC Operator",
      plan_tier: "standard",
      applicant_visibility_quota: 20,
      applicants_viewed_count: 3,
      boosted: false,
      disclosures_count: 3,
    });
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
    await d.ctrl.buyPlan(POSTING, dto, PAYER_A, NO_KEY, CTX);
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
    await d.ctrl.buyBoost(POSTING, dto, PAYER_B, NO_KEY, CTX);
    expect(d.jobPostings.getOneForPayer).toHaveBeenCalledWith(POSTING, PAYER_B.id);
    expect(d.plans.buyBoostForPayer).toHaveBeenCalledWith(POSTING, PAYER_B.id, dto, CTX);
    expect(d.plans.buyBoostForPayer.mock.calls[0]![2]).not.toHaveProperty("payer_id");
  });

  it("buyPlan on an unknown OR foreign posting (404) NEVER reaches the money path", async () => {
    d.jobPostings.getOneForPayer.mockRejectedValueOnce(new Error("Job posting not found"));
    await expect(d.ctrl.buyPlan(POSTING, { tier: "pro" }, PAYER_A, NO_KEY, CTX)).rejects.toThrow();
    expect(d.plans.buyPlanForPayer).not.toHaveBeenCalled();
  });

  it("buyBoost on an unknown OR foreign posting (404) NEVER reaches the money path", async () => {
    d.jobPostings.getOneForPayer.mockRejectedValueOnce(new Error("Job posting not found"));
    await expect(
      d.ctrl.buyBoost(POSTING, { tier: "all_candidates" }, PAYER_A, NO_KEY, CTX),
    ).rejects.toThrow();
    expect(d.plans.buyBoostForPayer).not.toHaveBeenCalled();
  });
});

/**
 * B2: quota top-up is session-scoped + ownership-gated. The `payer_id` is the SESSION payer
 * (never the body), and posting OWNERSHIP is asserted via `getOneForPayer` BEFORE the paid
 * top-up — an unknown/foreign posting can never reach the money path.
 */
describe("PayerJobPostingsController — quota top-up is session-scoped + ownership-gated (B2)", () => {
  let d: ReturnType<typeof makeCtrl>;
  beforeEach(() => {
    d = makeCtrl();
  });

  it("checks ownership FIRST, then tops up with the SESSION payer id (no body payer_id)", async () => {
    const dto = { tier: "topup_10" as const };
    await d.ctrl.topUpQuota(POSTING, dto, PAYER_A, NO_KEY, CTX);
    expect(d.jobPostings.getOneForPayer).toHaveBeenCalledWith(POSTING, PAYER_A.id);
    expect(d.plans.topUpQuotaForPayer).toHaveBeenCalledWith(POSTING, PAYER_A.id, dto, CTX);
    expect(d.jobPostings.getOneForPayer.mock.invocationCallOrder[0]!).toBeLessThan(
      d.plans.topUpQuotaForPayer.mock.invocationCallOrder[0]!,
    );
    expect(d.plans.topUpQuotaForPayer.mock.calls[0]![2]).not.toHaveProperty("payer_id");
  });

  it("on an unknown OR foreign posting (404) NEVER reaches the money path", async () => {
    d.jobPostings.getOneForPayer.mockRejectedValueOnce(new Error("Job posting not found"));
    await expect(d.ctrl.topUpQuota(POSTING, { tier: "topup_10" }, PAYER_A, NO_KEY, CTX)).rejects.toThrow();
    expect(d.plans.topUpQuotaForPayer).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #2085 — POST /payer/job-postings/:id/quota-topup honours Idempotency-Key, through the SAME
// seam, scoping, window and conflict/replay semantics as POST /payer/capacity (#1148). These
// cases drive the REAL RequestIdempotency against an in-memory Redis.
// ---------------------------------------------------------------------------
describe("#2085 — one confirmed tap is one quota top-up", () => {
  const withKey = (key: string): Request =>
    ({
      header: (n: string) => (n.toLowerCase() === "idempotency-key" ? key : undefined),
    }) as unknown as Request;

  function ctrlWithRealSeam() {
    const store = new Map<string, string>();
    const redis = {
      async set(key: string, value: string, _m: string, _s: number, nx?: string) {
        if (nx === "NX" && store.has(key)) return null;
        store.set(key, value);
        return "OK";
      },
      async get(key: string) {
        return store.get(key) ?? null;
      },
    };
    const pii = {
      // A REAL digest, so distinct keys can never collide by construction of the double.
      hmac: (v: string) => createHash("sha256").update(v).digest("hex"),
      encrypt: (v: string) => v,
      decrypt: (v: string) => v,
    };
    const seam = new RequestIdempotency(pii as never, { client: Promise.resolve(redis) } as never);
    const d = makeCtrl();
    // Each charge stamps a DISTINGUISHABLE running total, as the real atomic increment does, so
    // "second equals first" can only come from a replay — never from two identical charges.
    let charges = 0;
    d.plans.topUpQuotaForPayer.mockImplementation(async () => {
      charges += 1;
      return { plan: { id: "plan-1", quotaTopupCount: 10 * charges } };
    });
    const ctrl = new PayerJobPostingsController(
      d.jobPostings as never,
      d.plans as never,
      d.disclosures as never,
      seam,
    );
    return { ctrl, topUp: d.plans.topUpQuotaForPayer, jobPostings: d.jobPostings, store };
  }

  const TOPUP = { tier: "topup_10" };

  it("THE DOUBLE CHARGE: the same key twice tops up ONCE and replays the original result", async () => {
    const { ctrl, topUp } = ctrlWithRealSeam();
    const first = await ctrl.topUpQuota(POSTING, TOPUP, PAYER_B, withKey("tap-1"), CTX);
    const second = await ctrl.topUpQuota(POSTING, TOPUP, PAYER_B, withKey("tap-1"), CTX);
    expect(topUp).toHaveBeenCalledTimes(1);
    expect(second).toStrictEqual(first);
    expect(second).toEqual({ plan: { id: "plan-1", quotaTopupCount: 10 } });
  });

  it("a DIFFERENT key tops up again — two confirmed purchases are two charges", async () => {
    const { ctrl, topUp } = ctrlWithRealSeam();
    await ctrl.topUpQuota(POSTING, TOPUP, PAYER_B, withKey("tap-a"), CTX);
    const second = await ctrl.topUpQuota(POSTING, TOPUP, PAYER_B, withKey("tap-b"), CTX);
    expect(topUp).toHaveBeenCalledTimes(2);
    expect(second).toEqual({ plan: { id: "plan-1", quotaTopupCount: 20 } });
  });

  it("NO key behaves exactly as before (legacy clients) and reserves nothing", async () => {
    const { ctrl, topUp, store } = ctrlWithRealSeam();
    await ctrl.topUpQuota(POSTING, TOPUP, PAYER_B, NO_KEY, CTX);
    await ctrl.topUpQuota(POSTING, TOPUP, PAYER_B, NO_KEY, CTX);
    expect(topUp).toHaveBeenCalledTimes(2);
    expect(store.size).toBe(0);
  });

  it("a duplicate landing MID-FLIGHT is refused 409 and never starts a second charge", async () => {
    const { ctrl, topUp } = ctrlWithRealSeam();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    topUp.mockImplementationOnce(async () => {
      await gate;
      return { plan: { id: "plan-1", quotaTopupCount: 10 } };
    });
    const inflight = ctrl.topUpQuota(POSTING, TOPUP, PAYER_B, withKey("tap-2"), CTX);
    await expect(
      ctrl.topUpQuota(POSTING, TOPUP, PAYER_B, withKey("tap-2"), CTX),
    ).rejects.toBeInstanceOf(ConflictException);
    release();
    await inflight;
    expect(topUp).toHaveBeenCalledTimes(1);
  });

  it("SAME KEY, DIFFERENT TIER replays the first purchase (capacity's decision: the key names the intent)", async () => {
    const { ctrl, topUp } = ctrlWithRealSeam();
    const first = await ctrl.topUpQuota(POSTING, TOPUP, PAYER_B, withKey("tap-3"), CTX);
    const second = await ctrl.topUpQuota(
      POSTING,
      { tier: "topup_25" },
      PAYER_B,
      withKey("tap-3"),
      CTX,
    );
    expect(topUp).toHaveBeenCalledTimes(1);
    expect(second).toStrictEqual(first);
  });

  it("a price-mismatch 409 is stored under the key and replayed — the retry is never charged", async () => {
    const { ctrl, topUp } = ctrlWithRealSeam();
    topUp.mockRejectedValueOnce(new ConflictException("The price changed"));
    const body = { tier: "topup_10", expected_price_inr: 1 };
    await expect(
      ctrl.topUpQuota(POSTING, body, PAYER_B, withKey("tap-4"), CTX),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      ctrl.topUpQuota(POSTING, body, PAYER_B, withKey("tap-4"), CTX),
    ).rejects.toMatchObject({ status: 409 });
    expect(topUp).toHaveBeenCalledTimes(1);
  });

  it("another payer's key does NOT reach this payer's bucket (XB-A)", async () => {
    const { ctrl, topUp } = ctrlWithRealSeam();
    await ctrl.topUpQuota(POSTING, TOPUP, PAYER_A, withKey("shared"), CTX);
    await ctrl.topUpQuota(POSTING, TOPUP, PAYER_B, withKey("shared"), CTX);
    expect(topUp).toHaveBeenCalledTimes(2);
  });

  it("uses its OWN scope, never the raw header, and checks ownership before reserving", async () => {
    const { ctrl, store, jobPostings, topUp } = ctrlWithRealSeam();
    const raw = "raw-header-2085";
    await ctrl.topUpQuota(POSTING, TOPUP, PAYER_B, withKey(raw), CTX);
    const keys = [...store.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain(`payer_idem:quota_topup_purchase:${PAYER_B.id}:`);
    expect(keys[0]).not.toContain(raw);
    expect(keys[0]).not.toMatch(/capacity_purchase|credits_purchase/);

    // A foreign/unknown posting is a neutral 404 BEFORE any reservation or charge.
    jobPostings.getOneForPayer.mockRejectedValueOnce(new Error("Job posting not found"));
    await expect(
      ctrl.topUpQuota(POSTING, TOPUP, PAYER_B, withKey("foreign"), CTX),
    ).rejects.toThrow();
    expect(store.size).toBe(1);
    expect(topUp).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// #2103 — POST /payer/job-postings/:id/plan (and /boost) honour Idempotency-Key, configured
// exactly like quota top-up (#2085): own scope, session payer, same window, ownership 404
// before reserving, mid-flight duplicate → 409. Also: a replayed stored error carries the SAME
// structured body (the review finding) on every paid posting route. REAL RequestIdempotency
// against an in-memory Redis; error bodies rendered through the REAL global filter.
// ---------------------------------------------------------------------------

function postingCtrlWithRealSeam() {
  const store = new Map<string, string>();
  const redis = {
    async set(key: string, value: string, _m: string, _s: number, nx?: string) {
      if (nx === "NX" && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    async get(key: string) {
      return store.get(key) ?? null;
    },
  };
  const pii = {
    hmac: (v: string) => createHash("sha256").update(v).digest("hex"),
    encrypt: (v: string) => v,
    decrypt: (v: string) => v,
  };
  const seam = new RequestIdempotency(pii as never, { client: Promise.resolve(redis) } as never);
  const d = makeCtrl();
  // Distinguishable per-charge results, so "second equals first" can only be a replay.
  let charges = 0;
  d.plans.buyPlanForPayer.mockImplementation(async () => {
    charges += 1;
    return { plan: { id: `plan-${charges}` } };
  });
  d.plans.buyBoostForPayer.mockImplementation(async () => {
    charges += 1;
    return { boost: { id: `boost-${charges}` } };
  });
  const ctrl = new PayerJobPostingsController(
    d.jobPostings as never,
    d.plans as never,
    d.disclosures as never,
    seam,
  );
  return { ctrl, plans: d.plans, jobPostings: d.jobPostings, store };
}

type SeamCtx = ReturnType<typeof postingCtrlWithRealSeam>;
type ChargeMock = SeamCtx["plans"]["buyPlanForPayer"] | SeamCtx["plans"]["buyBoostForPayer"];

const keyed = (key: string): Request =>
  ({
    header: (n: string) => (n.toLowerCase() === "idempotency-key" ? key : undefined),
  }) as unknown as Request;

interface PaidRoute {
  readonly name: string;
  readonly scope: string;
  readonly call: (c: SeamCtx, payer: AuthenticatedPayer, req: Request) => Promise<unknown>;
  readonly charge: (c: SeamCtx) => ChargeMock;
}

const PLAN_ROUTE: PaidRoute = {
  name: "plan",
  scope: "plan_purchase",
  call: (c, payer, req) => c.ctrl.buyPlan(POSTING, { tier: "standard" }, payer, req, CTX),
  charge: (c) => c.plans.buyPlanForPayer,
};
const BOOST_ROUTE: PaidRoute = {
  name: "boost",
  scope: "boost_purchase",
  call: (c, payer, req) => c.ctrl.buyBoost(POSTING, { tier: "all_candidates" }, payer, req, CTX),
  charge: (c) => c.plans.buyBoostForPayer,
};

describe.each([PLAN_ROUTE, BOOST_ROUTE])("#2103 — one confirmed tap is one $name purchase", (route) => {
  it("THE DOUBLE CHARGE: the same key twice charges ONCE and replays the original result", async () => {
    const c = postingCtrlWithRealSeam();
    const first = await route.call(c, PAYER_B, keyed("tap-1"));
    const second = await route.call(c, PAYER_B, keyed("tap-1"));
    expect(route.charge(c)).toHaveBeenCalledTimes(1);
    expect(second).toStrictEqual(first);
  });

  it("a DIFFERENT key charges again — two confirmed purchases are two charges", async () => {
    const c = postingCtrlWithRealSeam();
    const first = await route.call(c, PAYER_B, keyed("tap-a"));
    const second = await route.call(c, PAYER_B, keyed("tap-b"));
    expect(route.charge(c)).toHaveBeenCalledTimes(2);
    expect(second).not.toStrictEqual(first);
  });

  it("NO key behaves exactly as before (legacy clients) and reserves nothing", async () => {
    const c = postingCtrlWithRealSeam();
    await route.call(c, PAYER_B, NO_KEY);
    await route.call(c, PAYER_B, NO_KEY);
    expect(route.charge(c)).toHaveBeenCalledTimes(2);
    expect(c.store.size).toBe(0);
  });

  it("a duplicate landing MID-FLIGHT is refused 409 and never starts a second charge", async () => {
    const c = postingCtrlWithRealSeam();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const charge = route.charge(c) as ReturnType<typeof vi.fn>;
    charge.mockImplementationOnce(async () => {
      await gate;
      return { id: "slow" };
    });
    const inflight = route.call(c, PAYER_B, keyed("tap-2"));
    await expect(route.call(c, PAYER_B, keyed("tap-2"))).rejects.toBeInstanceOf(ConflictException);
    release();
    await inflight;
    expect(charge).toHaveBeenCalledTimes(1);
  });

  it("another payer's key does NOT reach this payer's bucket (XB-A)", async () => {
    const c = postingCtrlWithRealSeam();
    const a = await route.call(c, PAYER_A, keyed("shared"));
    const b = await route.call(c, PAYER_B, keyed("shared"));
    expect(route.charge(c)).toHaveBeenCalledTimes(2);
    expect(b).not.toStrictEqual(a);
  });

  it("uses its OWN scope + the session payer, never the raw header, and checks ownership before reserving", async () => {
    const c = postingCtrlWithRealSeam();
    const raw = "raw-header-2103";
    await route.call(c, PAYER_B, keyed(raw));
    const keys = [...c.store.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain(`payer_idem:${route.scope}:${PAYER_B.id}:`);
    expect(keys[0]).not.toContain(raw);

    // A foreign/unknown posting is a neutral 404 BEFORE any reservation or charge.
    c.jobPostings.getOneForPayer.mockRejectedValueOnce(new Error("Job posting not found"));
    await expect(route.call(c, PAYER_B, keyed("foreign"))).rejects.toThrow();
    expect(c.store.size).toBe(1);
    expect(route.charge(c)).toHaveBeenCalledTimes(1);
  });
});

describe("#2103 — plan and boost never share a dedupe bucket", () => {
  it("the same key on plan then boost charges BOTH (separate scopes)", async () => {
    const c = postingCtrlWithRealSeam();
    await PLAN_ROUTE.call(c, PAYER_B, keyed("one-key"));
    const boost = await BOOST_ROUTE.call(c, PAYER_B, keyed("one-key"));
    expect(c.plans.buyPlanForPayer).toHaveBeenCalledTimes(1);
    expect(c.plans.buyBoostForPayer).toHaveBeenCalledTimes(1);
    expect(boost).toHaveProperty("boost");
  });
});

describe("#2103 — a replayed price_mismatch 409 carries the IDENTICAL structured body", () => {
  const ROUTES: readonly {
    readonly name: string;
    readonly charge: (c: SeamCtx) => ReturnType<typeof vi.fn>;
    readonly call: (c: SeamCtx, req: Request) => Promise<unknown>;
  }[] = [
    {
      name: "plan",
      charge: (c) => c.plans.buyPlanForPayer as ReturnType<typeof vi.fn>,
      call: (c, req) =>
        c.ctrl.buyPlan(POSTING, { tier: "standard", expected_price_inr: 1 }, PAYER_B, req, CTX),
    },
    {
      name: "boost",
      charge: (c) => c.plans.buyBoostForPayer as ReturnType<typeof vi.fn>,
      call: (c, req) =>
        c.ctrl.buyBoost(
          POSTING,
          { tier: "all_candidates", expected_price_inr: 1 },
          PAYER_B,
          req,
          CTX,
        ),
    },
    {
      name: "quota-topup",
      charge: (c) => c.plans.topUpQuotaForPayer as ReturnType<typeof vi.fn>,
      call: (c, req) =>
        c.ctrl.topUpQuota(POSTING, { tier: "topup_10", expected_price_inr: 1 }, PAYER_B, req, CTX),
    },
  ];

  it.each(ROUTES)("$name: the retry gets the same status and the same error body, uncharged", async (r) => {
    const c = postingCtrlWithRealSeam();
    const charge = r.charge(c);
    // The REAL price guard, so the body under test is exactly what production throws.
    charge.mockImplementationOnce(async () => {
      assertExpectedPrice(1, 499);
      return {};
    });
    const first = await caught(r.call(c, keyed("tap-pm")));
    const replay = await caught(r.call(c, keyed("tap-pm")));
    expect(charge).toHaveBeenCalledTimes(1);
    expect(replay).toMatchObject({ status: 409 });
    expect(renderedError(replay)).toStrictEqual(renderedError(first));
    expect(renderedError(replay)).toMatchObject({
      reason: "price_mismatch",
      expected_price_inr: 1,
      current_price_inr: 499,
    });
  });
});
