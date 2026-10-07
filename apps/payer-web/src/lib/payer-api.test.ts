import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_CATALOG } from "@badabhai/pricing";

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
 * A healthy `GET /payer/pricing/catalog` wire body (D-6 — the seam now resolves pack
 * prices / the quota-topup tier from the LIVE catalog). `products` overrides let a test
 * serve an ops-EDITED catalog to prove liveness.
 */
function catalogResponse(products: unknown = DEFAULT_CATALOG.products): Response {
  return jsonResponse({ revision: 1, source: "db", products });
}

/**
 * A LIVE job-posting wire row (the `JobPosting` Drizzle row the payer-authed controller
 * returns). Carries the payer's OWN org_label + free-text description on purpose — the seam
 * mapper must DROP them so they never reach the faceless PostingSummary the UI consumes.
 */
const POSTING_ID = "bbbb2222-0000-4000-8000-000000000001";
/** The top-up tier a payer confirmed off the default catalog (#2085 L1): code + slots. */
const TOPUP_10 = { code: "topup_10", additionalViews: 10 };

function jobPostingRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: POSTING_ID,
    payer_id: "11111111-1111-4111-8111-111111111111",
    created_by: "11111111-1111-4111-8111-111111111111",
    org_label: "Acme Manufacturing",
    role_title: "CNC Machinist",
    location_label: "Pune, MH",
    description: "Two-shift CNC role, PPE provided.",
    vacancy_band: "6-10",
    status: "draft",
    skill_phrases: [],
    skill_ids: [],
    created_at: "2026-06-20T00:00:00.000Z",
    updated_at: "2026-06-20T00:00:00.000Z",
    closed_at: null,
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

describe("getUnlocks — the payer's own history, with its grant day passed through", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    unlock_id: "22222222-2222-4222-8222-222222222222",
    payer_id: "11111111-1111-4111-8111-111111111111",
    worker_id: "44444444-4444-4444-8444-444444444444",
    job_id: null,
    status: "granted",
    reveal_count: 0,
    granted_at: "2026-10-01T09:00:00.000Z",
    expires_at: "2026-10-15T09:00:00.000Z",
    created_at: "2026-08-01T09:00:00.000Z",
    ...over,
  });

  it("maps granted_at → grantedAt (null kept null); carries NO agency job id and no payer id", async () => {
    // A pre-#2033 API: no `job_posting_id` key at all (migration 0132 is apply-before-deploy).
    fetchMock.mockResolvedValue(
      jsonResponse({
        unlocks: [
          row(),
          row({
            unlock_id: "33333333-3333-4333-8333-333333333333",
            job_id: "55555555-5555-4555-8555-555555555555",
            status: "revealed",
            granted_at: null,
          }),
        ],
      }),
    );
    const { getUnlocks } = await import("./payer-api");
    const out = await getUnlocks();
    expect(out).toEqual([
      {
        unlockId: "22222222-2222-4222-8222-222222222222",
        workerId: "44444444-4444-4444-8444-444444444444",
        status: "granted",
        createdAt: "2026-08-01T09:00:00.000Z",
        expiresAt: "2026-10-15T09:00:00.000Z",
        grantedAt: "2026-10-01T09:00:00.000Z",
        jobPostingId: null,
      },
      {
        unlockId: "33333333-3333-4333-8333-333333333333",
        workerId: "44444444-4444-4444-8444-444444444444",
        status: "granted",
        createdAt: "2026-08-01T09:00:00.000Z",
        expiresAt: "2026-10-15T09:00:00.000Z",
        grantedAt: null,
        jobPostingId: null,
      },
    ]);
    expect(JSON.stringify(out)).not.toContain("11111111-1111-4111-8111-111111111111");
    // An agency unlock's `jobs` id is on the wire, but no screen that renders the history reads the
    // agency's jobs: it is not carried, so nothing can claim a job it cannot name.
    expect(JSON.stringify(out)).not.toContain("55555555-5555-4555-8555-555555555555");
    for (const u of out) expect(u).not.toHaveProperty("jobId");
  });

  it("#2033: job_posting_id → jobPostingId; a null and an ABSENT key both read as no context", async () => {
    const POSTED = "66666666-6666-4666-8666-666666666666";
    fetchMock.mockResolvedValue(
      jsonResponse({
        unlocks: [
          // A company unlock made from an owned posting (post-0132): job_id null, the posting set.
          row({ job_posting_id: POSTED }),
          // A search unlock on a post-0132 API: both contexts null.
          row({ unlock_id: "33333333-3333-4333-8333-333333333333", job_posting_id: null }),
          // A pre-#2033 API row: no key at all (`row()` carries none).
          row({ unlock_id: "77777777-7777-4777-8777-777777777777" }),
        ],
      }),
    );
    const { getUnlocks } = await import("./payer-api");
    const out = await getUnlocks();
    expect(out.map((u) => [u.unlockId, u.jobPostingId])).toEqual([
      ["22222222-2222-4222-8222-222222222222", POSTED],
      ["33333333-3333-4333-8333-333333333333", null],
      ["77777777-7777-4777-8777-777777777777", null],
    ]);
  });

  it("#2033: the server-derived `expired` (and `revoked`) are ended access — never live, even inside the window", async () => {
    // The server's clock read the window as lapsed; this one still sees it open (skew). The
    // server's word wins: no applicant row may start unlocked on an `expired` record.
    const { liveUnlocksFor } = await import("./unlock-history");
    const OPEN_UNTIL = "2026-10-15T09:00:00.000Z";
    const W_EXPIRED = "44444444-4444-4444-8444-444444444444";
    const W_REVOKED = "88888888-8888-4888-8888-888888888888";
    fetchMock.mockResolvedValue(
      jsonResponse({
        unlocks: [
          row({ status: "expired", expires_at: OPEN_UNTIL, job_posting_id: null }),
          row({
            unlock_id: "33333333-3333-4333-8333-333333333333",
            worker_id: W_REVOKED,
            status: "revoked",
            expires_at: OPEN_UNTIL,
            job_posting_id: null,
          }),
        ],
      }),
    );
    const { getUnlocks } = await import("./payer-api");
    const out = await getUnlocks();
    expect(out.map((u) => u.status)).toEqual(["expired", "expired"]);
    const inWindow = Date.parse("2026-10-06T12:00:00.000Z");
    expect(liveUnlocksFor(out, [W_EXPIRED, W_REVOKED], inWindow)).toEqual({});
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

  it("maps an unknown-pack 404 to a neutral null (no client-side ledger side effects)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "Unknown credit pack" }, 404));
    const { topUp } = await import("./payer-api");
    const res = await topUp({ packCode: "does_not_exist" });
    expect(res).toBeNull();
    // ONE call only — no follow-up write anywhere (the ledger is server-side now).
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("getCreditTopUps — LIVE credit history: GET /payer/credits/ledger (XB-A, Bearer only)", () => {
  const PAYER = "11111111-1111-4111-8111-111111111111";

  it("GETs the ledger with the Bearer token and maps ONLY positive pack movements to top-ups", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        payer_id: PAYER,
        ledger: [
          {
            id: "cccc3333-0000-4000-8000-000000000001",
            delta: 50,
            reason: "pack_purchase",
            unlock_id: null,
            pack_code: "pack_50",
            payment_ref: "mock_ref_1",
            price_inr: 2000, // the amount STAMPED at purchase (D-6)
            created_at: "2026-07-01T00:00:00.000Z",
          },
          {
            // A SPEND row (negative, no pack) — must NOT appear as a top-up.
            id: "cccc3333-0000-4000-8000-000000000002",
            delta: -1,
            reason: "unlock",
            unlock_id: "dddd4444-0000-4000-8000-000000000001",
            pack_code: null,
            payment_ref: null,
            price_inr: null,
            created_at: "2026-07-02T00:00:00.000Z",
          },
        ],
      }),
    );
    const { getCreditTopUps } = await import("./payer-api");
    const topUps = await getCreditTopUps();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/payer/credits/ledger?limit=50");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.body).toBeUndefined(); // a GET carries no body → no place for a payer_id

    expect(topUps).toHaveLength(1);
    expect(topUps[0]!.topUpId).toBe("cccc3333-0000-4000-8000-000000000001");
    expect(topUps[0]!.packCode).toBe("pack_50");
    expect(topUps[0]!.credits).toBe(50);
    // The STAMPED charge from the ledger row — what the payer actually paid (D-6 MEDIUM-2).
    expect(topUps[0]!.priceInr).toBe(2000);
    expect(topUps[0]!.createdAt).toBe("2026-07-01T00:00:00.000Z");
  });

  /**
   * D-6 MEDIUM-2: HISTORY IS A RECORD, NOT A QUOTE. The rendered amount is the ₹ stamped on
   * the ledger row at purchase; it must NOT be re-resolved from the CURRENT catalog, or an
   * ops price edit would retroactively rewrite what past purchases appear to have cost.
   */
  it("renders the STAMPED price even when the current catalog now says something different", async () => {
    // Ops has since re-priced pack_50 to ₹2,500. The row was CHARGED ₹2,000 and must stay so.
    const editedProducts = DEFAULT_CATALOG.products.map((p) =>
      p.kind === "credit_pack" && p.code === "contact_unlock"
        ? {
            ...p,
            tiers: p.tiers.map((t) => (t.code === "pack_50" ? { ...t, priceInr: 2500 } : t)),
          }
        : p,
    );
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/payer/pricing/catalog")) {
        return Promise.resolve(catalogResponse(editedProducts));
      }
      return Promise.resolve(
        jsonResponse({
          payer_id: PAYER,
          ledger: [
            {
              id: "cccc3333-0000-4000-8000-000000000001",
              delta: 50,
              reason: "pack_purchase",
              unlock_id: null,
              pack_code: "pack_50",
              payment_ref: "mock_ref_1",
              price_inr: 2000, // what was ACTUALLY charged
              created_at: "2026-07-01T00:00:00.000Z",
            },
          ],
        }),
      );
    });
    const { getCreditTopUps } = await import("./payer-api");
    const topUps = await getCreditTopUps();
    // The STAMPED ₹2,000 — NOT the current catalog's ₹2,500 (the retroactive re-pricing bug).
    expect(topUps[0]!.priceInr).toBe(2000);
    // And the history read no longer consults the catalog at all.
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.endsWith("/payer/pricing/catalog"))).toBe(false);
  });

  it("a LEGACY row with no stamped price omits the amount (honest dash, never a fabricated one)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        payer_id: PAYER,
        ledger: [
          {
            id: "cccc3333-0000-4000-8000-000000000003",
            delta: 50,
            reason: "pack_purchase",
            unlock_id: null,
            pack_code: "pack_50",
            payment_ref: null,
            price_inr: null, // written before the stamp existed
            created_at: "2026-05-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const { getCreditTopUps } = await import("./payer-api");
    const topUps = await getCreditTopUps();
    expect(topUps).toHaveLength(1);
    // Undefined ⇒ the page renders "—". It is NOT back-filled from the catalog's ₹2,000.
    expect(topUps[0]!.priceInr).toBeUndefined();
    expect(topUps[0]!.credits).toBe(50); // the movement itself still renders
  });

  it("tolerates an API that predates the column entirely (key absent → no amount, no throw)", async () => {
    // Backward compat (invariant #8): an older API omits `price_inr` — the read must not fail.
    fetchMock.mockResolvedValue(
      jsonResponse({
        payer_id: PAYER,
        ledger: [
          {
            id: "cccc3333-0000-4000-8000-000000000004",
            delta: 50,
            reason: "pack_purchase",
            unlock_id: null,
            pack_code: "pack_50",
            payment_ref: null,
            created_at: "2026-05-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const { getCreditTopUps } = await import("./payer-api");
    const topUps = await getCreditTopUps();
    expect(topUps).toHaveLength(1);
    expect(topUps[0]!.priceInr).toBeUndefined();
  });

  it("surfaces no PII from the ledger payload", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ payer_id: PAYER, ledger: [] }));
    const { getCreditTopUps } = await import("./payer-api");
    const res = await getCreditTopUps();
    expect(JSON.stringify(res)).not.toMatch(/name|phone|employer|email|address/i);
  });
});

