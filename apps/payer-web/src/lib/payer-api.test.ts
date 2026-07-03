import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Tenancy + no-raw-phone tests for the payer data seam (ADR-0019 XB-A / ADR-0010 F-4).
 *
 * These exercise the REAL HTTP transport (`payerFetch`) with a mocked `fetch` + a
 * mocked payer-JWT cookie, asserting:
 *  - TENANCY (XB-A): the outbound unlock/reveal requests NEVER carry a client
 *    `payer_id` — the identity rides ONLY the Bearer token from the server session.
 *  - NO RAW PHONE (F-4): the reveal result the seam returns is a routed relay handle
 *    only; there is no phone/number field, and a phone-like wire body fails to parse.
 */

const TOKEN = "payer.jwt.token";

// Mock the session-cookie reader so the transport has a Bearer token.
vi.mock("./auth/session-cookie", () => ({
  readApiToken: vi.fn(async () => TOKEN),
  API_TOKEN_COOKIE_NAME: "bb_payer_token",
  sessionCookieOptions: () => ({}),
}));

// Mock the session resolver used by getDashboard (not under test here).
vi.mock("./auth", () => ({
  requirePayer: vi.fn(async () => ({
    payerId: "11111111-1111-4111-8111-111111111111",
    displayLabel: "Acme",
    role: "employer",
  })),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  process.env.PAYER_API_URL = "http://api.test";
  process.env.PAYMENTS_ENABLE_REAL = "false";
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A LIVE job-posting wire row (the `JobPosting` Drizzle row the payer-authed controller
 * returns). Carries the payer's OWN org_label + free-text description on purpose — the seam
 * mapper must DROP them so they never reach the faceless PostingSummary the UI consumes.
 */
const POSTING_ID = "bbbb2222-0000-4000-8000-000000000001";

function jobPostingRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: POSTING_ID,
    payerId: "11111111-1111-4111-8111-111111111111",
    createdBy: "11111111-1111-4111-8111-111111111111",
    orgLabel: "Acme Manufacturing",
    roleTitle: "CNC Machinist",
    locationLabel: "Pune, MH",
    description: "Two-shift CNC role, PPE provided.",
    vacancyBand: "6-10", // the BACKEND band-set (distinct from the frontend bands)
    status: "draft",
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    closedAt: null,
    ...over,
  };
}

describe("requestUnlock — tenancy (XB-A): no client payer_id is ever sent", () => {
  it("posts ONLY worker_id + job_id, with the Bearer token, never a payer_id", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        ok: true,
        unlock_id: "22222222-2222-4222-8222-222222222222",
        status: "granted",
        expires_at: "2026-07-01T00:00:00.000Z",
      }),
    );
    const { requestUnlock } = await import("./payer-api");
    const res = await requestUnlock({
      postingId: "33333333-3333-4333-8333-333333333333",
      workerId: "44444444-4444-4444-8444-444444444444",
    });

    expect(res).toMatchObject({ ok: true, status: "granted" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/payer/unlocks");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // The ONLY keys are worker_id + job_id — there is NO payer_id (XB-A).
    expect(Object.keys(body).sort()).toEqual(["job_id", "worker_id"]);
    expect(body).not.toHaveProperty("payer_id");
    expect(JSON.stringify(body)).not.toMatch(/payer_id/);
  });

  it("collapses a neutral unlock body to the single unavailable result (no-oracle)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "unavailable" }));
    const { requestUnlock } = await import("./payer-api");
    const res = await requestUnlock({
      postingId: "33333333-3333-4333-8333-333333333333",
      workerId: "44444444-4444-4444-8444-444444444444",
    });
    expect(res).toEqual({ status: "unavailable" });
  });
});

describe("reveal — NO RAW PHONE (F-4): routed relay handle only", () => {
  it("returns a routed handle and sends no payer_id; the result has no phone field", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        relay_handle: "relay_opaque_xyz",
        channel: "in_app_relay",
        expires_at: "2026-07-01T00:00:00.000Z",
      }),
    );
    const { reveal } = await import("./payer-api");
    const res = await reveal({ unlockId: "22222222-2222-4222-8222-222222222222" });

    expect("relay_handle" in res && res.relay_handle).toBe("relay_opaque_xyz");
    // No phone/number field anywhere in the returned shape.
    expect(JSON.stringify(res)).not.toMatch(/\+?\d{7,}/);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/payer/unlocks/22222222-2222-4222-8222-222222222222/reveal");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty("payer_id");
  });

  it("a phone-bearing wire body fails to parse (raw phone can never surface)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ phone: "+919876543210" }));
    const { reveal } = await import("./payer-api");
    await expect(reveal({ unlockId: "22222222-2222-4222-8222-222222222222" })).rejects.toThrow();
  });
});

