import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GuardModule from "./assert-no-agency-pii";

/**
 * Agency SUPPLY-money LIVE-seam transport tests (ADR-0022 Amendment 2). Exercises the REAL
 * `payerFetch` (mocked fetch + payer JWT cookie) to pin the GATE + no-oracle contracts the
 * action-layer tests mock away:
 *  - a gated-route 404 → `null` ("supply payouts not enabled"), for earnings / KYC / payouts,
 *  - the KYC submit body is snake_case + Bearer-only (NO client payer_id — XB-A) and the raw
 *    PAN/bank ride the BODY only,
 *  - the MASKED KYC response (panLast4 / bankLast4) passes the faceless guard (allow-listed),
 *  - the payout POST discriminated union (created | blocked) is passed through as-is.
 */

const TOKEN = "payer.jwt.token";

vi.mock("./auth/session-cookie", () => ({
  readApiToken: vi.fn(async () => TOKEN),
  API_TOKEN_COOKIE_NAME: "bb_payer_token",
  sessionCookieOptions: () => ({}),
}));
vi.mock("./auth", () => ({
  requirePayer: vi.fn(async () => ({
    payerId: "22222222-2222-4222-8222-222222222222",
    displayLabel: "HireFast Agency",
    role: "agent",
  })),
}));

// The REAL faceless guard, wrapped in a call-through spy: every existing test still runs through
// the genuine key scan, and the crossing test below can see WHICH reads cross it, with what label.
vi.mock("./assert-no-agency-pii", async () => {
  const actual = await vi.importActual<typeof GuardModule>("./assert-no-agency-pii");
  return { ...actual, assertNoAgencyPII: vi.fn(actual.assertNoAgencyPII) };
});

const fetchMock = vi.fn();

const EARNINGS = {
  totalAccruedInr: 1200,
  requestableInr: 800,
  inRequestInr: 0,
  paidInr: 400,
  accrualCount: 30,
  kycStatus: "verified",
  thresholdInr: 500,
  basisInr: 40,
  rateBps: 2500,
  windowDays: 90,
  payoutsEnabled: true,
  canRequest: true,
  blockedReason: null,
};

// The FIRST `import("./payer-api")` pays the cold load of its whole module graph: ~0.4 s alone,
// ~2.85 s under a parallel run — and it used to land inside this file's first test, which then
// timed out at vitest's 5 s default (final re-sweep N6; a CI risk too). It is paid ONCE here, on
// an explicit budget (the same as the other whole-graph loads: #2023, #2026, #2051), and every
// test's own `await import("./payer-api")` is then a cache hit. No assertion depends on it.
beforeAll(async () => {
  await import("./payer-api");
}, 30_000);

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

describe("gated 404 → null (supply payouts not enabled)", () => {
  it("getAgencyEarnings / getAgencyKyc / listAgencyPayouts all map a 404 to null", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "Not Found" }, 404));
    const { getAgencyEarnings, getAgencyKyc, listAgencyPayouts } = await import("./payer-api");
    await expect(getAgencyEarnings()).resolves.toBeNull();
    await expect(getAgencyKyc()).resolves.toBeNull();
    await expect(listAgencyPayouts()).resolves.toBeNull();
  });

  it("requestAgencyPayout maps a 404 to null", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "Not Found" }, 404));
    const { requestAgencyPayout } = await import("./payer-api");
    await expect(requestAgencyPayout()).resolves.toBeNull();
  });

  it("a non-404 failure propagates (transient error, NOT the not-enabled signal)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "boom" }, 503));
    const { getAgencyEarnings } = await import("./payer-api");
    await expect(getAgencyEarnings()).rejects.toThrow(/returned 503/);
  });
});

describe("earnings read — parses the whole-₹ summary on 200", () => {
  it("returns the parsed earnings", async () => {
    fetchMock.mockResolvedValue(jsonResponse(EARNINGS));
    const { getAgencyEarnings } = await import("./payer-api");
    await expect(getAgencyEarnings()).resolves.toEqual(EARNINGS);
  });
});