describe("getCapacity — capacity wiring (LIVE): GETs /payer/capacity with Bearer, no payer_id", () => {
  const PAYER_A = "11111111-1111-4111-8111-111111111111";

  it("GETs /payer/capacity (Bearer, no body) and maps max_active_vacancies to the allowance", async () => {
    // getCapacity now fetches BOTH /payer/capacity AND /payer/job-postings (the per-posting
    // DISPLAY rows are the LIVE postings). Branch the mock per URL.
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
      // The per-posting DISPLAY rows are now the LIVE postings (2 rows ≠ the active_plan_count 4).
      return Promise.resolve(
        jsonResponse([
          jobPostingRow(),
          jobPostingRow({ id: "bbbb2222-0000-4000-8000-000000000002", status: "open" }),
        ]),
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

    const capCall = fetchMock.mock.calls.find((c) => (c[0] as string).endsWith("/payer/capacity")) as
      | [string, RequestInit]
      | undefined;
    expect(capCall).toBeDefined();
    expect(capCall![0]).toBe("http://api.test/payer/capacity");
    expect((capCall![1].headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    // A GET carries no body, hence no place for a client payer_id.
    expect(capCall![1].body).toBeUndefined();
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
 * IDEMPOTENCY WIRING (#1165 — credits #1046 / capacity #1148). The seam THREADS a per-purchase
 * key from the client through to the backend request header, and translates the 409 a duplicate
 * in-flight purchase gets into the typed {@link PurchaseConflictError} so the action re-reads the
 * real figure instead of re-posting or rendering a guessed number.
 *
 *  - a key present ⇒ the outbound POST carries an `Idempotency-Key` header equal to it verbatim
 *    (NOT regenerated in the seam — the CLIENT-minted key survives the round trip);
 *  - no key ⇒ NO header (backward compatible: the header is optional by design);
 *  - a 409 ⇒ PurchaseConflictError (distinct from the 404 → null and the neutral-failure paths).
 */
describe("topUp / buyCapacity — Idempotency-Key wiring + 409 → PurchaseConflictError (#1165)", () => {
  const PAYER_A = "11111111-1111-4111-8111-111111111111";
  const KEY = "5f9d1c2e-1a2b-4c3d-8e4f-0a1b2c3d4e5f"; // a client-minted crypto.randomUUID()

  it("topUp sends the Idempotency-Key header verbatim when a key is passed", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ payer_id: PAYER_A, balance: 57, credits: 50, pack_code: "pack_50" }, 201),
    );
    const { topUp } = await import("./payer-api");
    await topUp({ packCode: "pack_50", idempotencyKey: KEY });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/payer/credits");
    expect(init.method).toBe("POST");
    // The exact client key reaches the backend header — the seam does NOT mint its own.
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe(KEY);
    // Still XB-A: the key is a header, never a body field, and carries no payer_id.
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["pack_code"]);
    expect(JSON.stringify(body)).not.toMatch(/idempotency|payer_id/i);
  });

  it("topUp sends NO Idempotency-Key header when none is passed (backward compatible)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ payer_id: PAYER_A, balance: 57, credits: 50, pack_code: "pack_50" }, 201),
    );
    const { topUp } = await import("./payer-api");
    await topUp({ packCode: "pack_50" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers as Record<string, string>).not.toHaveProperty("Idempotency-Key");
  });

  it("topUp maps a 409 (duplicate in flight) to PurchaseConflictError — not null, not a generic throw", async () => {
    // 409 body carries NO renderable balance by design (asserted server-side).
    fetchMock.mockResolvedValue(jsonResponse({ message: "purchase already in progress" }, 409));
    const { topUp, PurchaseConflictError } = await import("./payer-api");
    await expect(topUp({ packCode: "pack_50", idempotencyKey: KEY })).rejects.toBeInstanceOf(
      PurchaseConflictError,
    );
    // The 409 is NOT confused with the unknown-pack 404 → null path.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("buyCapacity sends the Idempotency-Key header verbatim when a key is passed", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        payer_id: PAYER_A,
        quote: {},
        max_active_vacancies: 10,
        source_tier: "growth",
        expires_at: null,
        resumed_plan_ids: [],
      }),
    );
    const { buyCapacity } = await import("./payer-api");
    await buyCapacity({ tier: "growth", idempotencyKey: KEY });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/payer/capacity");
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe(KEY);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // Still tier CODE only (XB-A/XT5) — the key never leaks into the body.
    expect(Object.keys(body)).toEqual(["tier"]);
    expect(JSON.stringify(body)).not.toMatch(/idempotency|payer_id/i);
  });

  it("buyCapacity sends NO Idempotency-Key header when none is passed (backward compatible)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        payer_id: PAYER_A,
        quote: {},
        max_active_vacancies: 10,
        source_tier: "growth",
        expires_at: null,
        resumed_plan_ids: [],
      }),
    );
    const { buyCapacity } = await import("./payer-api");
    await buyCapacity({ tier: "growth" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers as Record<string, string>).not.toHaveProperty("Idempotency-Key");
  });

  it("buyCapacity maps a 409 to PurchaseConflictError, NOT the neutral { ok:false } (that would invite a re-tap)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "purchase already in progress" }, 409));
    const { buyCapacity, PurchaseConflictError } = await import("./payer-api");
    // A 409 must THROW the typed conflict — collapsing it to { ok:false } would let the panel
    // message a duplicate-charge-prevention as a retryable failure (a re-tap = a second attempt).
    await expect(buyCapacity({ tier: "growth", idempotencyKey: KEY })).rejects.toBeInstanceOf(
      PurchaseConflictError,
    );
  });

  it("buyCapacity STILL returns the neutral { ok:false } for a non-409 transport error (no leak)", async () => {
    fetchMock.mockRejectedValue(new Error("http://api.test/payer/capacity returned 500"));
    const { buyCapacity } = await import("./payer-api");
    const res = await buyCapacity({ tier: "growth", idempotencyKey: KEY });
    expect(res.ok).toBe(false);
  });
});