describe("getCredits — reads the session-scoped balance (no client payer_id)", () => {
  it("GETs /payer/credits with the Bearer token and maps the wire shape", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ payer_id: "11111111-1111-4111-8111-111111111111", balance: 7 }),
    );
    const { getCredits } = await import("./payer-api");
    const res = await getCredits();
    expect(res.balance).toBe(7);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/payer/credits");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    // A GET carries no body, hence no place for a client payer_id.
    expect(init.body).toBeUndefined();
  });
});

describe("topUp — buy-pack wiring (LIVE): POSTs ONLY { pack_code } + Bearer", () => {
  it("posts pack_code only (no payer_id, no price, no credits) and maps the balance", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          payer_id: "11111111-1111-4111-8111-111111111111",
          balance: 57,
          credits: 50,
          pack_code: "pack_50",
        },
        201,
      ),
    );
    const { topUp } = await import("./payer-api");
    const res = await topUp({ packCode: "pack_50" });

    // Money is MOCK — realCall stays false; the balance/credits map off the wire.
    expect(res).toMatchObject({
      balance: 57,
      creditsAdded: 50,
      packCode: "pack_50",
      realCall: false,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/payer/credits");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // The ONLY key is pack_code — no payer_id, no price, no credits (XB-A).
    expect(Object.keys(body)).toEqual(["pack_code"]);
    expect(body).not.toHaveProperty("payer_id");
    expect(body).not.toHaveProperty("price");
    expect(body).not.toHaveProperty("credits");
    expect(JSON.stringify(body)).not.toMatch(/payer_id/);
  });

  it("records the successful purchase on the session payer's mock ledger (config-priced)", async () => {
    const PAYER = "11111111-1111-4111-8111-111111111111"; // the requirePayer-mocked session
    const store = await import("./mock-store");
    const before = store.getTopUps(PAYER).length;
    fetchMock.mockResolvedValue(
      jsonResponse(
        { payer_id: PAYER, balance: 107, credits: 50, pack_code: "pack_50" },
        201,
      ),
    );
    const { topUp } = await import("./payer-api");
    await topUp({ packCode: "pack_50" });
    const after = store.getTopUps(PAYER);
    expect(after.length).toBe(before + 1);
    // Newest-first; the amount is resolved from the catalog (XT5), never echoed from the client.
    expect(after[0]!.packCode).toBe("pack_50");
    expect(after[0]!.priceInr).toBe(2000);
  });

  it("maps an unknown-pack 404 to a neutral null and does NOT touch the ledger", async () => {
    const PAYER = "11111111-1111-4111-8111-111111111111";
    const store = await import("./mock-store");
    const before = store.getTopUps(PAYER).length;
    fetchMock.mockResolvedValue(jsonResponse({ message: "Unknown credit pack" }, 404));
    const { topUp } = await import("./payer-api");
    const res = await topUp({ packCode: "does_not_exist" });
    expect(res).toBeNull();
    // The 404 returns before recordTopUp — the ledger is untouched.
    expect(store.getTopUps(PAYER).length).toBe(before);
  });
});

