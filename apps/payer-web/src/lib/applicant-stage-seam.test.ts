import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPayerRateLimited } from "./payer-errors";

/**
 * SAVED APPLICANT STAGES — the data seam (#2139; API #2137), through the REAL `payerFetch`
 * (mocked fetch + payer JWT cookie), like candidate-inbox-seam.test.ts.
 *
 * Pinned contracts:
 *  - READ: a feed row's `stage` (both row shapes, both feeds) is carried through the mappers when
 *    present, and a row WITHOUT one maps to a row with NO `stage` key — the flag-off feed is the
 *    feed it always was. A stage outside the closed three is a parse failure, never guessed;
 *  - INBOX FILTER: `?stage=` rides the query only when asked, beside postingId / cursor; a value
 *    outside the three never reaches the network;
 *  - WRITE: `PUT …/applicants/:workerId/stage` with the body `{ stage }` and nothing else (no payer
 *    id — XB-A), the Bearer, and the parsed answer; the neutral 404 is `null`; a 429 is told
 *    apart; an answer about another row is refused (fail closed).
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

/** The legacy weighted row (an agency job's feed). */
const WEIGHTED = {
  workerId: W1,
  rank: 1,
  score: 0.8,
  hot: false,
  pushEligible: true,
  components: [{ reason: "Same trade" }],
  experienceBand: "3-5 yrs",
  tradeLabel: "Fitter",
  cityLabel: "Pune",
};
/** The Matching V1 row (a company posting's feed). */
const V1 = {
  workerId: W2,
  applicationId: APP,
  rank: 2,
  matchTier: 1,
  effectiveTier: 1,
  skillMonths: 24,
  industryMonths: 36,
  lastWorkedAt: null,
  matchedSkillLabel: "CNC turning",
  engineVersion: "v1.3",
};

const lastCall = () => fetchMock.mock.calls.at(-1) as [string, RequestInit];

describe("getApplicantFeed — the row's saved stage (flag on) and its absence (flag off)", () => {
  it("flag OFF: rows with no stage map to rows with NO stage key — the feed it always was", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ jobId: P1, applicants: [WEIGHTED, V1] }));
    const { getApplicantFeed } = await import("./payer-api");
    const feed = await getApplicantFeed(P1);
    expect(feed!.applicants).toHaveLength(2);
    for (const row of feed!.applicants) expect("stage" in row).toBe(false);
  });

  it("flag ON: each row's stage is carried through BOTH row shapes", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        jobId: P1,
        applicants: [
          { ...WEIGHTED, stage: "shortlist" },
          { ...V1, stage: "passed" },
        ],
      }),
    );
    const { getApplicantFeed } = await import("./payer-api");
    const feed = await getApplicantFeed(P1);
    expect(feed!.applicants.map((a) => [a.workerId, a.stage])).toEqual([
      [W1, "shortlist"],
      [W2, "passed"],
    ]);
  });

  it("a stage outside the closed three fails the parse — never guessed into one", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ jobId: P1, applicants: [{ ...V1, stage: "archived" }] }),
    );
    const { getApplicantFeed } = await import("./payer-api");
    await expect(getApplicantFeed(P1)).rejects.toThrow();
  });
});

