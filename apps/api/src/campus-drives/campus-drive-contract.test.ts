import { describe, expect, it } from "vitest";
import {
  CAMPUS_ERROR_CODES,
  CampusDateSchema,
  CampusDriveDecisionBodySchema,
  CampusDriveRequestPageSchema,
  CampusDriveRequestSchema,
  CampusDriveRequestsQuerySchema,
  CampusErrorBodySchema,
} from "../campus-link/campus-link.contract";
import {
  DRIVE_DECISION_BODY_EXAMPLE,
  DRIVE_REQUEST_EXAMPLE,
} from "../campus-link/campus-link.examples";
import { createCampusLinkMock, type MockRequest } from "../campus-link/mock/campus-link-mock";

/**
 * #2746 PR 6 — the Campus contract's drive-request shapes, beyond the example parse every shape
 * gets in `campus-link.contract.test.ts`: requests strict, the decision's per-kind fields, real
 * calendar dates, and the mock answering both routes.
 */

describe("drive-request contract — the decision body", () => {
  const scheduled = DRIVE_DECISION_BODY_EXAMPLE;
  const parse = (body: Record<string, unknown>) =>
    CampusDriveDecisionBodySchema.safeParse(body).success;

  it("scheduled needs its date and Campus's drive id", () => {
    expect(parse({ ...scheduled })).toBe(true);
    const { scheduled_on: _d, ...noDate } = scheduled as Record<string, unknown>;
    const { campus_drive_ref: _r, ...noRef } = scheduled as Record<string, unknown>;
    expect(parse(noDate)).toBe(false);
    expect(parse(noRef)).toBe(false);
  });

  it("declined and completed carry neither", () => {
    const base = {
      decided_by_ref: scheduled.decided_by_ref,
      decided_at: scheduled.decided_at,
    };
    expect(parse({ ...base, decision: "declined", reason: "No slot this month" })).toBe(true);
    expect(parse({ ...base, decision: "completed" })).toBe(true);
    expect(parse({ ...base, decision: "declined", scheduled_on: "2026-12-05" })).toBe(false);
    expect(parse({ ...base, decision: "completed", campus_drive_ref: "d:1" })).toBe(false);
  });

  it("decided_at and decided_by_ref are required; the staff ref is a uuid, never a name", () => {
    const { decided_at: _a, ...noTime } = scheduled as Record<string, unknown>;
    const { decided_by_ref: _b, ...noStaff } = scheduled as Record<string, unknown>;
    expect(parse(noTime)).toBe(false);
    expect(parse(noStaff)).toBe(false);
    expect(parse({ ...scheduled, decided_by_ref: "Asha (placement)" })).toBe(false);
    expect(parse({ ...scheduled, decided_at: "2026-11-20 09:00" })).toBe(false);
  });

  it("is strict, refuses a decision that is not Campus's, and bounds the reason and the ref", () => {
    expect(parse({ ...scheduled, contact_phone: "9812345678" })).toBe(false);
    expect(parse({ ...scheduled, decision: "cancelled" })).toBe(false);
    expect(parse({ ...scheduled, decision: "requested" })).toBe(false);
    expect(parse({ ...scheduled, reason: "x".repeat(501) })).toBe(false);
    expect(parse({ ...scheduled, reason: "   " })).toBe(false);
    expect(parse({ ...scheduled, campus_drive_ref: "drive for asha" })).toBe(false);
    expect(parse({ ...scheduled, campus_drive_ref: "x".repeat(201) })).toBe(false);
  });

  it("campus_drive_ref is ASCII-only: stricter than the shared id rule, so no hidden character passes", () => {
    // Built from code points: ZWSP, ZWJ, RLO, NUL, a non-breaking space, a lone surrogate.
    for (const code of [0x200b, 0x200d, 0x202e, 0x00, 0xa0, 0xd800]) {
      const ref = `campus-drive${String.fromCharCode(code)}417`;
      expect(parse({ ...scheduled, campus_drive_ref: ref }), code.toString(16)).toBe(false);
    }
  });
});

describe("drive-request contract — dates are real calendar days", () => {
  it.each([
    ["2026-12-05", true],
    ["2028-02-29", true],
    ["2026-02-29", false],
    ["2026-02-30", false],
    ["2026-13-01", false],
    ["0000-01-01", false],
    ["2026-12-5", false],
    ["2026-12-05T00:00:00Z", false],
  ])("%s → %s", (value, ok) => {
    expect(CampusDateSchema.safeParse(value).success).toBe(ok);
  });
});