/**
 * A 403 ON A PURCHASE (#2079). The API can refuse the three credit-purchase routes for an account
 * (#2098's owner-only guard, being lifted per the 2026-10-07 ruling, still 403s a Recruiter until
 * that deploys). The seam types it as PurchaseForbiddenError — distinct from a transport failure
 * (which invites a retry) and from the 404 → null path — and carries none of the body's deny reason.
 */
describe("credit purchase routes — a 403 (#2079) → PurchaseForbiddenError", () => {
  const DENY_REASON = "Org role is not permitted for this resource";
  const forbidden = () => jsonResponse({ message: DENY_REASON }, 403);

  it("topUp (POST /payer/credits)", async () => {
    fetchMock.mockResolvedValue(forbidden());
    const { topUp, PurchaseForbiddenError } = await import("./payer-api");
    const err = await topUp({ packCode: "pack_50" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PurchaseForbiddenError);
    expect((err as Error).message).not.toContain(DENY_REASON);
    expect(fetchMock).toHaveBeenCalledTimes(1); // never retried
  });

  it("createCreditOrder (POST /payer/credits/order)", async () => {
    fetchMock.mockResolvedValue(forbidden());
    const { createCreditOrder, PurchaseForbiddenError } = await import("./payer-api");
    await expect(createCreditOrder({ packCode: "pack_50" })).rejects.toBeInstanceOf(
      PurchaseForbiddenError,
    );
  });

  it("verifyCreditPayment (POST /payer/credits/verify)", async () => {
    fetchMock.mockResolvedValue(forbidden());
    const { verifyCreditPayment, PurchaseForbiddenError } = await import("./payer-api");
    await expect(
      verifyCreditPayment({ orderId: "order_1", paymentId: "pay_1", signature: "sig_1" }),
    ).rejects.toBeInstanceOf(PurchaseForbiddenError);
  });
});

/**
 * LIVE posting lifecycle: PAUSE / RESUME / quota-top-up on the payer-authed
 * `POST /payer/job-postings/:id/{pause|resume|quota-topup}` routes (#178/#180).
 * TENANCY (XB-A): Bearer-only — the bodies never carry a payer_id; the quota body
 * carries ONLY the config'd catalog tier CODE (XT5 — never a price/amount).
 * No-oracle: an unknown-or-not-owned id (neutral 404) maps to `null`.
 */
describe("posting lifecycle — LIVE pause/resume/quota-topup (XB-A, Bearer only)", () => {
  it("POSTs pause then resume with the Bearer token, empty body, and maps the fresh row", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(jobPostingRow({ status: "paused" })))
      .mockResolvedValueOnce(jsonResponse(jobPostingRow({ status: "open" })));
    const { pausePosting, resumePosting } = await import("./payer-api");

    const paused = await pausePosting({ postingId: POSTING_ID });
    expect(paused?.status).toBe("paused");
    const resumed = await resumePosting({ postingId: POSTING_ID });
    expect(resumed?.status).toBe("open");

    const [pauseUrl, pauseInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(pauseUrl).toBe(`http://api.test/payer/job-postings/${POSTING_ID}/pause`);
    expect(pauseInit.method).toBe("POST");
    expect((pauseInit.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(pauseInit.body as string)).toEqual({}); // empty body — no payer_id
    const [resumeUrl] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(resumeUrl).toBe(`http://api.test/payer/job-postings/${POSTING_ID}/resume`);
    // The faceless mapping still drops org_label/description.
    expect(JSON.stringify(paused)).not.toMatch(/orgLabel|description/);
  });

  it("quota-topup POSTs the CONFIRMED tier code (checked against the LIVE catalog), then re-reads the row", async () => {
    // D-6 + #2085 L1: the seam reads the LIVE catalog FIRST — to CHECK the tier the payer
    // confirmed, never to pick one — so branch the mock per URL.
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/payer/pricing/catalog")) return Promise.resolve(catalogResponse());
      if (url.endsWith("/quota-topup")) {
        return Promise.resolve(jsonResponse({ plan: { id: "p1" }, quote: { total: 1000 } }, 201));
      }
      return Promise.resolve(jsonResponse(jobPostingRow({ status: "open" })));
    });
    const { topUpPostingQuota } = await import("./payer-api");
    const outcome = await topUpPostingQuota({ postingId: POSTING_ID, tier: TOPUP_10 });
    expect(outcome?.posting?.id).toBe(POSTING_ID);
    // The added views come from the CATALOG tier (config), never the wire (XT5).
    expect(outcome?.addedViews).toBe(10);

    const topupCall = fetchMock.mock.calls.find((c) => (c[0] as string).endsWith("/quota-topup"));
    expect(topupCall).toBeDefined();
    const [url, init] = topupCall as [string, RequestInit];
    expect(url).toBe(`http://api.test/payer/job-postings/${POSTING_ID}/quota-topup`);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // ONLY the catalog tier CODE (from the live pricing config) — no payer_id/price/amount.
    expect(Object.keys(body)).toEqual(["tier"]);
    expect(body.tier).toBe("topup_10");
  });

  it("D-6: a tier confirmed off the ops-EDITED live catalog is bought as confirmed (no compile-time tier left)", async () => {
    const editedProducts = DEFAULT_CATALOG.products.map((p) =>
      p.kind === "quota_topup"
        ? {
            ...p,
            tiers: [{ code: "topup_25_live", priceInr: 799, additionalVisibilityQuota: 25 }],
          }
        : p,
    );
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/payer/pricing/catalog")) {
        return Promise.resolve(catalogResponse(editedProducts));
      }
      if (url.endsWith("/quota-topup")) {
        return Promise.resolve(jsonResponse({ plan: { id: "p1" }, quote: { total: 799 } }, 201));
      }
      return Promise.resolve(jsonResponse(jobPostingRow({ status: "open" })));
    });
    const { topUpPostingQuota } = await import("./payer-api");
    // The page read this tier off the same live catalog; a DEFAULT_CATALOG check would refuse it.
    const outcome = await topUpPostingQuota({
      postingId: POSTING_ID,
      tier: { code: "topup_25_live", additionalViews: 25 },
    });
    // The LIVE tier's views — a DEFAULT_CATALOG read would still say 10.
    expect(outcome?.addedViews).toBe(25);
    const topupCall = fetchMock.mock.calls.find((c) => (c[0] as string).endsWith("/quota-topup"));
    const body = JSON.parse((topupCall as [string, RequestInit])[1].body as string) as Record<
      string,
      unknown
    >;
    expect(body.tier).toBe("topup_25_live");
  });

  it("a post-charge re-read failure degrades to posting:null — NEVER a thrown 'retry' (double-purchase guard)", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/payer/pricing/catalog")) return Promise.resolve(catalogResponse());
      if (url.endsWith("/quota-topup")) {
        return Promise.resolve(jsonResponse({ plan: { id: "p1" }, quote: { total: 1000 } }, 201));
      }
      // The fresh-row re-read fails AFTER the charge committed.
      return Promise.resolve(jsonResponse({ message: "boom" }, 503));
    });
    const { topUpPostingQuota } = await import("./payer-api");
    const outcome = await topUpPostingQuota({ postingId: POSTING_ID, tier: TOPUP_10 });
    // The charge committed on the quota-topup call; the failed re-read must not look like a failure.
    expect(outcome).toEqual({ posting: null, addedViews: 10 });
    // Exactly ONE quota-topup POST — the degrade path never re-buys.
    const topupCalls = fetchMock.mock.calls.filter((c) =>
      (c[0] as string).endsWith("/quota-topup"),
    );
    expect(topupCalls).toHaveLength(1);
  });

  it("maps a 409 (no active plan) to QuotaTopUpNoPlanError — actionable, not neutral", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "no active plan" }, 409));
    const { topUpPostingQuota, QuotaTopUpNoPlanError } = await import("./payer-api");
    await expect(topUpPostingQuota({ postingId: POSTING_ID, tier: TOPUP_10 })).rejects.toBeInstanceOf(
      QuotaTopUpNoPlanError,
    );
  });

  it("returns null (neutral not-found) for an unknown-or-not-owned posting id", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "Not found" }, 404));
    const { pausePosting } = await import("./payer-api");
    const res = await pausePosting({ postingId: "99999999-9999-4999-8999-999999999999" });
    expect(res).toBeNull();
  });
});

