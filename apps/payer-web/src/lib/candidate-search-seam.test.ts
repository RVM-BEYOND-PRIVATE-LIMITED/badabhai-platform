import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPayerBadRequest, isPayerRateLimited } from "./payer-errors";

/**
 * ALL-CANDIDATES seam — `searchCandidates` (POST /payer/candidates/search) and
 * `getCandidateFilters` (GET /payer/candidates/filters), through the REAL `payerFetch` (mocked
 * fetch + payer JWT cookie), like candidate-inbox-seam.test.ts. The backend is not running: the
 * network is the seam under test.
 *
 * Pinned:
 *  - the search is a POST with a JSON body of only the keys the caller set — never a payer id
 *    (XB-A) — and a body of the wrong SHAPE never reaches the network;
 *  - the answer is the contract's, camelCase, untouched (rows, counts, cursor); a row missing a
 *    contract key, or with a value of the wrong kind, fails the parse (an honest error state);
 *  - FACELESS, ENFORCED: a forbidden key anywhere in the answer THROWS (assertNoAgencyPII, dev/
 *    test) — the transport is lenient precisely so the guard sees it; a harmless unknown key is
 *    dropped from the result;
 *  - a 429 (the payer's hourly cap) and a 400 (a refused cursor or body) are told apart;
 *  - the filters read is a GET with no body, parsed as the contract's options.
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

const W1 = "face2000-0000-4000-8000-000000000003";
const ROW = {
  workerId: W1,
  matchesFilters: true,
  matchTier: 1,
  role: { id: "mskill_cnc_turner", label: "CNC Turner" },
  otherRoles: [{ id: "mskill_cnc_setter_operator", label: "CNC Setter-Operator" }],
  skillMonths: 48,
  industry: { id: "ind_industrial_manufacturing", label: "Industrial Manufacturing" },
  industryMonths: 54,
  city: "Pune",
  tradeLevels: [
    {
      skillId: "mskill_cnc_turner",
      skillLabel: "CNC Turner",
      tradeLevel: "setter",
      tradeLevelLabel: "Setter",
      levelConfirmed: true,
    },
  ],
};
const PAGE = {
  total: 62,
  matched: 14,
  unrecorded: 9,
  filtered: true,
  strict: false,
  candidates: [ROW],
  nextCursor: "eyJ2IjoxfQ",
};
const FILTERS = {
  roles: [{ id: "mskill_cnc_turner", label: "CNC Turner", industryId: "ind_industrial_manufacturing" }],
  industries: [{ id: "ind_industrial_manufacturing", label: "Industrial Manufacturing" }],
  experienceBuckets: [{ id: "1_3", label: "1–3 years" }],
  cities: ["Pune"],
  maxRoles: 5,
};

describe("searchCandidates — the request (XB-A: no payer id, ever)", () => {
  it("POSTs JSON to /payer/candidates/search with the Bearer, the body exactly as given", async () => {
    fetchMock.mockResolvedValue(jsonResponse(PAGE));
    const { searchCandidates } = await import("./payer-api");
    const body = {
      skill_ids: ["mskill_cnc_turner"],
      experience: "1_3",
      industry_id: "ind_industrial_manufacturing",
      industry_experience: "1_3",
      city: "Pune",
      strict: true,
      cursor: "eyJ2IjoxfQ",
    };
    await searchCandidates(body);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/payer/candidates/search");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual(body);
    expect(init.body as string).not.toMatch(/payer/i);
  });

  it("no filter → the empty body `{}` (the API's defaults)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...PAGE, filtered: false, candidates: [] }));
    const { searchCandidates } = await import("./payer-api");
    await searchCandidates();
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].body).toBe("{}");
  });

  it("a body of the wrong SHAPE never reaches the network — a payer id least of all", async () => {
    const { searchCandidates } = await import("./payer-api");
    for (const bad of [
      { payer_id: "11111111-1111-4111-8111-111111111111" },
      { skill_ids: ["not-a-skill"] },
      { skill_ids: ["mskill_a", "mskill_b", "mskill_c", "mskill_d", "mskill_e", "mskill_f"] },
      { experience: "1–3 years" },
      { city: "" },
      { limit: 51 },
      { cursor: "x".repeat(257) },
      { strict: "1" },
    ]) {
      await expect(searchCandidates(bad as never), JSON.stringify(bad)).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("searchCandidates — the answer is the contract's", () => {
  it("rows, counts and cursor come back untouched (camelCase)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(PAGE));
    const { searchCandidates } = await import("./payer-api");
    await expect(searchCandidates()).resolves.toEqual(PAGE);
  });

  it("not-recorded is null, never a guess: industryMonths and city parse as null", async () => {
    const unrecorded = { ...ROW, industryMonths: null, city: null, matchTier: null };
    fetchMock.mockResolvedValue(jsonResponse({ ...PAGE, candidates: [unrecorded] }));
    const { searchCandidates } = await import("./payer-api");
    const { candidates } = await searchCandidates();
    expect(candidates[0]).toMatchObject({ industryMonths: null, city: null, matchTier: null });
  });

  it("a row missing a contract key, or carrying the wrong kind of value, fails the parse", async () => {
    const { searchCandidates } = await import("./payer-api");
    const { tradeLevels: _drop, ...noLevels } = ROW;
    for (const bad of [
      noLevels,
      { ...ROW, matchTier: 3 },
      { ...ROW, skillMonths: "48" },
      { ...ROW, workerId: "not-a-uuid" },
      { ...ROW, role: { id: "mskill_cnc_turner" } },
    ]) {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ...PAGE, candidates: [bad] }));
      await expect(searchCandidates(), JSON.stringify(bad)).rejects.toThrow();
    }
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...PAGE, total: undefined }));
    await expect(searchCandidates()).rejects.toThrow();
  });
});

describe("searchCandidates — the faceless boundary is ENFORCED (assertNoAgencyPII)", () => {
  it("a forbidden key on a row THROWS (dev/test) — the lenient transport lets the guard see it", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ...PAGE, candidates: [{ ...ROW, workerName: "Ramesh Kumar" }] }),
    );
    const { searchCandidates } = await import("./payer-api");
    await expect(searchCandidates()).rejects.toThrow(/assertNoAgencyPII\(payer\/candidates\/search\)/);
  });

  it("…and nested (a role, a trade level), and at the top level", async () => {
    const { searchCandidates } = await import("./payer-api");
    for (const bad of [
      { ...PAGE, candidates: [{ ...ROW, role: { ...ROW.role, contact_phone: "9876543210" } }] },
      { ...PAGE, candidates: [{ ...ROW, tradeLevels: [{ ...ROW.tradeLevels[0], email: "x" }] }] },
      { ...PAGE, address: "12 MG Road" },
    ]) {
      fetchMock.mockResolvedValueOnce(jsonResponse(bad));
      await expect(searchCandidates()).rejects.toThrow(/assertNoAgencyPII/);
    }
  });

  it("a harmless key outside the contract is dropped — only the contract reaches the UI", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ...PAGE, futureCount: 1, candidates: [{ ...ROW, futureField: true }] }),
    );
    const { searchCandidates } = await import("./payer-api");
    const result = await searchCandidates();
    expect(result).not.toHaveProperty("futureCount");
    expect(result.candidates[0]).not.toHaveProperty("futureField");
  });
});

describe("searchCandidates — failures throw; a 429 and a 400 are told apart", () => {
  it("a 429 (the payer's hourly cap) is recognisably rate-limited, not a refusal", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: "slow down" } }, 429));
    const { searchCandidates } = await import("./payer-api");
    const err = await searchCandidates().catch((e: unknown) => e);
    expect(isPayerRateLimited(err)).toBe(true);
    expect(isPayerBadRequest(err)).toBe(false);
  });

  it("a 400 — the API's refusal of a cursor it never minted (issues) or a bare one — is a refusal", async () => {
    const { searchCandidates } = await import("./payer-api");
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { message: "Validation failed", issues: [{ path: "cursor", message: "cursor is malformed" }] } }, 400),
    );
    expect(isPayerBadRequest(await searchCandidates({ cursor: "abc" }).catch((e: unknown) => e))).toBe(true);
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 400));
    expect(isPayerBadRequest(await searchCandidates({ cursor: "abc" }).catch((e: unknown) => e))).toBe(true);
  });

  it("a 5xx is a failure that is neither", async () => {
    const { searchCandidates } = await import("./payer-api");
    for (const status of [500, 502, 503]) {
      fetchMock.mockResolvedValueOnce(jsonResponse({}, status));
      const err = await searchCandidates().catch((e: unknown) => e);
      expect(err, String(status)).toBeInstanceOf(Error);
      expect(isPayerRateLimited(err) || isPayerBadRequest(err), String(status)).toBe(false);
    }
  });
});

describe("getCandidateFilters — the options the controls offer", () => {
  it("GETs /payer/candidates/filters with the Bearer and no body, parsed as the contract", async () => {
    fetchMock.mockResolvedValue(jsonResponse(FILTERS));
    const { getCandidateFilters } = await import("./payer-api");
    await expect(getCandidateFilters()).resolves.toEqual(FILTERS);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/payer/candidates/filters");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("a malformed answer, or a failure, throws (the page then offers only Any …)", async () => {
    const { getCandidateFilters } = await import("./payer-api");
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...FILTERS, cities: "Pune" }));
    await expect(getCandidateFilters()).rejects.toThrow();
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 503));
    await expect(getCandidateFilters()).rejects.toThrow();
  });
});
