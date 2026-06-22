import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Agency LIVE-read normalization (ADR-0019 XB-A). Exercises the REAL transport
 * (`payerFetch`) with a mocked fetch + payer-JWT cookie, asserting:
 *  - getAgencyAccount maps GET /payer/me to the agency's OWN non-PII identity only,
 *  - a non-2xx normalizes to a CLASS-ONLY error (no body, no oracle, no PII),
 *  - the request carries ONLY the Bearer token (no client payer_id — XB-A).
 */

const TOKEN = "payer.jwt.token";

vi.mock("./auth/session-cookie", () => ({
  readApiToken: vi.fn(async () => TOKEN),
  API_TOKEN_COOKIE_NAME: "bb_payer_token",
  MOCK_COOKIE_NAME: "bb_payer_session",
  sessionCookieOptions: () => ({}),
}));

vi.mock("./auth", () => ({
  requirePayer: vi.fn(async () => ({
    payerId: "22222222-2222-4222-8222-222222222222",
    displayLabel: "HireFast Agency",
    role: "agent",
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

describe("getAgencyAccount — maps /payer/me to faceless identity", () => {
  it("returns role/status/displayLabel only, Bearer-only, no client payer_id", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: "22222222-2222-4222-8222-222222222222",
        role: "agent",
        status: "active",
        orgName: "HireFast Agency",
      }),
    );
    const { getAgencyAccount } = await import("./payer-api");
    const account = await getAgencyAccount();

    expect(account).toEqual({
      role: "agent",
      status: "active",
      displayLabel: "HireFast Agency",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/payer/me");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    // GET — no body, so there is nowhere for a client payer_id to ride (XB-A).
    expect(init.body).toBeUndefined();
  });

  it("normalizes a 5xx to a class-only error (no body / no oracle / no PII)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "internal: worker Ramesh +91…" }, 500));
    const { getAgencyAccount } = await import("./payer-api");
    await expect(getAgencyAccount()).rejects.toThrow(/returned 500/);
    // The thrown message must NOT carry the upstream body / any PII hint.
    await expect(getAgencyAccount()).rejects.not.toThrow(/Ramesh/);
  });
});