/**
 * LIVE masked-resume disclosure: POST /payer/resume-disclosures (XB-E / B-C).
 * TENANCY (XB-A): the body carries ONLY worker_id + job_posting_id — never a payer_id.
 * No-oracle: the neutral `unavailable` body maps to the SAME neutral result.
 */
describe("revealMaskedResume — LIVE disclosure (XB-A body, no-oracle neutral)", () => {
  const WORKER = "eeee5555-0000-4000-8000-000000000001";
  const UNLOCK = "ffff6666-0000-4000-8000-000000000001";

  it("POSTs ONLY worker_id + job_posting_id and maps the granted wire (no initials field)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        ok: true,
        disclosure_id: "aaaa7777-0000-4000-8000-000000000001",
        status: "disclosed",
        resume_url: "https://api.test/signed/masked.pdf",
        expires_at: "2026-07-20T00:00:00.000Z",
      }),
    );
    const { revealMaskedResume } = await import("./payer-api");
    const res = await revealMaskedResume({
      unlockId: UNLOCK,
      workerId: WORKER,
      postingId: POSTING_ID,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/payer/resume-disclosures");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["job_posting_id", "worker_id"]);
    expect(body.worker_id).toBe(WORKER);
    expect(body.job_posting_id).toBe(POSTING_ID);
    expect(JSON.stringify(body)).not.toMatch(/payer_id|unlock/);

    expect(res).toEqual({
      ok: true,
      disclosureId: "aaaa7777-0000-4000-8000-000000000001",
      status: "disclosed",
      resumeUrl: "https://api.test/signed/masked.pdf",
      expiresAt: "2026-07-20T00:00:00.000Z",
    });
    // NO name/phone/initials on the live wire result (masking lives inside the PDF).
    expect(JSON.stringify(res)).not.toMatch(/name|phone|initials/i);
  });

  it("maps the neutral unavailable body to the SAME neutral result (B-C no-oracle)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "unavailable" }));
    const { revealMaskedResume } = await import("./payer-api");
    const res = await revealMaskedResume({ unlockId: UNLOCK, workerId: WORKER });
    expect(res).toEqual({ status: "unavailable" });
    // Omitted postingId → an explicit null job_posting_id (the DTO default), never absent.
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).job_posting_id).toBeNull();
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
      roleKind: "cnc_turner" as const,
      roleTitle: "CNC Machinist",
      locationLabel: "Pune, MH",
      description: "Two-shift CNC role, PPE provided.",
      vacancies: 7,
      city: "Pune",
      payMin: 20000,
      payMax: 35000,
      payType: "in_hand" as const,
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
    // PR-B: the company form dropped `trade_key`; the CREATE body now carries the card fields
    // (role_kind + pay + city …) the backend `PayerCreateJobPostingSchema` accepts.
    expect(body).not.toHaveProperty("trade_key");
    expect(body.role_kind).toBe("cnc_turner");
    expect(body.pay_min).toBe(20000);
    expect(body.city).toBe("Pune");

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
          role_title: "VMC Operator",
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