describe("getCapacity — capacity wiring (LIVE): GETs /payer/capacity with Bearer, no payer_id", () => {
  const PAYER_A = "11111111-1111-4111-8111-111111111111";

  const POSTING_2 = "bbbb2222-0000-4000-8000-000000000002";

  /**
   * A `GET /payer/job-postings/:id/plan` wire body (the `feat/be-posting-plan-read` shape).
   * `over.plan` may override the nested plan or set it to null (a valid "no plan yet" 200).
   */
  function postingPlanBody(
    jobPostingId: string,
    plan: Record<string, unknown> | null,
  ): Record<string, unknown> {
    return { job_posting_id: jobPostingId, plan };
  }

  it("GETs /payer/capacity (Bearer, no body) and maps max_active_vacancies to the allowance", async () => {
    // getCapacity now fetches /payer/capacity + /payer/job-postings + one /:id/plan per posting
    // (the per-posting DISPLAY rows are the LIVE postings, enriched with the LIVE plan quota).
    // Branch the mock per URL.
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/payer/capacity")) {
        return Promise.resolve(
          jsonResponse({
            payer_id: PAYER_A,
            max_active_vacancies: 9,
            // The REAL active-plan count from the enforcement engine (A3). Pinned to a value
            // (4) that is NOT the count of the live posting rows below, so the assertion
            // proves `activeVacancies` is the LIVE engine count, never a row count.
            active_plan_count: 4,
            source_tier: null,
            expires_at: null,
          }),
        );
      }
      // The per-posting plan reads (enrich the DISPLAY rows with the LIVE effective quota).
      if (url.endsWith(`/payer/job-postings/${POSTING_ID}/plan`)) {
        return Promise.resolve(
          jsonResponse(
            postingPlanBody(POSTING_ID, {
              tier: "standard",
              status: "active",
              applicant_visibility_quota: 10,
              quota_topup_count: 5,
              effective_quota: 15, // base 10 + 5 top-ups — the number the row must show
              applicants_viewed_count: 3,
              paid_at: "2026-06-20T00:00:00.000Z",
              expires_at: "2026-09-20T00:00:00.000Z",
            }),
          ),
        );
      }
      if (url.endsWith(`/payer/job-postings/${POSTING_2}/plan`)) {
        // A plan-less posting → a valid { plan: null } 200 → the row's quota degrades to 0.
        return Promise.resolve(jsonResponse(postingPlanBody(POSTING_2, null)));
      }
      // The per-posting DISPLAY rows are now the LIVE postings (2 rows ≠ the active_plan_count 4).
      return Promise.resolve(
        jsonResponse([jobPostingRow(), jobPostingRow({ id: POSTING_2, status: "open" })]),
      );
    });
    const { getCapacity } = await import("./payer-api");
    const cap = await getCapacity();

    expect(cap.payerId).toBe(PAYER_A);
    // The allowance comes from the LIVE endpoint, not the config baseline.
    expect(cap.activeVacancyAllowance).toBe(9);
    // activeVacancies is the REAL enforcement-engine active_plan_count (4) — NOT a count
    // derived from the live posting rows (2 rows), proving it is not a row filter.
    expect(cap.activeVacancies).toBe(4);
    // Per-posting rows are the LIVE postings — DISPLAY-only, and they do NOT drive
    // `activeVacancies` (proven above: 4 ≠ the 2 posting rows).
    expect(cap.postings.length).toBe(2);
    expect(cap.postings.length).not.toBe(cap.activeVacancies);

    // Each row's applicantQuota is the LIVE plan EFFECTIVE quota (base + top-ups), 0 for plan-less.
    const row1 = cap.postings.find((p) => p.postingId === POSTING_ID)!;
    const row2 = cap.postings.find((p) => p.postingId === POSTING_2)!;
    expect(row1.applicantQuota).toBe(15); // effective_quota (base 10 + 5 top-ups)
    expect(row2.applicantQuota).toBe(0); // { plan: null } → no plan yet → 0
    // applicantQuotaTotal is the SUM of the enriched per-row effective quotas.
    expect(cap.applicantQuotaTotal).toBe(15);

    const capCall = fetchMock.mock.calls.find((c) => (c[0] as string).endsWith("/payer/capacity")) as
      | [string, RequestInit]
      | undefined;
    expect(capCall).toBeDefined();
    expect(capCall![0]).toBe("http://api.test/payer/capacity");
    expect((capCall![1].headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    // A GET carries no body, hence no place for a client payer_id.
    expect(capCall![1].body).toBeUndefined();

    // The per-posting plan reads were issued (one per posting), Bearer, no body (XB-A).
    const planCall = fetchMock.mock.calls.find((c) =>
      (c[0] as string).endsWith(`/payer/job-postings/${POSTING_ID}/plan`),
    ) as [string, RequestInit] | undefined;
    expect(planCall).toBeDefined();
    expect((planCall![1].headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(planCall![1].body).toBeUndefined();
  });

  it("a real HTTP failure on a per-posting plan read PROPAGATES — getCapacity rejects (page error state, never a silent 0)", async () => {
    // Pins the documented contract: getPostingPlan does NOT catch, so a hard failure (500/
    // 404) on any one /:id/plan makes getCapacity's Promise.all reject and the page shows its
    // error state. Only a VALID { plan: null } 200 degrades to 0 — a real error must never be
    // swallowed. (Guards against a future try/catch→?? 0 regression that would invert this.)
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/payer/capacity")) {
        return Promise.resolve(
          jsonResponse({
            payer_id: PAYER_A,
            max_active_vacancies: 9,
            active_plan_count: 4,
            source_tier: null,
            expires_at: null,
          }),
        );
      }
      // One posting's plan read HARD-fails (500) — not a valid { plan: null }.
      if (url.endsWith(`/payer/job-postings/${POSTING_ID}/plan`)) {
        return Promise.resolve(jsonResponse({ message: "boom" }, 500));
      }
      if (url.endsWith(`/payer/job-postings/${POSTING_2}/plan`)) {
        return Promise.resolve(jsonResponse(postingPlanBody(POSTING_2, null)));
      }
      return Promise.resolve(
        jsonResponse([jobPostingRow(), jobPostingRow({ id: POSTING_2, status: "open" })]),
      );
    });
    const { getCapacity } = await import("./payer-api");
    await expect(getCapacity()).rejects.toThrow();
  });

  it("PII-free: the enriched capacity payload carries no worker id / phone / name / email", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/payer/capacity")) {
        return Promise.resolve(
          jsonResponse({
            payer_id: PAYER_A,
            max_active_vacancies: 9,
            active_plan_count: 1,
            source_tier: null,
            expires_at: null,
          }),
        );
      }
      if (url.endsWith(`/payer/job-postings/${POSTING_ID}/plan`)) {
        return Promise.resolve(
          jsonResponse(
            postingPlanBody(POSTING_ID, {
              tier: "pro",
              status: "active",
              applicant_visibility_quota: 20,
              quota_topup_count: 0,
              effective_quota: 20,
              applicants_viewed_count: 2,
              paid_at: null,
              expires_at: null,
            }),
          ),
        );
      }
      return Promise.resolve(jsonResponse([jobPostingRow()]));
    });
    const { getCapacity } = await import("./payer-api");
    const cap = await getCapacity();
    const json = JSON.stringify(cap);
    // No worker identity of any kind, and no PII-looking key/value in the enriched payload.
    // (The payer's OWN payerId is a legitimate UUID — a masked, hyphen-broken opaque id, NOT
    // worker PII; assert on PII KEYS/labels instead of a bare digit-run that a UUID trips.)
    expect(json).not.toMatch(/phone|\bemail\b|worker[_-]?id|employer|address/i);
    expect(json).not.toMatch(/"name"/i);
    // The row's ONLY worker-adjacent number is the config-derived quota — never an identity.
    expect(cap.postings[0]!.applicantQuota).toBe(20);
  });
});

