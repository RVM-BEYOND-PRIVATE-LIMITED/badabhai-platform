import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPayerRateLimited } from "./payer-errors";

/**
 * CANDIDATES INBOX seam — `getCandidateInbox` against `GET /payer/reach/applicants`, through the
 * REAL `payerFetch` (mocked fetch + payer JWT cookie), like agency-workers-seam.test.ts.
 *
 * Pinned contracts:
 *  - BOTH ROW KINDS map through the per-posting mappers: an `agency_job` row is the weighted row
 *    (score / hot / components → signals), a `company_posting` row the Matching V1 row (tier,
 *    months; score/hot pinned placeholders) — each with its `posting` ref untouched;
 *  - the kind is PAIRED with the shape: an unknown kind, or a kind on the other kind's shape,
 *    fails the parse (the page shows its error state) — nothing is guessed;
 *  - the query carries only `postingId` / `cursor` / `limit` — never a payer id — and an id that
 *    is not a uuid never reaches the network;
 *  - FACELESS, ENFORCED: a forbidden key on a row or its posting THROWS (assertNoAgencyPII, dev/
 *    test) — the transport is lenient precisely so the guard can see it; an unknown harmless key
 *    is dropped from the result;
 *  - a 429 (the shared reach cap) is told apart from any other failure.
 */

const TOKEN = "payer.jwt.token";

vi.mock("./auth/session-cookie", () => ({
  readApiToken: vi.fn(async () => TOKEN),
  API_TOKEN_COOKIE_NAME: "bb_payer_token",
  sessionCookieOptions: () => ({}),
}));

const fetchMock = vi.fn();

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

const P1 = "11111111-0000-4000-8000-000000000001";
const J1 = "22222222-0000-4000-8000-000000000001";
const W1 = "aaaaaaaa-0000-4000-8000-000000000001";
const W2 = "bbbbbbbb-0000-4000-8000-000000000002";
const APP = "cccccccc-0000-4000-8000-000000000003";

/** `ApplicantRowDto` + posting — an agency job's applicant. */
const AGENCY_ROW = {
  workerId: W1,
  rank: 2,
  score: 0.82,
  hot: true,
  pushEligible: true,
  components: [
    { signal: "trade", raw: 1, weight: 0.5, reason: "Same trade" },
    { signal: "recency", raw: 0.6, weight: 0.2, reason: "Active this week" },
  ],
  experienceBand: "3-5 yrs",
  tradeLabel: "Fitter",
  cityLabel: null,
  posting: { id: J1, title: "Fitter", kind: "agency_job" },
};

/** `MatchCandidateRowDto` + posting — a company posting's applicant. */
const COMPANY_ROW = {
  workerId: W2,
  applicationId: APP,
  rank: 1,
  matchTier: 2,
  effectiveTier: 1,
  skillMonths: 48,
  industryMonths: 60,
  lastWorkedAt: "2026-09-01T00:00:00.000Z",
  matchedSkillLabel: "VMC operation",
  engineVersion: "v1.3",
  posting: { id: P1, title: "CNC Turner", kind: "company_posting" },
};

describe("getCandidateInbox — both row kinds, mapped like the per-posting feed", () => {
  it("maps an agency row (weighted) and a company row (V1), each with its posting", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ applicants: [AGENCY_ROW, COMPANY_ROW], nextCursor: "eyJ2IjoxfQ" }),
    );
    const { getCandidateInbox } = await import("./payer-api");
    await expect(getCandidateInbox()).resolves.toEqual({
      applicants: [
        {
          workerId: W1,
          rank: 2,
          score: 0.82,
          hot: true,
          signals: ["Same trade", "Active this week"],
          experienceBand: "3-5 yrs",
          tradeLabel: "Fitter",
          cityLabel: undefined,
          posting: { id: J1, title: "Fitter", kind: "agency_job" },
        },
        {
          workerId: W2,
          rank: 1,
          score: 0,
          hot: false,
          signals: [],
          matchTier: 2,
          effectiveTier: 1,
          matchedSkillLabel: "VMC operation",
          skillMonths: 48,
          industryMonths: 60,
          posting: { id: P1, title: "CNC Turner", kind: "company_posting" },
        },
      ],
      nextCursor: "eyJ2IjoxfQ",
    });
  });

  it("the last page says so: nextCursor null", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ applicants: [], nextCursor: null }));
    const { getCandidateInbox } = await import("./payer-api");
    await expect(getCandidateInbox()).resolves.toEqual({ applicants: [], nextCursor: null });
  });

  it("an UNKNOWN posting kind fails the parse — the row is never guessed into a shape", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        applicants: [{ ...AGENCY_ROW, posting: { ...AGENCY_ROW.posting, kind: "franchise_job" } }],
        nextCursor: null,
      }),
    );
    const { getCandidateInbox } = await import("./payer-api");
    await expect(getCandidateInbox()).rejects.toThrow();
  });

  it("a kind on the OTHER kind's shape fails too (kind and shape are paired)", async () => {
    const { getCandidateInbox } = await import("./payer-api");
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        applicants: [{ ...COMPANY_ROW, posting: { ...COMPANY_ROW.posting, kind: "agency_job" } }],
        nextCursor: null,
      }),
    );
    await expect(getCandidateInbox()).rejects.toThrow();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        applicants: [{ ...AGENCY_ROW, posting: { ...AGENCY_ROW.posting, kind: "company_posting" } }],
        nextCursor: null,
      }),
    );
    await expect(getCandidateInbox()).rejects.toThrow();
  });

  it("a row with no posting ref fails the parse", async () => {
    const { posting: _drop, ...bare } = AGENCY_ROW;
    fetchMock.mockResolvedValue(jsonResponse({ applicants: [bare], nextCursor: null }));
    const { getCandidateInbox } = await import("./payer-api");
    await expect(getCandidateInbox()).rejects.toThrow();
  });
});