describe("getDashboard — the company postings list is read only when the caller asks for it", () => {
  /** Answer each dashboard read by URL (credits, unlocks, job-postings). */
  function answerDashboardReads() {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/payer/credits")) {
        return jsonResponse({ payer_id: "11111111-1111-4111-8111-111111111111", balance: 7 });
      }
      if (url.endsWith("/payer/unlocks")) return jsonResponse({ unlocks: [] });
      if (url.endsWith("/payer/job-postings")) return jsonResponse([jobPostingRow()]);
      throw new Error(`unexpected read ${url}`);
    });
  }
  const requested = () => fetchMock.mock.calls.map(([url]) => String(url));

  it("withPostings: false (an AGENCY session) never requests GET /payer/job-postings", async () => {
    answerDashboardReads();
    const { getDashboard } = await import("./payer-api");
    const d = await getDashboard({ withPostings: false });
    expect(requested().some((u) => u.endsWith("/payer/job-postings"))).toBe(false);
    expect(d.postings).toEqual([]);
    expect(d.credits.balance).toBe(7);
  });

  it("withPostings: true (a COMPANY session) reads the list alongside credits + unlocks", async () => {
    answerDashboardReads();
    const { getDashboard } = await import("./payer-api");
    const d = await getDashboard({ withPostings: true });
    expect(requested().filter((u) => u.endsWith("/payer/job-postings"))).toHaveLength(1);
    expect(d.postings.map((p) => p.roleTitle)).toEqual(["CNC Machinist"]);
  });
});