describe("KYC — masked response passes the faceless guard; submit body is snake_case", () => {
  it("getAgencyKyc returns the MASKED status without throwing on panLast4/bankLast4", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        status: "verified",
        panLast4: "234F",
        bankLast4: "6789",
        rejectReason: null,
        updatedAt: "2026-07-23T00:00:00.000Z",
      }),
    );
    const { getAgencyKyc } = await import("./payer-api");
    const kyc = await getAgencyKyc();
    expect(kyc).toMatchObject({ status: "verified", panLast4: "234F", bankLast4: "6789" });
  });

  it("submitAgencyKyc sends a snake_case body + Bearer, NO payer_id (raw PAN/bank write-only)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { status: "pending", panLast4: "234F", bankLast4: "6789", rejectReason: null, updatedAt: "x" },
        201,
      ),
    );
    const { submitAgencyKyc } = await import("./payer-api");
    await submitAgencyKyc({
      pan: "ABCDE1234F",
      bankAccount: "123456789",
      ifsc: "HDFC0001234",
      accountHolderName: "Acme Tools",
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/payer/agency/kyc");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      pan: "ABCDE1234F",
      bank_account: "123456789",
      ifsc: "HDFC0001234",
      account_holder_name: "Acme Tools",
    });
    expect(body).not.toHaveProperty("payer_id");
    expect(body).not.toHaveProperty("payerId");
  });
});

describe("payout POST — discriminated union passthrough", () => {
  it("passes a created result through as-is", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: true, requestId: "req_1", amountInr: 800, accrualCount: 30 }, 201),
    );
    const { requestAgencyPayout } = await import("./payer-api");
    await expect(requestAgencyPayout()).resolves.toEqual({
      ok: true,
      requestId: "req_1",
      amountInr: 800,
      accrualCount: 30,
    });
  });

  it("passes a blocked result through as-is (no fake success)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: false, blocked: true, reason: "below_threshold" }),
    );
    const { requestAgencyPayout } = await import("./payer-api");
    await expect(requestAgencyPayout()).resolves.toEqual({
      ok: false,
      blocked: true,
      reason: "below_threshold",
    });
  });

  it("lists payout history on 200", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        { id: "p1", amountInr: 400, accrualCount: 10, status: "paid", createdAt: "2026-07-01T00:00:00Z" },
      ]),
    );
    const { listAgencyPayouts } = await import("./payer-api");
    await expect(listAgencyPayouts()).resolves.toEqual([
      { id: "p1", amountInr: 400, accrualCount: 10, status: "paid", createdAt: "2026-07-01T00:00:00Z" },
    ]);
  });
});

describe("every gated money read crosses the faceless guard (defence-in-depth)", () => {
  const PAYOUTS = [
    {
      id: "p1",
      amountInr: 400,
      accrualCount: 10,
      status: "paid",
      createdAt: "2026-07-01T00:00:00Z",
    },
  ];
  const KYC = {
    status: "verified",
    panLast4: "234F",
    bankLast4: "6789",
    rejectReason: null,
    updatedAt: "2026-07-23T00:00:00.000Z",
  };

  it.each([
    ["listAgencyPayouts", "payer/agency/payouts", PAYOUTS],
    ["getAgencyEarnings", "payer/agency/earnings", EARNINGS],
    ["getAgencyKyc", "payer/agency/kyc", KYC],
  ] as const)("%s hands its parsed payload to assertNoAgencyPII as %s", async (fn, label, body) => {
    const { assertNoAgencyPII } = await import("./assert-no-agency-pii");
    const guard = vi.mocked(assertNoAgencyPII);
    guard.mockClear();
    fetchMock.mockResolvedValue(jsonResponse(body));
    const api = await import("./payer-api");
    const out = await (api[fn] as () => Promise<unknown>)();
    expect(guard).toHaveBeenCalledTimes(1);
    expect(guard).toHaveBeenCalledWith(body, label);
    // What the page receives is what the guard returned — nothing bypasses it.
    expect(out).toEqual(guard.mock.results[0]!.value);
  });

  it("the payout history's own keys pass the key scan (nothing is stripped or thrown)", async () => {
    const { assertNoAgencyPII } =
      await vi.importActual<typeof GuardModule>("./assert-no-agency-pii");
    expect(assertNoAgencyPII(PAYOUTS, "payouts")).toEqual(PAYOUTS);
    // …while the same guard still refuses a regressed row carrying a worker identity.
    expect(() => assertNoAgencyPII([{ ...PAYOUTS[0], workerName: "x" }], "payouts")).toThrow(
      /forbidden PII key/,
    );
  });
});