describe("getPostingPlan — LIVE: GETs /payer/job-postings/:id/plan, maps the effective quota", () => {
  const PLAN_POSTING = "bbbb2222-0000-4000-8000-0000000000aa";

  it("GETs the plan (Bearer, no body) and surfaces the effective quota on the mapped view", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        job_posting_id: PLAN_POSTING,
        plan: {
          tier: "pro",
          status: "active",
          applicant_visibility_quota: 20,
          quota_topup_count: 10,
          effective_quota: 30,
          applicants_viewed_count: 7,
          paid_at: "2026-06-20T00:00:00.000Z",
          expires_at: "2026-09-20T00:00:00.000Z",
        },
      }),
    );
    const { getPostingPlan } = await import("./payer-api");
    const view = await getPostingPlan(PLAN_POSTING);

    expect(view.jobPostingId).toBe(PLAN_POSTING);
    expect(view.plan).not.toBeNull();
    expect(view.plan!.effectiveQuota).toBe(30);
    expect(view.plan!.applicantVisibilityQuota).toBe(20);
    expect(view.plan!.quotaTopupCount).toBe(10);
    expect(view.plan!.applicantsViewedCount).toBe(7);
    expect(view.plan!.tier).toBe("pro");
    expect(view.plan!.status).toBe("active");
    // Pin the FULL wire→view field map: the nullable timestamps must land (a mapper that
    // swapped paid_at↔expires_at or dropped one would otherwise slip through).
    expect(view.plan!.paidAt).toBe("2026-06-20T00:00:00.000Z");
    expect(view.plan!.expiresAt).toBe("2026-09-20T00:00:00.000Z");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://api.test/payer/job-postings/${PLAN_POSTING}/plan`);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    // A GET carries no body, hence no place for a client payer_id (XB-A).
    const json = JSON.stringify(view);
    expect(json).not.toMatch(/payer_id|phone|\bemail\b|worker|name/i);
  });

  it("a { plan: null } body (owned, no plan yet) maps to { plan: null } — a valid 200, no throw", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ job_posting_id: PLAN_POSTING, plan: null }));
    const { getPostingPlan } = await import("./payer-api");
    const view = await getPostingPlan(PLAN_POSTING);
    expect(view).toEqual({ jobPostingId: PLAN_POSTING, plan: null });
  });

  it("a neutral 404 (foreign/unknown posting) PROPAGATES — not special-cased (no-oracle upstream)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "not found" }, 404));
    const { getPostingPlan } = await import("./payer-api");
    await expect(getPostingPlan(PLAN_POSTING)).rejects.toThrow();
  });
});