describe("getPostingDetail — carries the saved revision for the edit form's key", () => {
  it("maps the wire `updated_at` to `updatedAt`", async () => {
    fetchMock.mockResolvedValue(jsonResponse(jobPostingRow({ updated_at: "2026-09-29T10:05:00.000Z" })));
    const { getPostingDetail } = await import("./payer-api");
    const detail = await getPostingDetail(POSTING_ID);
    expect(detail?.updatedAt).toBe("2026-09-29T10:05:00.000Z");
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
      jsonResponse(jobPostingRow({ status: "closed", closed_at: "2026-06-26T00:00:00.000Z" })),
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
    fetchMock.mockResolvedValue(jsonResponse(jobPostingRow({ role_title: "CNC Machinist II" })));
    const { updatePosting } = await import("./payer-api");
    // updatePosting takes the PATCHable subset only (UpdatePostingInput — no tradeKey).
    const res = await updatePosting(POSTING_ID, {
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

  it("updatePosting rides the wider worker-visible fields (city/pay/shift/needed_by) on the PATCH", async () => {
    fetchMock.mockResolvedValue(jsonResponse(jobPostingRow()));
    const { updatePosting } = await import("./payer-api");
    await updatePosting(POSTING_ID, {
      roleTitle: "CNC Machinist",
      city: "Pune",
      payMin: 20000,
      payMax: 35000,
      shift: "rotational",
      neededBy: "immediate",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // Snake_case, straight through from form state — no invented price, no camelCase leak.
    expect(body.city).toBe("Pune");
    expect(body.pay_min).toBe(20000);
    expect(body.pay_max).toBe(35000);
    expect(body.shift).toBe("rotational");
    expect(body.needed_by).toBe("immediate");
    expect(body).not.toHaveProperty("payMin");
    expect(body).not.toHaveProperty("neededBy");
  });

  it("updatePosting maps a 404 to a neutral null", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "not found" }, 404));
    const { updatePosting } = await import("./payer-api");
    const res = await updatePosting(POSTING_ID, { roleTitle: "Fitter", vacancies: 1 });
    expect(res).toBeNull();
  });

  // #1912 — a validation 400 carries `error.issues[]`; the transport surfaces it as a
  // typed PayerValidationError so a form can render the refused field inline.
  it("updatePosting surfaces a 400's field issues as a PayerValidationError", async () => {
    const body = {
      statusCode: 400,
      error: {
        message: "Validation failed",
        issues: [{ path: "role_title", message: "remove contact details from the title" }],
      },
    };
    fetchMock.mockImplementation(async () => jsonResponse(body, 400));
    const { updatePosting } = await import("./payer-api");
    const { PayerValidationError } = await import("./payer-errors");

    await expect(
      updatePosting(POSTING_ID, { roleTitle: "Call 9876543210" }),
    ).rejects.toMatchObject({
      name: "PayerValidationError",
      issues: [{ path: "role_title", message: "remove contact details from the title" }],
    });
    await expect(
      updatePosting(POSTING_ID, { roleTitle: "Call 9876543210" }),
    ).rejects.toBeInstanceOf(PayerValidationError);
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
 * re-points a swapped function at a mock (or resurrects the mock store) fails CI
 * rather than slipping through. Reads the seam source as text (no execution).
 */
describe("live-swap guardrails (source) — the seam is FULLY live, no mock fallback", () => {
  const src = readFileSync(fileURLToPath(new URL("./payer-api.ts", import.meta.url)), "utf8");

  it("NOTHING routes through the mock store anymore (the module is deleted)", () => {
    expect(src).not.toMatch(/mock-store/);
    expect(src).not.toMatch(/store\./);
    expect(src).not.toMatch(/LIVE-SWAP BLOCKED/);
    expect(src).not.toMatch(/WAITING \(mock\)/);
    // Seam docs may never again claim a surface "stays MOCK" while the code is live.
    expect(src).not.toMatch(/stay MOCK|stays MOCK/);
  });

  it("the live posting CRUD goes to the payer-authed /payer/job-postings routes", () => {
    // The swapped functions hit the live route family (a regression to a mock shim drops these).
    expect(src).toMatch(/payerFetch\("\/payer\/job-postings"/); // create (POST) + list (GET)
    expect(src).toMatch(/payerFetch\(`\/payer\/job-postings\/\$\{postingId\}`/); // get-one + edit
    expect(src).toMatch(/payerFetch\(`\/payer\/job-postings\/\$\{postingId\}\/close`/); // close
  });

  it("the lifecycle trio + disclosure + ledger are LIVE payer-authed routes", () => {
    expect(src).toMatch(/\/payer\/job-postings\/\$\{input\.postingId\}\/pause/);
    expect(src).toMatch(/\/payer\/job-postings\/\$\{input\.postingId\}\/resume/);
    expect(src).toMatch(/\/payer\/job-postings\/\$\{input\.postingId\}\/quota-topup/);
    expect(src).toMatch(/payerFetch\("\/payer\/resume-disclosures"/);
    expect(src).toMatch(/payerFetch\("\/payer\/credits\/ledger/);
  });
});

/**
 * #2085 — PRICE CONFIRMATION and the IDEMPOTENT quota top-up, through the REAL transport.
 *
 *  - every purchase body carries `expected_price_inr` = the price the caller confirmed, beside its
 *    code, and nothing else new (never a payer_id, never an amount to charge);
 *  - a 409 `price_mismatch` — as the API's exception filter actually puts it on the wire, nested
 *    under `error` — is a {@link PriceMismatchError} carrying the API's current price, on every
 *    purchase route. It must NOT be read as the in-flight duplicate (PurchaseConflictError), the
 *    no-active-plan 409, a 404 null, or capacity's neutral `{ ok:false }`;
 *  - the quota top-up sends the caller's `Idempotency-Key` verbatim, and tells its in-flight
 *    duplicate (still processing) apart from "no active plan".
 */
describe("#2085 — expected_price_inr, price_mismatch, and the idempotent quota top-up", () => {
  const PAYER_A = "11111111-1111-4111-8111-111111111111";
  const KEY = "5f9d1c2e-1a2b-4c3d-8e4f-0a1b2c3d4e5f";

  /** A 409 exactly as `AllExceptionsFilter` serialises a thrown ConflictException payload. */
  function conflict(payload: Record<string, unknown>): Response {
    return jsonResponse(
      {
        statusCode: 409,
        error: { statusCode: 409, error: "Conflict", ...payload },
        requestId: "req-1",
        path: "/payer/x",
        timestamp: "2026-10-07T09:00:00.000Z",
      },
      409,
    );
  }
  const priceMismatch = (expected: number, current: number) =>
    conflict({
      reason: "price_mismatch",
      message: `The price changed: you confirmed ₹${expected} but the current price is ₹${current}. Nothing was charged; re-read the price and confirm again`,
      expected_price_inr: expected,
      current_price_inr: current,
    });
  const bodyOf = (call: unknown) =>
    JSON.parse((call as [string, RequestInit])[1].body as string) as Record<string, unknown>;
  const callTo = (suffix: string) =>
    fetchMock.mock.calls.find((c) => (c[0] as string).endsWith(suffix));

  it("topUp sends the confirmed price beside the pack code — and nothing else", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ payer_id: PAYER_A, balance: 57, credits: 50, pack_code: "pack_50" }, 201),
    );
    const { topUp } = await import("./payer-api");
    await topUp({ packCode: "pack_50", idempotencyKey: KEY, expectedPriceInr: 2000 });
    expect(bodyOf(fetchMock.mock.calls[0])).toStrictEqual({
      pack_code: "pack_50",
      expected_price_inr: 2000,
    });
  });

  it("topUp: a price_mismatch is a PriceMismatchError with the API's current price — NOT the in-flight conflict", async () => {
    fetchMock.mockResolvedValue(priceMismatch(2000, 1500));
    const { topUp, PurchaseConflictError } = await import("./payer-api");
    const { PriceMismatchError } = await import("./payer-errors");
    const err = await topUp({ packCode: "pack_50", expectedPriceInr: 2000 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PriceMismatchError);
    expect(err).not.toBeInstanceOf(PurchaseConflictError);
    expect((err as InstanceType<typeof PriceMismatchError>).currentPriceInr).toBe(1500);
    expect(fetchMock).toHaveBeenCalledTimes(1); // refused once — never re-posted at the new price
  });

  it("a 409 WITHOUT reason price_mismatch is still the in-flight conflict (existing handling kept)", async () => {
    fetchMock.mockResolvedValue(
      conflict({
        message: "This purchase is already being processed; check your balance before trying again",
      }),
    );
    const { topUp, PurchaseConflictError } = await import("./payer-api");
    await expect(topUp({ packCode: "pack_50", idempotencyKey: KEY })).rejects.toBeInstanceOf(
      PurchaseConflictError,
    );
  });

  it("createCreditOrder sends the confirmed price; a price_mismatch is a PriceMismatchError, not a null 404", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        order_id: "order_1",
        key_id: "rzp_test_k",
        amount: 200000,
        amount_inr: 2000,
        currency: "INR",
        pack_code: "pack_50",
        credits: 50,
      }),
    );
    const { createCreditOrder } = await import("./payer-api");
    const { PriceMismatchError } = await import("./payer-errors");
    await createCreditOrder({ packCode: "pack_50", expectedPriceInr: 2000 });
    expect(bodyOf(fetchMock.mock.calls[0])).toStrictEqual({
      pack_code: "pack_50",
      expected_price_inr: 2000,
    });

    fetchMock.mockResolvedValueOnce(priceMismatch(2000, 2400));
    const err = await createCreditOrder({ packCode: "pack_50", expectedPriceInr: 2000 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PriceMismatchError);
    expect((err as InstanceType<typeof PriceMismatchError>).currentPriceInr).toBe(2400);
  });

  it("buyCapacity sends the confirmed price; a price_mismatch THROWS — never the neutral 'retry' { ok:false }", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        payer_id: PAYER_A,
        quote: {},
        max_active_vacancies: 15,
        source_tier: "cap_15",
        expires_at: null,
        resumed_plan_ids: [],
      }),
    );
    const { buyCapacity, PurchaseConflictError } = await import("./payer-api");
    const { PriceMismatchError } = await import("./payer-errors");
    await buyCapacity({ tier: "cap_15", idempotencyKey: KEY, expectedPriceInr: 12000 });
    expect(bodyOf(fetchMock.mock.calls[0])).toStrictEqual({
      tier: "cap_15",
      expected_price_inr: 12000,
    });

    fetchMock.mockResolvedValueOnce(priceMismatch(12000, 9000));
    const err = await buyCapacity({
      tier: "cap_15",
      idempotencyKey: KEY,
      expectedPriceInr: 12000,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PriceMismatchError);
    expect(err).not.toBeInstanceOf(PurchaseConflictError);
    expect((err as InstanceType<typeof PriceMismatchError>).currentPriceInr).toBe(9000);
  });

  it("a FLAT price_mismatch body is read too; a missing or garbled current price is null, never a guess", async () => {
    const { topUp } = await import("./payer-api");
    const { PriceMismatchError } = await import("./payer-errors");
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ reason: "price_mismatch", current_price_inr: 1800 }, 409),
    );
    const flat = await topUp({ packCode: "pack_50", expectedPriceInr: 2000 }).catch(
      (e: unknown) => e,
    );
    expect((flat as InstanceType<typeof PriceMismatchError>).currentPriceInr).toBe(1800);

    for (const current of [undefined, "1800", -5, 12.5]) {
      fetchMock.mockResolvedValueOnce(
        conflict({ reason: "price_mismatch", current_price_inr: current }),
      );
      const err = await topUp({ packCode: "pack_50", expectedPriceInr: 2000 }).catch(
        (e: unknown) => e,
      );
      expect(err, String(current)).toBeInstanceOf(PriceMismatchError);
      expect(
        (err as InstanceType<typeof PriceMismatchError>).currentPriceInr,
        String(current),
      ).toBeNull();
    }
  });

  /** quota-topup routes: the catalog read, the POST (answered by `topup`), the posting re-read. */
  function topUpRoutes(topup: () => Response) {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/payer/pricing/catalog")) return Promise.resolve(catalogResponse());
      if (url.endsWith("/quota-topup")) return Promise.resolve(topup());
      return Promise.resolve(jsonResponse(jobPostingRow({ status: "open" })));
    });
  }

  it("quota-topup sends the confirmed price and the purchase's Idempotency-Key header, verbatim", async () => {
    topUpRoutes(() => jsonResponse({ plan: { id: "p1" }, quote: {} }, 201));
    const { topUpPostingQuota } = await import("./payer-api");
    await topUpPostingQuota({
      postingId: POSTING_ID,
      tier: TOPUP_10,
      expectedPriceInr: 1000, idempotencyKey: KEY });
    const call = callTo("/quota-topup") as [string, RequestInit];
    expect(bodyOf(call)).toStrictEqual({ tier: "topup_10", expected_price_inr: 1000 });
    expect((call[1].headers as Record<string, string>)["Idempotency-Key"]).toBe(KEY);
  });

  it("quota-topup without a key sends no Idempotency-Key header (the header stays optional)", async () => {
    topUpRoutes(() => jsonResponse({ plan: { id: "p1" }, quote: {} }, 201));
    const { topUpPostingQuota } = await import("./payer-api");
    await topUpPostingQuota({
      postingId: POSTING_ID,
      tier: TOPUP_10,
      expectedPriceInr: 1000 });
    const call = callTo("/quota-topup") as [string, RequestInit];
    expect(call[1].headers as Record<string, string>).not.toHaveProperty("Idempotency-Key");
  });

  it("quota-topup: price_mismatch → PriceMismatchError (not 'no active plan')", async () => {
    topUpRoutes(() => priceMismatch(1000, 750));
    const { topUpPostingQuota, QuotaTopUpNoPlanError } = await import("./payer-api");
    const { PriceMismatchError } = await import("./payer-errors");
    const err = await topUpPostingQuota({
      postingId: POSTING_ID,
      tier: TOPUP_10,
      expectedPriceInr: 1000,
      idempotencyKey: KEY,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PriceMismatchError);
    expect(err).not.toBeInstanceOf(QuotaTopUpNoPlanError);
    expect((err as InstanceType<typeof PriceMismatchError>).currentPriceInr).toBe(750);
  });

  it("quota-topup: the in-flight duplicate is 'still processing', NOT 'buy a plan first'", async () => {
    topUpRoutes(() =>
      conflict({
        message:
          "This quota top-up is already being processed; check the posting before trying again",
      }),
    );
    const { topUpPostingQuota, PurchaseConflictError, QuotaTopUpNoPlanError } =
      await import("./payer-api");
    const err = await topUpPostingQuota({
      postingId: POSTING_ID,
      tier: TOPUP_10,
      expectedPriceInr: 1000,
      idempotencyKey: KEY,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PurchaseConflictError);
    expect(err).not.toBeInstanceOf(QuotaTopUpNoPlanError);
  });

  it("quota-topup: the real no-active-plan 409 (wire envelope) is still QuotaTopUpNoPlanError", async () => {
    topUpRoutes(() => conflict({ message: "no active plan to top up for this posting" }));
    const { topUpPostingQuota, QuotaTopUpNoPlanError } = await import("./payer-api");
    await expect(
      topUpPostingQuota({
      postingId: POSTING_ID,
      tier: TOPUP_10,
      expectedPriceInr: 1000, idempotencyKey: KEY }),
    ).rejects.toBeInstanceOf(QuotaTopUpNoPlanError);
  });
});