describe("getCandidateInbox — the query (XB-A: no payer id, ever)", () => {
  it("no filter → the bare route with a Bearer and no body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ applicants: [], nextCursor: null }));
    const { getCandidateInbox } = await import("./payer-api");
    await getCandidateInbox();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/payer/reach/applicants");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("postingId, cursor and limit ride the query string — and nothing else does", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ applicants: [], nextCursor: null }));
    const { getCandidateInbox } = await import("./payer-api");
    await getCandidateInbox({ postingId: P1, cursor: "eyJ2IjoxfQ", limit: 50 });
    const url = new URL((fetchMock.mock.calls[0] as [string])[0]);
    expect(url.pathname).toBe("/payer/reach/applicants");
    expect([...url.searchParams.keys()].sort()).toEqual(["cursor", "limit", "postingId"]);
    expect(url.searchParams.get("postingId")).toBe(P1);
    expect(url.searchParams.get("cursor")).toBe("eyJ2IjoxfQ");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.search).not.toMatch(/payer/i);
  });

  it("a postingId that is not a uuid, or an out-of-range limit, never reaches the network", async () => {
    const { getCandidateInbox } = await import("./payer-api");
    await expect(getCandidateInbox({ postingId: "not-a-uuid" })).rejects.toThrow();
    await expect(getCandidateInbox({ limit: 51 })).rejects.toThrow();
    await expect(getCandidateInbox({ cursor: "x".repeat(257) })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getCandidateInbox — the faceless boundary is ENFORCED (assertNoAgencyPII)", () => {
  it("a forbidden key on a row THROWS (dev/test) — the lenient transport lets the guard see it", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ applicants: [{ ...COMPANY_ROW, workerName: "Ramesh Kumar" }], nextCursor: null }),
    );
    const { getCandidateInbox } = await import("./payer-api");
    await expect(getCandidateInbox()).rejects.toThrow(/assertNoAgencyPII\(payer\/reach\/applicants\)/);
  });

  it("…and on the posting ref", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        applicants: [{ ...AGENCY_ROW, posting: { ...AGENCY_ROW.posting, contact_phone: "9876543210" } }],
        nextCursor: null,
      }),
    );
    const { getCandidateInbox } = await import("./payer-api");
    await expect(getCandidateInbox()).rejects.toThrow(/assertNoAgencyPII/);
  });

  it("a harmless key outside the contract is dropped — only the contract reaches the UI", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        applicants: [{ ...AGENCY_ROW, futureField: 1, posting: { ...AGENCY_ROW.posting, extra: true } }],
        nextCursor: null,
      }),
    );
    const { getCandidateInbox } = await import("./payer-api");
    const [row] = (await getCandidateInbox()).applicants;
    expect(row).not.toHaveProperty("futureField");
    expect(row).not.toHaveProperty("pushEligible");
    expect(row).not.toHaveProperty("components");
    expect(row!.posting).toEqual({ id: J1, title: "Fitter", kind: "agency_job" });
  });
});

describe("getCandidateInbox — failures throw; a 429 is told apart", () => {
  it("a 429 (the shared hourly reach cap) is recognisably rate-limited", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: "slow down" } }, 429));
    const { getCandidateInbox } = await import("./payer-api");
    const err = await getCandidateInbox().catch((e: unknown) => e);
    expect(isPayerRateLimited(err)).toBe(true);
  });

  it("a 500 or a 400 is a failure, not rate-limited", async () => {
    const { getCandidateInbox } = await import("./payer-api");
    for (const status of [500, 400, 503]) {
      fetchMock.mockResolvedValueOnce(jsonResponse({}, status));
      const err = await getCandidateInbox().catch((e: unknown) => e);
      expect(err, String(status)).toBeInstanceOf(Error);
      expect(isPayerRateLimited(err), String(status)).toBe(false);
    }
  });

  it("isPayerRateLimited reads only the transport's 429 shape", () => {
    expect(isPayerRateLimited(new Error("payer API /payer/reach/applicants returned 429"))).toBe(true);
    // The status is the message's LAST token: a longer number, or a later status, is not a 429.
    expect(isPayerRateLimited(new Error("payer API /payer/reach/applicants returned 4290"))).toBe(false);
    expect(isPayerRateLimited(new Error("payer API /x returned 429 returned 500"))).toBe(false);
    // Only a thrown Error counts — not a look-alike object or a bare string.
    expect(isPayerRateLimited({ message: "payer API /x returned 429" })).toBe(false);
    expect(isPayerRateLimited("payer API /x returned 429")).toBe(false);
    expect(isPayerRateLimited(null)).toBe(false);
  });
});
