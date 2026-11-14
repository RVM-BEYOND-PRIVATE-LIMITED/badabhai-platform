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

  it("names the two new conflict codes after every code that existed before", () => {
    expect(CAMPUS_ERROR_CODES).toContain("DECISION_SUPERSEDED");
    expect(CAMPUS_ERROR_CODES).toContain("DECISION_NOT_ALLOWED");
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
