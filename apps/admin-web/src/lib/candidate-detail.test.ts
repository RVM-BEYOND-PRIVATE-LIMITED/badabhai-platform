import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { candidateRecord, RECORD_WORKER_ID } from "../../test/candidate-record";

/**
 * A7 (#2577) — the portal's read of `GET /admin/candidates/:id` (#2560): the request it makes,
 * the one caching rule a name-bearing read must keep, every failure folded into a status the
 * drawer can render, and the schema held to the API's own contract.
 */
const http = vi.hoisted(() => {
  class AdminUnauthorizedError extends Error {}
  class AdminForbiddenError extends Error {}
  class AdminRequestError extends Error {
    constructor(
      readonly status: number,
      message = "x",
    ) {
      super(message);
    }
  }
  return {
    AdminUnauthorizedError,
    AdminForbiddenError,
    AdminRequestError,
    adminFetch: vi.fn(),
  };
});
vi.mock("./admin-http", () => ({
  adminFetch: http.adminFetch,
  isAdminUnauthorized: (e: unknown) => e instanceof http.AdminUnauthorizedError,
  isAdminForbidden: (e: unknown) => e instanceof http.AdminForbiddenError,
  isAdminRequestError: (e: unknown) => e instanceof http.AdminRequestError,
}));

const { candidateDetailSchema, readCandidateRecord } = await import("./candidate-detail");

beforeEach(() => {
  http.adminFetch.mockReset();
});

describe("readCandidateRecord — the request", () => {
  it("reads /admin/candidates/:id through the record schema", async () => {
    http.adminFetch.mockResolvedValue(candidateRecord());
    await readCandidateRecord(RECORD_WORKER_ID);
    expect(http.adminFetch).toHaveBeenCalledWith(
      `/admin/candidates/${RECORD_WORKER_ID}`,
      expect.objectContaining({ schema: candidateDetailSchema }),
    );
  });

  /**
   * The id comes from the address. `encodeURIComponent` leaves "." and ".." alone and fetch's URL
   * parser resolves them, so `?c=.` asked for `/admin/candidates/` (the list once #2559 serves it:
   * name budget spent, audit rows written for a view nobody asked for) and `?c=..` for `/admin/`.
   * Not a uuid: nothing is sent.
   */
  it.each([".", "..", "Ramesh Kumar", "", "%2e%2e", `${RECORD_WORKER_ID}/..`, `${RECORD_WORKER_ID} `])(
    "%j is no such candidate, and nothing is asked of the API",
    async (id) => {
      expect(await readCandidateRecord(id)).toEqual({ status: "not_found" });
      expect(http.adminFetch).not.toHaveBeenCalled();
    },
  );

  it("is NEVER cached: no `revalidate`, so adminFetch stays on no-store (the body may carry a name)", async () => {
    http.adminFetch.mockResolvedValue(candidateRecord());
    await readCandidateRecord(RECORD_WORKER_ID);
    const opts = http.adminFetch.mock.calls[0]![1] as Record<string, unknown>;
    expect(opts).not.toHaveProperty("revalidate");
    expect(opts.method ?? "GET").toBe("GET");
  });

  it("returns the record as ok", async () => {
    const detail = candidateRecord();
    http.adminFetch.mockResolvedValue(detail);
    expect(await readCandidateRecord(RECORD_WORKER_ID)).toEqual({ status: "ok", detail });
  });

  it("hands the caller's signal to adminFetch, so a drawer that moved on cancels the API call", async () => {
    http.adminFetch.mockResolvedValue(candidateRecord());
    const signal = new AbortController().signal;
    await readCandidateRecord(RECORD_WORKER_ID, signal);
    expect((http.adminFetch.mock.calls[0]![1] as { signal?: unknown }).signal).toBe(signal);
  });
});

