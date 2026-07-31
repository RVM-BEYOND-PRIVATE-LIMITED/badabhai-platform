import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AGENCY WORKER-ENGAGEMENT + BATCH-INVITE seam tests (ADR-0022 B5), exercising the REAL
 * `payerFetch` (mocked fetch + payer JWT cookie) like agency-seam.test.ts.
 *
 * Pinned contracts:
 *  - `listAgencyWorkers` maps `{ workers: [...] }` to the five-field faceless row, passes a
 *    null `lastActiveOn` through untouched, and returns `[]` for an empty list (the state
 *    this surface actually ships in — no consent client exists yet).
 *  - The FACELESS BOUNDARY IS ENFORCED, not decorative: a regressed payload carrying a
 *    forbidden key (a worker name) makes the seam THROW via `assertNoAgencyPII` in dev/test.
 *    This is why the transport schema parses loosely — a strict `z.object` would strip the
 *    key before the guard could ever see it.
 *  - Any key OUTSIDE the contract is dropped, so a new backend field can never reach the UI
 *    unreviewed.
 *  - `createAgencyInviteBatch` sends `{ count }` (+ optional campaign) and NO payer_id (XB-A),
 *    and maps the mint 429 (cap OR Redis fail-closed) to ONE neutral `{ ok: false }`.
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

const fetchMock = vi.fn();

const WORKER = {
  ref: "9f3a71c40b28de55",
  profileComplete: true,
  appliedCount: 4,
  unlockedCount: 2,
  lastActiveOn: "2026-07-28",
};

beforeEach(() => {
  process.env.PAYER_API_URL = "http://api.test";
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

describe("listAgencyWorkers — wire → faceless rows", () => {
  it("maps the wire shape and calls the session-scoped route with a Bearer (XB-A)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ workers: [WORKER] }));
    const { listAgencyWorkers } = await import("./payer-api");
    await expect(listAgencyWorkers()).resolves.toEqual([WORKER]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // No payer/agency id in the path or query — there is nothing to tamper with.
    expect(url).toBe("http://api.test/payer/agency/workers");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.body).toBeUndefined();
  });

  it("passes a null lastActiveOn through (the page renders it as 'Not seen yet')", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ workers: [{ ...WORKER, lastActiveOn: null }] }));
    const { listAgencyWorkers } = await import("./payer-api");
    const rows = await listAgencyWorkers();
    expect(rows[0]!.lastActiveOn).toBeNull();
  });

  it("returns [] for an empty list (the normal, correct answer — not an error)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ workers: [] }));
    const { listAgencyWorkers } = await import("./payer-api");
    await expect(listAgencyWorkers()).resolves.toEqual([]);
  });

  it("propagates a 429 (the hourly scrape cap) so the page degrades instead of showing []", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "Too many requests" }, 429));
    const { listAgencyWorkers } = await import("./payer-api");
    await expect(listAgencyWorkers()).rejects.toThrow(/returned 429/);
  });
});

describe("listAgencyWorkers — the faceless boundary THROWS, it is not decorative", () => {
  it("throws via assertNoAgencyPII when a row carries a forbidden key (a worker name)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ workers: [{ ...WORKER, name: "Ravi Kumar" }] }),
    );
    const { listAgencyWorkers } = await import("./payer-api");
    await expect(listAgencyWorkers()).rejects.toThrow(/forbidden PII key/);
  });

  it("throws on a forbidden key anywhere in the payload (phone at the top level)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ workers: [WORKER], phone: "9800000000" }));
    const { listAgencyWorkers } = await import("./payer-api");
    await expect(listAgencyWorkers()).rejects.toThrow(/forbidden PII key/);
  });

  it("drops any non-contract key, so a new backend field cannot reach the UI unreviewed", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ workers: [{ ...WORKER, cityLabel: "Pune", workerId: "uuid-like" }] }),
    );
    const { listAgencyWorkers } = await import("./payer-api");
    await expect(listAgencyWorkers()).resolves.toEqual([WORKER]);
  });
});

describe("createAgencyInviteBatch — faceless body, neutral 429", () => {
  it("sends { count } with NO payer_id and returns the opaque codes", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          invites: [
            { agency_invite_id: "00000001-0000-4000-8000-000000000001", code: "aaa1", link: "/i/aaa1" },
            { agency_invite_id: "00000001-0000-4000-8000-000000000002", code: "bbb2", link: "/i/bbb2" },
          ],
        },
        201,
      ),
    );
    const { createAgencyInviteBatch } = await import("./payer-api");
    await expect(createAgencyInviteBatch({ count: 2 })).resolves.toEqual({
      ok: true,
      invites: [
        { code: "aaa1", link: "/i/aaa1" },
        { code: "bbb2", link: "/i/bbb2" },
      ],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/payer/agency/invites/batch");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ count: 2 }); // no campaign key when absent
    expect(body).not.toHaveProperty("payer_id");
    expect(body).not.toHaveProperty("payerId");
  });

  it("includes the optional non-PII campaign tag when given", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ invites: [] }, 201));
    const { createAgencyInviteBatch } = await import("./payer-api");
    await createAgencyInviteBatch({ count: 1, campaign: "diwali-drive" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ count: 1, campaign: "diwali-drive" });
  });

  it("maps a 429 (cap OR Redis fail-closed) to ONE neutral { ok:false }", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "rate limited" }, 429));
    const { createAgencyInviteBatch } = await import("./payer-api");
    await expect(createAgencyInviteBatch({ count: 10 })).resolves.toEqual({ ok: false });
  });
});