/**
 * #2111 — a purchase 409's machine-readable REASON (#2135): `reason: "in_flight"` on every purchase
 * route, `reason: "no_active_plan"` on the quota top-up, nested on the wire as
 * `{ statusCode, error: { statusCode, error, message, reason }, requestId, path, timestamp }`.
 * The seams decide on the reason when the API names one — a reason they do not know is never
 * guessed into "still processing" or "buy a plan first" — and keep their old reading for an API
 * from before #2135 (no reason; payer-web may deploy first): a bare 409 is the in-flight duplicate
 * on credits / capacity, and the quota top-up tells its two 409s apart by the documented message.
 * (Those reason-ABSENT paths are the #1165 / #2085 suites above.)
 */
describe("#2111 — a purchase 409's reason (#2135) decides; an API without it still works", () => {
  const KEY = "5f9d1c2e-1a2b-4c3d-8e4f-0a1b2c3d4e5f";
  /** A 409 exactly as `AllExceptionsFilter` serialises a thrown ConflictException payload. */
  function conflict(payload: Record<string, unknown>): Response {
    return jsonResponse(
      {
        statusCode: 409,
        error: { statusCode: 409, error: "Conflict", ...payload },
        requestId: "req-1",
        path: "/payer/x",
        timestamp: "2026-10-07T09:00:00.000Z",
      },
      409,
    );
  }
  /** quota-topup routes: the catalog read, the POST (answered by `topup`), the posting re-read. */
  function topUpRoutes(topup: () => Response) {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/payer/pricing/catalog")) return Promise.resolve(catalogResponse());
      if (url.endsWith("/quota-topup")) return Promise.resolve(topup());
      return Promise.resolve(jsonResponse(jobPostingRow({ status: "open" })));
    });
  }
  const topUpQuota = async () => {
    const { topUpPostingQuota } = await import("./payer-api");
    return topUpPostingQuota({
      postingId: POSTING_ID,
      tier: TOPUP_10,
      expectedPriceInr: 1000,
      idempotencyKey: KEY,
    }).catch((e: unknown) => e);
  };

  it("credits: reason in_flight is the in-flight duplicate, whatever the message says", async () => {
    fetchMock.mockResolvedValue(conflict({ reason: "in_flight", message: "Busy" }));
    const { topUp, PurchaseConflictError } = await import("./payer-api");
    await expect(topUp({ packCode: "pack_50", idempotencyKey: KEY })).rejects.toBeInstanceOf(
      PurchaseConflictError,
    );
  });

  it("credits: a 409 naming ANOTHER reason is not read as in flight — it propagates (the action's retryable failure)", async () => {
    fetchMock.mockResolvedValue(
      conflict({ reason: "pack_retired", message: "This purchase is already being processed" }),
    );
    const { topUp, PurchaseConflictError } = await import("./payer-api");
    const { PayerConflictError } = await import("./payer-errors");
    const err = await topUp({ packCode: "pack_50", idempotencyKey: KEY }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(PurchaseConflictError);
    expect(err).toBeInstanceOf(PayerConflictError);
    expect((err as InstanceType<typeof PayerConflictError>).reason).toBe("pack_retired");
  });

  it("capacity: reason in_flight is the in-flight duplicate (never the neutral 'retry')", async () => {
    fetchMock.mockResolvedValue(conflict({ reason: "in_flight", message: "Busy" }));
    const { buyCapacity, PurchaseConflictError } = await import("./payer-api");
    await expect(buyCapacity({ tier: "growth", idempotencyKey: KEY })).rejects.toBeInstanceOf(
      PurchaseConflictError,
    );
  });

  it("capacity: a 409 naming ANOTHER reason is the neutral failure, not 'still processing'", async () => {
    fetchMock.mockResolvedValue(conflict({ reason: "tier_retired", message: "x" }));
    const { buyCapacity } = await import("./payer-api");
    await expect(buyCapacity({ tier: "growth", idempotencyKey: KEY })).resolves.toEqual({
      ok: false,
      error: "Capacity upgrade failed (service unavailable). Please retry.",
    });
  });

  it("credits + capacity: a 409 with NO reason (an API before #2135) is still the in-flight duplicate", async () => {
    const { topUp, buyCapacity, PurchaseConflictError } = await import("./payer-api");
    fetchMock.mockResolvedValue(conflict({ message: "This purchase is already being processed" }));
    await expect(topUp({ packCode: "pack_50", idempotencyKey: KEY })).rejects.toBeInstanceOf(
      PurchaseConflictError,
    );
    await expect(buyCapacity({ tier: "growth", idempotencyKey: KEY })).rejects.toBeInstanceOf(
      PurchaseConflictError,
    );
  });

  it("quota-topup: reason no_active_plan → 'buy a plan first' — even under the in-flight message", async () => {
    topUpRoutes(() =>
      conflict({
        reason: "no_active_plan",
        message: "This quota top-up is already being processed; check the posting before trying again",
      }),
    );
    const { PurchaseConflictError, QuotaTopUpNoPlanError } = await import("./payer-api");
    const err = await topUpQuota();
    expect(err).toBeInstanceOf(QuotaTopUpNoPlanError);
    expect(err).not.toBeInstanceOf(PurchaseConflictError);
  });

  it("quota-topup: reason in_flight → 'still processing' — even under the no-plan message", async () => {
    topUpRoutes(() =>
      conflict({ reason: "in_flight", message: "no active plan to top up for this posting" }),
    );
    const { PurchaseConflictError, QuotaTopUpNoPlanError } = await import("./payer-api");
    const err = await topUpQuota();
    expect(err).toBeInstanceOf(PurchaseConflictError);
    expect(err).not.toBeInstanceOf(QuotaTopUpNoPlanError);
  });

  it("quota-topup: a reason it does not know is neither answer — it propagates", async () => {
    topUpRoutes(() => conflict({ reason: "plan_frozen", message: "no active plan to top up" }));
    const { PurchaseConflictError, QuotaTopUpNoPlanError } = await import("./payer-api");
    const { PayerConflictError } = await import("./payer-errors");
    const err = await topUpQuota();
    expect(err).toBeInstanceOf(PayerConflictError);
    expect(err).not.toBeInstanceOf(PurchaseConflictError);
    expect(err).not.toBeInstanceOf(QuotaTopUpNoPlanError);
  });
});