describe("buyCapacity — capacity BUY (A1, LIVE): POSTs ONLY { tier } + Bearer (XB-A / XT5)", () => {
  const PAYER_A = "11111111-1111-4111-8111-111111111111";

  it("posts ONLY { tier } (no payer_id — XB-A; no price/amount/quota — XT5) and maps resumed_plan_ids", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        payer_id: PAYER_A,
        // Server-priced receipt — NOT surfaced to the UI; carries a price/amount we must NOT echo.
        quote: { amount_inr: 4999, currency: "INR", line_items: [{ price: 4999 }] },
        max_active_vacancies: 10,
        source_tier: "growth",
        expires_at: "2026-12-31T00:00:00.000Z",
        resumed_plan_ids: [
          "aaaa1111-0000-4000-8000-000000000001",
          "aaaa1111-0000-4000-8000-000000000002",
        ],
      }),
    );
    const { buyCapacity } = await import("./payer-api");
    const res = await buyCapacity({ tier: "growth" });

    expect(res).toEqual({
      ok: true,
      allowance: 10,
      sourceTier: "growth",
      expiresAt: "2026-12-31T00:00:00.000Z",
      resumedPlanIds: [
        "aaaa1111-0000-4000-8000-000000000001",
        "aaaa1111-0000-4000-8000-000000000002",
      ],
    });
    // The server-priced quote (with its price) is NEVER surfaced to the UI (XT5).
    expect(JSON.stringify(res)).not.toMatch(/quote|amount|price|4999/i);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/payer/capacity");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // XB-A: the ONLY body key is `tier` — no payer_id.
    expect(Object.keys(body)).toEqual(["tier"]);
    expect(body).not.toHaveProperty("payer_id");
    expect(JSON.stringify(body)).not.toMatch(/payer_id/);
    // XT5: the client NEVER sends a price / amount / quota.
    expect(body).not.toHaveProperty("price");
    expect(body).not.toHaveProperty("amount");
    expect(body).not.toHaveProperty("quota");
    expect(JSON.stringify(body)).not.toMatch(/price|amount|quota|₹|\binr\b/i);
  });

  it("maps an empty resumed_plan_ids list to resumedPlanIds: [] (no postings to resume)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        payer_id: PAYER_A,
        quote: {},
        max_active_vacancies: 5,
        source_tier: "starter",
        expires_at: null,
        resumed_plan_ids: [],
      }),
    );
    const { buyCapacity } = await import("./payer-api");
    const res = await buyCapacity({ tier: "starter" });
    expect(res).toEqual({
      ok: true,
      allowance: 5,
      sourceTier: "starter",
      expiresAt: null,
      resumedPlanIds: [],
    });
  });

  it("returns a NEUTRAL { ok:false } on a thrown transport error — no leaked reason, never a fake success", async () => {
    fetchMock.mockRejectedValue(new Error("http://api.test/payer/capacity returned 500"));
    const { buyCapacity } = await import("./payer-api");
    const res = await buyCapacity({ tier: "growth" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      // FACELESS / no-oracle: the neutral error carries no role name / deny cause / PII.
      expect(res.error).not.toMatch(/payer_id|forbidden|employer|agent|consent|phone|email/i);
    }
  });

  it("FACELESS: the buy result carries only ids/counts/tier/timestamps — no PII-looking key", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        payer_id: PAYER_A,
        quote: { amount_inr: 4999 },
        max_active_vacancies: 10,
        source_tier: "growth",
        expires_at: "2026-12-31T00:00:00.000Z",
        resumed_plan_ids: ["aaaa1111-0000-4000-8000-000000000001"],
      }),
    );
    const { buyCapacity } = await import("./payer-api");
    const res = await buyCapacity({ tier: "growth" });
    // No name/phone/email/employer/address key anywhere in the surfaced payload.
    expect(JSON.stringify(res)).not.toMatch(/name|phone|employer|email|address/i);
  });
});