describe("readCandidateRecord — every failure is a status, never a throw", () => {
  it.each([
    ["no such worker (404)", new http.AdminRequestError(404), "not_found"],
    ["an id that is not a uuid (400)", new http.AdminRequestError(400), "not_found"],
    ["a role without read_candidates (403)", new http.AdminForbiddenError(), "forbidden"],
    ["a session that ended (401)", new http.AdminUnauthorizedError(), "signed_out"],
    ["a fault on our side (5xx)", new http.AdminRequestError(503), "error"],
    ["an unreachable API", new http.AdminRequestError(0), "error"],
    ["an unexpected shape", new http.AdminRequestError(200, "unexpected shape"), "error"],
    ["anything else", new TypeError("boom"), "error"],
  ])("%s → %s", async (_what, err, status) => {
    http.adminFetch.mockRejectedValue(err);
    expect(await readCandidateRecord(RECORD_WORKER_ID)).toEqual({ status });
  });
});

describe("the record schema", () => {
  it("parses a full record, unchanged", () => {
    const detail = candidateRecord();
    expect(candidateDetailSchema.parse(detail)).toEqual(detail);
  });

  it("reads `source` as a string — a source the server adds later degrades, never fails the record", () => {
    const detail = candidateRecord();
    detail.location.current_city = { value: "Pune", source: "admin_override", correction: null };
    expect(candidateDetailSchema.parse(detail).location.current_city.source).toBe("admin_override");
  });

  it("reads an absent `correction` as null (the layer #2561 fills), and keeps a present one", () => {
    const raw = structuredClone(candidateRecord()) as unknown as {
      languages: Record<string, unknown>;
      location: { current_city: Record<string, unknown> };
    };
    delete raw.languages.correction;
    raw.location.current_city.correction = {
      override_id: "o-1",
      admin_id: "a-1",
      reason_code: "worker_request",
      created_at: "2026-11-04T10:00:00.000Z",
    };
    const parsed = candidateDetailSchema.parse(raw);
    expect(parsed.languages.correction).toBeNull();
    expect(parsed.location.current_city.correction?.reason_code).toBe("worker_request");
  });

  it("refuses a record that lost a group — an honest error state, not a blank tab", () => {
    const { skills: _skills, ...rest } = candidateRecord();
    expect(candidateDetailSchema.safeParse(rest).success).toBe(false);
  });

  it("drops a key the contract does not name instead of carrying it to the browser", () => {
    const parsed = candidateDetailSchema.parse({ ...candidateRecord(), phone: "+910000000000" });
    expect(parsed).not.toHaveProperty("phone");
  });
});

/**
 * The CONTRACT, read from the API's own DTO (`AdminCandidateDetailSchema` is in this repo): every
 * group and every key of it is one this schema reads. A field added to #2560 without the drawer
 * learning it fails here, rather than silently never being shown.
 */
describe("the schema is the API's contract, key for key", () => {
  const DTO = readFileSync(
    new URL("../../../api/src/admin/admin-candidate-detail.dto.ts", import.meta.url),
    "utf8",
  );

  /** The keys of `const <name> = z.object({ … })` (or `field(z.array(…))` / the root schema), by indent. */
  function dtoKeys(constName: string): string[] {
    const at = DTO.indexOf(`const ${constName} = z`);
    expect(at, constName).toBeGreaterThanOrEqual(0);
    const body = DTO.slice(at, DTO.indexOf("\n  .strict();", at));
    return [...body.matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]!);
  }
  const shape = (s: unknown) =>
    Object.keys((s as { shape: Record<string, unknown> }).shape).sort();
  const groups = candidateDetailSchema.shape;

  it("the root: every group", () => {
    expect(shape(candidateDetailSchema)).toEqual(dtoKeys("AdminCandidateDetailSchema").sort());
  });

  it.each([
    ["identity", "identitySchema"],
    ["location", "locationSchema"],
    ["trade", "tradeSchema"],
    ["employer_card", "employerCardSchema"],
    ["skills", "skillsSchema"],
    ["experience", "experienceSchema"],
    ["education", "educationSchema"],
    ["salary", "salarySchema"],
    ["preferences", "preferencesSchema"],
    ["resume", "resumeSchema"],
    ["account", "accountSchema"],
    ["activity", "activitySchema"],
    ["editable", "editableSchema"],
  ] as const)("%s carries exactly the keys of %s", (group, constName) => {
    expect(shape(groups[group])).toEqual(dtoKeys(constName).sort());
  });
});