/**
 * #2085 L1 — the quota top-up buys the tier the payer CONFIRMED, or nothing. The seam used to
 * re-pick "the smallest top-up tier" from a fresh catalog at submit, so an ops edit between the
 * dialog and the confirm bought something else — and `expected_price_inr` cannot catch a
 * same-price swap. Now the confirmed tier is checked against the live catalog: a tier that is
 * gone, unpriced or re-sized is refused BEFORE any request; another tier is never substituted.
 */
describe("#2085 L1 — topUpPostingQuota buys the confirmed tier or nothing", () => {
  const topUpProduct = (tiers: { code: string; priceInr: number; additionalVisibilityQuota: number }[]) =>
    DEFAULT_CATALOG.products.map((p) => (p.kind === "quota_topup" ? { ...p, tiers } : p));
  /** Answer the catalog with `products` (+ optional prices[]), the top-up with 201, the re-read with the row. */
  function routes(products: unknown, prices?: unknown[]) {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/payer/pricing/catalog")) {
        return Promise.resolve(
          jsonResponse({ revision: 2, source: "db", products, ...(prices ? { prices } : {}) }),
        );
      }
      if (url.endsWith("/quota-topup")) {
        return Promise.resolve(jsonResponse({ plan: { id: "p1" }, quote: {} }, 201));
      }
      return Promise.resolve(jsonResponse(jobPostingRow({ status: "open" })));
    });
  }
  const topUpPosts = () => fetchMock.mock.calls.filter((c) => (c[0] as string).endsWith("/quota-topup"));

  it("a SAME-PRICE tier added since the dialog (now the smallest) does not displace the confirmed one", async () => {
    routes(
      topUpProduct([
        { code: "topup_5", priceInr: 1000, additionalVisibilityQuota: 5 },
        { code: "topup_10", priceInr: 1000, additionalVisibilityQuota: 10 },
      ]),
    );
    const { topUpPostingQuota } = await import("./payer-api");
    const outcome = await topUpPostingQuota({
      postingId: POSTING_ID,
      tier: TOPUP_10,
      expectedPriceInr: 1000,
    });
    expect(topUpPosts()).toHaveLength(1);
    const body = JSON.parse((topUpPosts()[0] as [string, RequestInit])[1].body as string);
    expect(body).toStrictEqual({ tier: "topup_10", expected_price_inr: 1000 });
    expect(outcome?.addedViews).toBe(10);
  });

  it("the confirmed tier RE-SIZED since the dialog is refused — PurchaseOptionChangedError, nothing posted", async () => {
    routes(topUpProduct([{ code: "topup_10", priceInr: 1000, additionalVisibilityQuota: 5 }]));
    const { topUpPostingQuota } = await import("./payer-api");
    const { PurchaseOptionChangedError } = await import("./payer-errors");
    await expect(
      topUpPostingQuota({ postingId: POSTING_ID, tier: TOPUP_10, expectedPriceInr: 1000 }),
    ).rejects.toBeInstanceOf(PurchaseOptionChangedError);
    expect(topUpPosts()).toEqual([]);
  });

  it("the confirmed tier GONE from the catalog is refused the same way — never another tier", async () => {
    routes(topUpProduct([{ code: "topup_30", priceInr: 2500, additionalVisibilityQuota: 30 }]));
    const { topUpPostingQuota } = await import("./payer-api");
    const { PurchaseOptionChangedError } = await import("./payer-errors");
    await expect(
      topUpPostingQuota({ postingId: POSTING_ID, tier: TOPUP_10, expectedPriceInr: 1000 }),
    ).rejects.toBeInstanceOf(PurchaseOptionChangedError);
    expect(topUpPosts()).toEqual([]);
  });

  it("the confirmed tier UNPRICED in a present prices[] is not on offer — refused, nothing posted", async () => {
    routes(DEFAULT_CATALOG.products, [
      {
        product_code: "quota_topup",
        tier_code: "topup_30",
        base_price_inr: 2500,
        price_inr: 2500,
        discount_inr: 0,
        offer: null,
      },
    ]);
    const { topUpPostingQuota } = await import("./payer-api");
    const { PurchaseOptionChangedError } = await import("./payer-errors");
    await expect(
      topUpPostingQuota({ postingId: POSTING_ID, tier: TOPUP_10, expectedPriceInr: 1000 }),
    ).rejects.toBeInstanceOf(PurchaseOptionChangedError);
    expect(topUpPosts()).toEqual([]);
  });
});