describe("drive-request contract — the feed", () => {
  it("the query is strict and its page size bounded", () => {
    expect(CampusDriveRequestsQuerySchema.safeParse({ branch_id: "1" }).success).toBe(false);
    expect(CampusDriveRequestsQuerySchema.safeParse({ limit: "201" }).success).toBe(false);
    expect(CampusDriveRequestsQuerySchema.safeParse({ status: "open" }).success).toBe(false);
    expect(CampusDriveRequestsQuerySchema.parse({}).limit).toBe(100);
  });

  it("an item may gain fields later (responses are open), and an erased contact is null", () => {
    expect(
      CampusDriveRequestSchema.safeParse({ ...DRIVE_REQUEST_EXAMPLE, added_later: 1 }).success,
    ).toBe(true);
    expect(
      CampusDriveRequestSchema.safeParse({ ...DRIVE_REQUEST_EXAMPLE, contact: null }).success,
    ).toBe(true);
  });

  it("shares the review's DECISION_SUPERSEDED (once) and appends the two drive codes last", () => {
    expect(CAMPUS_ERROR_CODES.filter((c) => c === "DECISION_SUPERSEDED")).toHaveLength(1);
    expect(CAMPUS_ERROR_CODES.slice(-2)).toEqual(["DECISION_NOT_ALLOWED", "COMPANY_WITHDRAWN"]);
    expect(new Set(CAMPUS_ERROR_CODES).size).toBe(CAMPUS_ERROR_CODES.length);
    expect(CAMPUS_ERROR_CODES.slice(0, 11)).toEqual([
      "ADDRESS_NOT_ALLOWED",
      "UNAUTHENTICATED",
      "RATE_LIMITED",
      "VALIDATION_FAILED",
      "IDEMPOTENCY_KEY_REQUIRED",
      "EXTERNAL_REF_CONFLICT",
      "POSTING_NOT_OPEN",
      "POSTING_NOT_APPROVED",
      "AUDIENCE_EXCLUDES_RVM",
      "STUDENT_NOT_AVAILABLE",
      "RVM_UNAVAILABLE",
    ]);
  });
});

describe("drive-request contract — every drive time is within ±14:00 of UTC (PR 5's IsoDateTime)", () => {
  const times: [string, (time: string) => boolean][] = [
    [
      "decision decided_at",
      (t) =>
        CampusDriveDecisionBodySchema.safeParse({ ...DRIVE_DECISION_BODY_EXAMPLE, decided_at: t })
          .success,
    ],
    [
      "feed changed_since",
      (t) => CampusDriveRequestsQuerySchema.safeParse({ changed_since: t }).success,
    ],
  ];

  it.each(times)("%s: accepts Z, IST and the widest real offsets", (_name, ok) => {
    expect(ok("2026-11-14T10:00:00.000Z")).toBe(true);
    expect(ok("2026-11-14T15:30:00.000+05:30")).toBe(true);
    expect(ok("2026-11-15T00:00:00.000+14:00")).toBe(true);
    expect(ok("2026-11-13T20:00:00.000-14:00")).toBe(true);
  });

  it.each(times)("%s: refuses an offset past ±14:00 (Postgres refuses past ±15:59)", (_n, ok) => {
    expect(ok("2026-11-15T00:01:00.000+14:01")).toBe(false);
    expect(ok("2026-11-15T02:00:00.000+16:00")).toBe(false);
    expect(ok("2026-11-13T18:00:00.000-16:00")).toBe(false);
  });
});

describe("drive-request contract — the mock serves both routes", () => {
  const TOKEN = "mock-token-for-tests";
  const handle = createCampusLinkMock({ token: TOKEN });
  const req = (
    method: string,
    path: string,
    body?: unknown,
    key: string | null = "outbox:0001",
  ): MockRequest => ({
    method,
    url: `/internal/campus/v1/${path}`,
    headers: {
      "x-service-token": TOKEN,
      ...(key === null || method === "GET" ? {} : { "idempotency-key": key }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  it("GET drive-requests answers a page that parses, filtered by status", () => {
    const all = handle(req("GET", "drive-requests"));
    expect(all.status).toBe(200);
    expect(CampusDriveRequestPageSchema.parse(all.body).drive_requests[0]?.id).toBe(
      DRIVE_REQUEST_EXAMPLE.id,
    );
    const none = handle(req("GET", "drive-requests?status=declined"));
    expect(CampusDriveRequestPageSchema.parse(none.body).drive_requests).toEqual([]);
  });

  it("POST decision needs the key, answers the example request, and 404s any other", () => {
    const path = `drive-requests/${DRIVE_REQUEST_EXAMPLE.id}/decision`;
    const noKey = handle(req("POST", path, DRIVE_DECISION_BODY_EXAMPLE, null));
    expect(noKey.status).toBe(400);
    expect(CampusErrorBodySchema.parse(noKey.body).error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const ok = handle(req("POST", path, DRIVE_DECISION_BODY_EXAMPLE));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: "scheduled", scheduled_on: "2026-12-05" });
    const other = handle(
      req(
        "POST",
        "drive-requests/00000000-0000-4000-8000-000000000000/decision",
        DRIVE_DECISION_BODY_EXAMPLE,
      ),
    );
    expect(other.status).toBe(404);
  });
});