/**
 * WAITING-mock seam: the posting PAUSE / RESUME / quota-top-up lifecycle. These bind to the
 * SERVER-HELD session payer (the mocked `requirePayer` above → PAYER_A) and never accept a
 * client payer id. They serve from the in-memory mock store, so they do NOT hit fetch.
 * (createPosting / getPostings / get-one / edit / close are now LIVE — covered below.)
 */
describe("job-management seam — server-held payer, config-driven (WAITING mock)", () => {
  const PAYER_A = "11111111-1111-4111-8111-111111111111";

  it("pause/resume/top-up operate only on the session payer's own postings", async () => {
    const store = await import("./mock-store");
    store.__resetForTest(PAYER_A, true);
    const { pausePosting, resumePosting, topUpPostingQuota } = await import("./payer-api");

    // The lifecycle shims still operate on the MOCK store; source the seed id from it DIRECTLY
    // (getPostings is now LIVE and would hit fetch). These three never call fetch themselves.
    const seeded = store.getPostings(PAYER_A);
    const id = seeded[0]!.id;

    const paused = await pausePosting({ postingId: id });
    expect(paused?.status).toBe("paused");
    const resumed = await resumePosting({ postingId: id });
    expect(resumed?.status).toBe("open");

    const beforeQuota = seeded[0]!.applicantQuota ?? 0;
    const topped = await topUpPostingQuota({ postingId: id });
    expect(topped!.applicantQuota!).toBeGreaterThan(beforeQuota);

    // None of these touched fetch (they are mock-store shims, not LIVE calls).
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null (neutral not-found) for a posting id the session payer doesn't own", async () => {
    const store = await import("./mock-store");
    store.__resetForTest(PAYER_A, true);
    const { pausePosting } = await import("./payer-api");
    const res = await pausePosting({ postingId: "99999999-9999-4999-8999-999999999999" });
    expect(res).toBeNull();
  });
});

/**
 * LIVE EMPLOYER posting CRUD (`/payer/job-postings`). Asserts the swap off the mock store:
 *  - TENANCY (XB-A): bodies NEVER carry payer_id/created_by; org_label is the SESSION org
 *    (resolved from GET /payer/me), never a client field; the create sends the RAW vacancies.
 *  - PII (invariant #2): the wire row carries the payer's OWN org_label + free-text
 *    description, but the seam mapper DROPS them — the faceless PostingSummary that reaches a
 *    page has no org_label/description/createdBy/payerId.
 *  - no-oracle: an unknown-or-not-owned id maps to a neutral `null`.
 */
describe("createPosting — LIVE: org_label from /payer/me, faceless body, PII dropped", () => {
  const PAYER_A = "11111111-1111-4111-8111-111111111111";

  it("resolves org_label from GET /payer/me, POSTs the RAW vacancies, never payer_id/created_by", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/payer/me")) {
        return Promise.resolve(
          jsonResponse({ id: PAYER_A, role: "employer", status: "active", orgName: "Acme Manufacturing" }),
        );
      }
      return Promise.resolve(jsonResponse(jobPostingRow(), 201));
    });
    const { createPosting, toPayerJobPostingBody } = await import("./payer-api");
    const input = {
      tradeKey: "cnc_operator" as const,
      roleTitle: "CNC Machinist",
      locationLabel: "Pune, MH",
      description: "Two-shift CNC role, PPE provided.",
      vacancies: 7,
      payMin: 20000,
      payMax: 35000,
      minExperienceYears: 1,
      maxExperienceYears: 5,
    };
    const res = await createPosting(input);

    const postCall = fetchMock.mock.calls.find(
      (c) => (c[0] as string).endsWith("/payer/job-postings") && (c[1] as RequestInit | undefined)?.method === "POST",
    ) as [string, RequestInit] | undefined;
    expect(postCall).toBeDefined();
    const init = postCall![1];
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // STRONG CONTRACT: the posted body is EXACTLY the toPayerJobPostingBody mapper output for
    // this input + the SESSION org (from /payer/me) — same keys, same values, no extras. This
    // pins "exactly one of vacancy_band|vacancies + no payer_id/created_by" via the mapper itself.
    expect(body).toEqual(toPayerJobPostingBody(input, "Acme Manufacturing"));
    // Spelled out for readability (subsumed by the deep-equal above):
    expect(body.org_label).toBe("Acme Manufacturing");
    expect(body.vacancies).toBe(7);
    expect(body).not.toHaveProperty("vacancy_band");
    expect(body).not.toHaveProperty("payer_id");
    expect(body).not.toHaveProperty("created_by");
    expect(body).not.toHaveProperty("trade_key");
    expect(body).not.toHaveProperty("pay_min");

    // Mapped to the faceless PostingSummary — org_label/description/createdBy/payerId DROPPED.
    expect(Object.keys(res).sort()).toEqual(
      ["applicantCount", "createdAt", "id", "locationLabel", "roleTitle", "status", "vacancyBand"],
    );
    expect(res.applicantCount).toBe(0);
    // The payer's OWN org label + free-text description never reach the UI domain object.
    expect(JSON.stringify(res)).not.toContain("Two-shift CNC role");
    expect(JSON.stringify(res)).not.toContain("Acme Manufacturing");
  });
});