describe("getCandidateInbox — the saved stage on its rows, and the ?stage= filter", () => {
  const agencyRow = { ...WEIGHTED, posting: { id: J1, title: "Fitter", kind: "agency_job" } };
  const companyRow = { ...V1, posting: { id: P1, title: "CNC Turner", kind: "company_posting" } };

  it("rows carry their stage when the server sends one, and no stage key when it does not", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        applicants: [
          { ...agencyRow, stage: "new" },
          { ...companyRow, stage: "shortlist" },
        ],
        nextCursor: null,
      }),
    );
    const { getCandidateInbox } = await import("./payer-api");
    const on = await getCandidateInbox();
    expect(on.applicants.map((a) => a.stage)).toEqual(["new", "shortlist"]);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ applicants: [agencyRow, companyRow], nextCursor: null }),
    );
    const off = await getCandidateInbox();
    for (const row of off.applicants) expect("stage" in row).toBe(false);
  });

  it("?stage= rides the query beside postingId and cursor — only when asked", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ applicants: [], nextCursor: null }));
    const { getCandidateInbox } = await import("./payer-api");
    await getCandidateInbox({ postingId: P1, cursor: "eyJ2IjoxfQ", stage: "passed" });
    const url = new URL(lastCall()[0]);
    expect(url.pathname).toBe("/payer/reach/applicants");
    expect([...url.searchParams.entries()]).toEqual([
      ["postingId", P1],
      ["cursor", "eyJ2IjoxfQ"],
      ["stage", "passed"],
    ]);
    await getCandidateInbox({ postingId: P1 });
    expect(new URL(lastCall()[0]).searchParams.has("stage")).toBe(false);
  });

  it("a stage outside the three never reaches the network", async () => {
    const { getCandidateInbox } = await import("./payer-api");
    await expect(getCandidateInbox({ stage: "archived" as never })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("setApplicantStage — PUT …/applicants/:workerId/stage", () => {
  const answer = (over: Record<string, unknown> = {}) => ({
    postingId: P1,
    postingKind: "company_posting",
    workerId: W2,
    stage: "shortlist",
    previousStage: "new",
    changed: true,
    ...over,
  });

  it("PUTs the body { stage } and NOTHING else (no payer id — XB-A), with the Bearer", async () => {
    fetchMock.mockResolvedValue(jsonResponse(answer()));
    const { setApplicantStage } = await import("./payer-api");
    await setApplicantStage({ jobId: P1, workerId: W2, stage: "shortlist" });
    const [url, init] = lastCall();
    expect(url).toBe(`http://api.test/payer/reach/jobs/${P1}/applicants/${W2}/stage`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ stage: "shortlist" });
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("returns the server's answer — a change and an idempotent no-op alike", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(answer()));
    const { setApplicantStage } = await import("./payer-api");
    await expect(
      setApplicantStage({ jobId: P1, workerId: W2, stage: "shortlist" }),
    ).resolves.toEqual(answer());
    const again = answer({ previousStage: "shortlist", changed: false });
    fetchMock.mockResolvedValueOnce(jsonResponse(again));
    await expect(
      setApplicantStage({ jobId: P1, workerId: W2, stage: "shortlist" }),
    ).resolves.toEqual(again);
  });

  it("the neutral 404 (not owned / not on the feed / flag off — one body) is null", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: "Job not found" } }, 404));
    const { setApplicantStage } = await import("./payer-api");
    await expect(
      setApplicantStage({ jobId: P1, workerId: W2, stage: "passed" }),
    ).resolves.toBeNull();
  });

  it("a 429 (its own hourly bucket, or Redis down) throws, recognisably rate-limited", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 429));
    const { setApplicantStage } = await import("./payer-api");
    const err = await setApplicantStage({ jobId: P1, workerId: W2, stage: "passed" }).catch(
      (e: unknown) => e,
    );
    expect(isPayerRateLimited(err)).toBe(true);
  });

  it("a 5xx or an unreadable answer throws (never a stage made up)", async () => {
    const { setApplicantStage } = await import("./payer-api");
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500));
    await expect(setApplicantStage({ jobId: P1, workerId: W2, stage: "new" })).rejects.toThrow();
    fetchMock.mockResolvedValueOnce(jsonResponse(answer({ stage: "archived" })));
    await expect(setApplicantStage({ jobId: P1, workerId: W2, stage: "new" })).rejects.toThrow();
  });

  it("an answer about ANOTHER row is refused — fail closed, nothing reconciled", async () => {
    const { setApplicantStage } = await import("./payer-api");
    fetchMock.mockResolvedValueOnce(jsonResponse(answer({ workerId: W1 })));
    await expect(
      setApplicantStage({ jobId: P1, workerId: W2, stage: "shortlist" }),
    ).rejects.toThrow(/another row/);
    fetchMock.mockResolvedValueOnce(jsonResponse(answer({ postingId: J1 })));
    await expect(
      setApplicantStage({ jobId: P1, workerId: W2, stage: "shortlist" }),
    ).rejects.toThrow(/another row/);
  });
});
