import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AssertModule from "./assert-no-agency-pii";

/**
 * Agency LIVE-seam transport tests (ADR-0022). Exercises the REAL `payerFetch` (mocked
 * fetch + payer JWT cookie) to pin the no-oracle + neutral-failure CONTRACTS that the
 * action-layer tests mock away:
 *  - a 404 (unknown OR not-owned) → `null` (the `/returned 404/` branch matches the real
 *    `payer API <path> returned <status>` message format),
 *  - a 429 (mint cap OR Redis fail-closed) → `{ ok: false }` (no fake success, no reason),
 *  - the create body is snake_case + Bearer-only (NO client payer_id — XB-A).
 * If payer-http's error-message format ever changes, these fail loudly (the silent risk
 * the code review flagged).
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

// The data-layer FACELESS guard, spied but REAL: every agency payload the seam returns passes
// through it (its own suite pins what it rejects).
const assertSpy = vi.hoisted(() => ({ fn: null as unknown as ReturnType<typeof vi.fn> }));
vi.mock("./assert-no-agency-pii", async (importOriginal) => {
  const actual = await importOriginal<typeof AssertModule>();
  assertSpy.fn = vi.fn(actual.assertNoAgencyPII);
  return {
    ...actual,
    assertNoAgencyPII: (...a: Parameters<typeof actual.assertNoAgencyPII>) => assertSpy.fn(...a),
  };
});

const fetchMock = vi.fn();

const JOB = {
  id: "00000001-0000-4000-8000-000000000001",
  status: "open",
  tradeKey: "cnc_operator",
  title: "CNC Operator",
  city: "Pune",
  area: null,
  payMin: null,
  payMax: null,
  minExperienceYears: null,
  maxExperienceYears: null,
  neededBy: null,
  applicantsReceived: 0,
  createdAt: "2026-06-22T00:00:00.000Z",
  updatedAt: "2026-06-22T00:00:00.000Z",
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
  assertSpy.fn?.mockClear();
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

describe("agency jobs seam — no-oracle 404 → null", () => {
  it("getAgencyJob maps a neutral 404 (unknown OR not-owned) to null", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "Job not found" }, 404));
    const { getAgencyJob } = await import("./payer-api");
    await expect(getAgencyJob(JOB.id)).resolves.toBeNull();
  });

  it("pauseAgencyJob / closeAgencyJob / updateAgencyJob all map a 404 to null", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "Job not found" }, 404));
    const { pauseAgencyJob, closeAgencyJob, updateAgencyJob } = await import("./payer-api");
    await expect(pauseAgencyJob(JOB.id)).resolves.toBeNull();
    await expect(closeAgencyJob(JOB.id)).resolves.toBeNull();
    await expect(
      updateAgencyJob(JOB.id, {
        tradeKey: "cnc_operator",
        roleKind: "cnc_turner",
        title: "X",
        city: "Pune",
      }),
    ).resolves.toBeNull();
  });

  it("getAgencyJob returns the parsed faceless job on 200", async () => {
    fetchMock.mockResolvedValue(jsonResponse(JOB));
    const { getAgencyJob } = await import("./payer-api");
    await expect(getAgencyJob(JOB.id)).resolves.toEqual(JOB);
  });
});

describe("agency jobs seam — FACELESS: a regressed payload never hands worker PII to a page", () => {
  const LEAKY = { ...JOB, name: "Ramesh Kumar", phone: "+919812345678" };
  const leaked = (v: unknown) => /Ramesh Kumar|\+919812345678/.test(JSON.stringify(v) ?? "");

  it("listAgencyJobs: a row carrying a name / phone comes back without them", async () => {
    fetchMock.mockResolvedValue(jsonResponse([LEAKY]));
    const { listAgencyJobs } = await import("./payer-api");
    const rows = await listAgencyJobs();
    expect(rows).toHaveLength(1);
    expect(leaked(rows)).toBe(false);
    expect(rows[0]).not.toHaveProperty("name");
    expect(rows[0]).not.toHaveProperty("phone");
  });

  it("getAgencyJob: the same, for one row", async () => {
    fetchMock.mockResolvedValue(jsonResponse(LEAKY));
    const { getAgencyJob } = await import("./payer-api");
    const row = await getAgencyJob(JOB.id);
    expect(row).not.toBeNull();
    expect(leaked(row)).toBe(false);
    expect(row).not.toHaveProperty("name");
  });

  it("the data-layer guard runs on every agency jobs payload, labelled by its route", async () => {
    const { listAgencyJobs, getAgencyJob } = await import("./payer-api");
    fetchMock.mockResolvedValue(jsonResponse([JOB]));
    await listAgencyJobs();
    expect(assertSpy.fn).toHaveBeenCalledWith([JOB], "payer/agency/jobs");
    fetchMock.mockResolvedValue(jsonResponse(JOB));
    await getAgencyJob(JOB.id);
    expect(assertSpy.fn).toHaveBeenLastCalledWith(JOB, "payer/agency/jobs/:id");
  });

  it("a guard verdict is never swallowed: the read fails (the page shows its retry state), the value never surfaces", async () => {
    fetchMock.mockResolvedValue(jsonResponse([JOB]));
    const { assertNoAgencyPII } = await vi.importActual<typeof AssertModule>(
      "./assert-no-agency-pii",
    );
    // As if a future wire field let a forbidden key through the schema.
    assertSpy.fn.mockImplementationOnce(() => assertNoAgencyPII([LEAKY], "payer/agency/jobs"));
    const { listAgencyJobs } = await import("./payer-api");
    const err = await listAgencyJobs().then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("forbidden PII key(s)");
    expect(err!.message).toContain("[0].name");
    expect(leaked(err!.message)).toBe(false);
  });
});

describe("agency jobs seam — create body is snake_case + Bearer-only (XB-A)", () => {
  it("maps camelCase input to a snake_case body with NO payer_id and a Bearer header", async () => {
    fetchMock.mockResolvedValue(jsonResponse(JOB, 201));
    const { createAgencyJob } = await import("./payer-api");
    await createAgencyJob({
      tradeKey: "cnc_operator",
      roleKind: "cnc_turner",
      title: "CNC Operator",
      city: "Pune",
      payMin: 20000,
      payMax: 35000,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/payer/agency/jobs");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      trade_key: "cnc_operator",
      title: "CNC Operator",
      city: "Pune",
      pay_min: 20000,
      pay_max: 35000,
    });
    // XB-A: there is nowhere for a client payer_id to ride.
    expect(body).not.toHaveProperty("payer_id");
    expect(body).not.toHaveProperty("payerId");
  });
});

describe("agency invite seam — 429 (cap OR fail-closed) → neutral { ok:false }", () => {
  it("maps a 429 to { ok:false } (no fake success, no leaked reason)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "rate limited" }, 429));
    const { createAgencyInvite } = await import("./payer-api");
    await expect(createAgencyInvite({ campaign: "diwali-drive" })).resolves.toEqual({ ok: false });
  });

  it("returns the opaque code/link on success", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ agency_invite_id: JOB.id, code: "abc123def456", link: "/i/abc123def456" }, 201),
    );
    const { createAgencyInvite } = await import("./payer-api");
    await expect(createAgencyInvite({})).resolves.toEqual({
      ok: true,
      code: "abc123def456",
      link: "/i/abc123def456",
    });
  });
});