describe("getPostings — LIVE: GETs /payer/job-postings, maps faceless rows, drops PII", () => {
  it("GETs with Bearer (no body) and maps wire rows → faceless PostingSummary[]", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        jobPostingRow(),
        jobPostingRow({
          id: "bbbb2222-0000-4000-8000-000000000002",
          roleTitle: "VMC Operator",
          description: "Night shift; ESI provided.",
          status: "open",
        }),
      ]),
    );
    const { getPostings } = await import("./payer-api");
    const rows = await getPostings();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/payer/job-postings");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);

    expect(rows).toHaveLength(2);
    expect(rows[0]!.roleTitle).toBe("CNC Machinist");
    expect(rows[1]!.status).toBe("open");
    for (const r of rows) {
      // PII-free: no org label, no free-text description, no owner ids reach the UI.
      expect(r).not.toHaveProperty("description");
      expect(r).not.toHaveProperty("orgLabel");
      expect(r).not.toHaveProperty("createdBy");
      expect(r).not.toHaveProperty("payerId");
      expect(r.applicantCount).toBe(0); // not in this projection — the reach feed owns the count
    }
    const json = JSON.stringify(rows);
    expect(json).not.toContain("Night shift");
    expect(json).not.toContain("Acme Manufacturing");
  });
});

describe("getPosting / updatePosting / closePosting — LIVE: faceless, no-oracle 404 → null", () => {
  it("getPosting maps an unknown-or-not-owned 404 to a neutral null (no-oracle)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "Job posting not found" }, 404));
    const { getPosting } = await import("./payer-api");
    expect(await getPosting(POSTING_ID)).toBeNull();
  });

  it("closePosting POSTs :id/close with an empty body + Bearer, maps the closed row", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(jobPostingRow({ status: "closed", closedAt: "2026-06-26T00:00:00.000Z" })),
    );
    const { closePosting } = await import("./payer-api");
    const res = await closePosting(POSTING_ID);
    expect(res?.status).toBe("closed");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://api.test/payer/job-postings/${POSTING_ID}/close`);
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual([]); // empty body — the session is the identity (XB-A)
    expect(body).not.toHaveProperty("payer_id");
  });

  it("updatePosting PATCHes :id with a faceless body (no org_label/payer_id), maps the row", async () => {
    fetchMock.mockResolvedValue(jsonResponse(jobPostingRow({ roleTitle: "CNC Machinist II" })));
    const { updatePosting } = await import("./payer-api");
    const res = await updatePosting(POSTING_ID, {
      tradeKey: "cnc_operator",
      roleTitle: "CNC Machinist II",
      vacancies: 3,
    });
    expect(res?.roleTitle).toBe("CNC Machinist II");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://api.test/payer/job-postings/${POSTING_ID}`);
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // The PATCH never re-stamps org_label (session identity) and never a client tenancy id.
    expect(body).not.toHaveProperty("org_label");
    expect(body).not.toHaveProperty("payer_id");
    expect(body).not.toHaveProperty("created_by");
    expect(body.vacancies).toBe(3); // RAW count — backend derives its own band
    expect(body).not.toHaveProperty("vacancy_band");
  });

  it("updatePosting maps a 404 to a neutral null", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "not found" }, 404));
    const { updatePosting } = await import("./payer-api");
    const res = await updatePosting(POSTING_ID, { tradeKey: "fitter", roleTitle: "Fitter", vacancies: 1 });
    expect(res).toBeNull();
  });
});

