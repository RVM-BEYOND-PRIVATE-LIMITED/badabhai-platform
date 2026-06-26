import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  MOCK_COOKIE_NAME: "bb_payer_session",
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
  process.env.PAYER_AUTH_MODE = "api";
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

  it("GETs /payer/capacity (Bearer, no body) and maps max_active_vacancies to the allowance", async () => {
    const store = await import("./mock-store");
    store.__resetForTest(PAYER_A, true); // seed the WAITING-mock per-posting rows
    fetchMock.mockResolvedValue(
      jsonResponse({
        payer_id: PAYER_A,
        max_active_vacancies: 9,
        // The REAL active-plan count from the enforcement engine (A3). Pinned to a value
        // (4) that is NOT a count of the seeded mock-store rows, so the assertion below
        // proves `activeVacancies` is the LIVE count, never a mock-store filter.
        active_plan_count: 4,
        source_tier: null,
        expires_at: null,
      }),
    );
    const { getCapacity } = await import("./payer-api");
    const cap = await getCapacity();

    expect(cap.payerId).toBe(PAYER_A);
    // The allowance comes from the LIVE endpoint, not the config baseline.
    expect(cap.activeVacancyAllowance).toBe(9);
    // activeVacancies is the REAL enforcement-engine active_plan_count (4) — NOT a count
    // derived from the seeded mock-store posting rows (which would be a different number).
    expect(cap.activeVacancies).toBe(4);
    // Per-posting rows are still the (WAITING-mock) seeded plans — DISPLAY-only, and they
    // do NOT drive `activeVacancies` (proven above: 4 ≠ the seeded active-row count).
    expect(cap.postings.length).toBeGreaterThan(0);
    expect(cap.postings.length).not.toBe(cap.activeVacancies);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/payer/capacity");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    // A GET carries no body, hence no place for a client payer_id.
    expect(init.body).toBeUndefined();
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
 * WAITING-mock seam: job management + capacity. These bind to the SERVER-HELD session
 * payer (the mocked `requirePayer` above → PAYER_A) and never accept a client payer id.
 * They serve from the in-memory mock store, so they do NOT hit fetch.
 */
describe("job-management seam — server-held payer, config-driven (WAITING mock)", () => {
  const PAYER_A = "11111111-1111-4111-8111-111111111111";

  it("pause/resume/top-up operate only on the session payer's own postings", async () => {
    const store = await import("./mock-store");
    store.__resetForTest(PAYER_A, true);
    const { pausePosting, resumePosting, topUpPostingQuota, getPostings } =
      await import("./payer-api");

    const postings = await getPostings();
    const id = postings[0]!.id;

    const paused = await pausePosting({ postingId: id });
    expect(paused?.status).toBe("paused");
    const resumed = await resumePosting({ postingId: id });
    expect(resumed?.status).toBe("open");

    const beforeQuota = postings[0]!.applicantQuota ?? 0;
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