describe("getApplicantFeed — surfaces faceless taxonomy bands (PR-4), null -> undefined", () => {
  const JOB = "44444444-4444-4444-8444-444444444444";
  const WORKER = "55555555-5555-4555-8555-555555555555";

  it("maps experience/trade/city bands from the reach wire onto the faceless applicant", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        jobId: JOB,
        applicants: [
          {
            workerId: WORKER,
            rank: 1,
            score: 0.9,
            hot: true,
            pushEligible: false,
            components: [{ signal: "role", reason: "on-trade" }],
            experienceBand: "6-10 yrs",
            tradeLabel: "VMC Operator",
            cityLabel: "pune",
          },
        ],
      }),
    );
    const { getApplicantFeed } = await import("./payer-api");
    const feed = await getApplicantFeed(JOB);
    const a = feed!.applicants[0]!;
    expect(a.experienceBand).toBe("6-10 yrs");
    expect(a.tradeLabel).toBe("VMC Operator");
    expect(a.cityLabel).toBe("pune");
    expect(a.signals).toContain("on-trade");
    // Faceless: the row carries no name/phone/employer field of any kind.
    expect(JSON.stringify(a)).not.toMatch(/name|phone|employer|email|address/i);
  });

  it("maps a null band (no worker signal) to undefined, never the string 'null'", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        jobId: JOB,
        applicants: [
          {
            workerId: WORKER,
            rank: 1,
            score: 0.5,
            hot: false,
            pushEligible: false,
            components: [],
            experienceBand: null,
            tradeLabel: null,
            cityLabel: null,
          },
        ],
      }),
    );
    const { getApplicantFeed } = await import("./payer-api");
    const a = (await getApplicantFeed(JOB))!.applicants[0]!;
    expect(a.experienceBand).toBeUndefined();
    expect(a.tradeLabel).toBeUndefined();
    expect(a.cityLabel).toBeUndefined();
  });

  it("parses fine when an older backend omits the band fields entirely (optional)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        jobId: JOB,
        applicants: [
          {
            workerId: WORKER,
            rank: 1,
            score: 0.5,
            hot: false,
            pushEligible: false,
            components: [],
          },
        ],
      }),
    );
    const { getApplicantFeed } = await import("./payer-api");
    const a = (await getApplicantFeed(JOB))!.applicants[0]!;
    expect(a.workerId).toBe(WORKER);
    expect(a.tradeLabel).toBeUndefined();
  });
});

/**
 * SOURCE-LEVEL GUARDRAILS — the live-swap is enforced statically, so a regression that
 * re-points a swapped function at the mock store (or drops the gated-trio flag) fails CI
 * rather than slipping through. Reads the seam source as text (no execution).
 */
describe("live-swap guardrails (source) — swapped funcs are live, gated trio flagged", () => {
  const src = readFileSync(fileURLToPath(new URL("./payer-api.ts", import.meta.url)), "utf8");

  it("the swapped company-posting reads/writes no longer route through the mock store", () => {
    // After the swap there is NO store.getPostings / store.createPosting anywhere in the seam —
    // create/list (and the dashboard/capacity reads) are payer-authed fetches now.
    expect(src).not.toMatch(/store\.getPostings/);
    expect(src).not.toMatch(/store\.createPosting/);
  });

  it("the live posting CRUD goes to the payer-authed /payer/job-postings routes", () => {
    // The swapped functions hit the live route family (a regression to a mock shim drops these).
    expect(src).toMatch(/payerFetch\("\/payer\/job-postings"/); // create (POST) + list (GET)
    expect(src).toMatch(/payerFetch\(`\/payer\/job-postings\/\$\{postingId\}`/); // get-one + edit
    expect(src).toMatch(/payerFetch\(`\/payer\/job-postings\/\$\{postingId\}\/close`/); // close
  });

  it("the gated lifecycle trio is EXPLICITLY flagged (LIVE-SWAP BLOCKED), not silently broken", () => {
    // One marker per pausePosting / resumePosting / topUpPostingQuota — the trio is knowingly
    // deferred (no payer-authed route), never quietly left half-working.
    const markers = src.match(/LIVE-SWAP BLOCKED/g) ?? [];
    expect(markers).toHaveLength(3);
  });

  it("the gated trio STILL routes to the mock store (it is intact, not removed)", () => {
    expect(src).toMatch(/store\.pausePosting/);
    expect(src).toMatch(/store\.resumePosting/);
    expect(src).toMatch(/store\.topUpPostingQuota/);
  });
});
