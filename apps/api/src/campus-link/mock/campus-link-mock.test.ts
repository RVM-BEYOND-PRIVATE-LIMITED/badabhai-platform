import { describe, expect, it } from "vitest";
import {
  CampusApplicationPageSchema,
  CampusApplicationSchema,
  CampusErrorBodySchema,
  CampusPostingPageSchema,
  CampusReviewResponseSchema,
  CampusTargetingOptionsResponseSchema,
} from "../campus-link.contract";
import {
  APPLY_BODY_EXAMPLE,
  POSTING_EXAMPLE,
  REVIEW_BODY_EXAMPLE,
  TARGETING_OPTIONS_BODY_EXAMPLE,
} from "../campus-link.examples";
import { createCampusLinkMock, type MockRequest } from "./campus-link-mock";

const TOKEN = "mock-token-for-tests";
const BASE = "/internal/campus/v1";

function request(
  method: string,
  path: string,
  init: { body?: unknown; key?: string | null; token?: string | null } = {},
): MockRequest {
  const headers: Record<string, string | undefined> = {};
  if (init.token !== null) headers["x-service-token"] = init.token ?? TOKEN;
  if (init.key !== null && method !== "GET") headers["idempotency-key"] = init.key ?? "outbox:0001";
  return {
    method,
    url: `${BASE}/${path}`,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  };
}

describe("Campus contract mock", () => {
  it("answers 401 UNAUTHENTICATED in the contract's envelope without the token", () => {
    const res = createCampusLinkMock({ token: TOKEN })(request("GET", "ping", { token: null }));
    expect(res.status).toBe(401);
    expect(CampusErrorBodySchema.parse(res.body).error.code).toBe("UNAUTHENTICATED");
  });

  it("requires an Idempotency-Key on writes", () => {
    const handle = createCampusLinkMock({ token: TOKEN });
    const res = handle(request("POST", "applications", { body: APPLY_BODY_EXAMPLE, key: null }));
    expect(res.status).toBe(400);
    expect(CampusErrorBodySchema.parse(res.body).error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("serves the example posting as a page that parses against the contract", () => {
    const res = createCampusLinkMock({ token: TOKEN })(request("GET", "job-postings?limit=10"));
    expect(res.status).toBe(200);
    expect(CampusPostingPageSchema.parse(res.body).postings[0]?.id).toBe(POSTING_EXAMPLE.id);
  });

  it("filters out the posting for a branch it does not target", () => {
    const res = createCampusLinkMock({ token: TOKEN })(request("GET", "job-postings?branch_id=4"));
    expect(CampusPostingPageSchema.parse(res.body).postings).toEqual([]);
  });

  it("applies once per external_ref: a replay answers the same row, a clash is a 409", () => {
    const handle = createCampusLinkMock({ token: TOKEN });

    const first = handle(request("POST", "applications", { body: APPLY_BODY_EXAMPLE }));
    const replay = handle(request("POST", "applications", { body: APPLY_BODY_EXAMPLE }));
    const clash = handle(
      request("POST", "applications", {
        body: { ...APPLY_BODY_EXAMPLE, student_ref: "0f0e0d0c-0b0a-4908-8706-050403020100" },
      }),
    );

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(CampusApplicationSchema.parse(replay.body).application_id).toBe(
      CampusApplicationSchema.parse(first.body).application_id,
    );
    expect(clash.status).toBe(409);
    expect(CampusErrorBodySchema.parse(clash.body).error.code).toBe("EXTERNAL_REF_CONFLICT");
  });

  it("withdraws an application and shows it in the status feed", () => {
    const handle = createCampusLinkMock({ token: TOKEN });
    handle(request("POST", "applications", { body: APPLY_BODY_EXAMPLE }));

    const withdrawn = handle(request("DELETE", `applications/${APPLY_BODY_EXAMPLE.external_ref}`));
    const feed = handle(request("GET", "applications"));

    expect(CampusApplicationSchema.parse(withdrawn.body).stage).toBe("withdrawn");
    expect(CampusApplicationPageSchema.parse(feed.body).applications.map((a) => a.stage)).toEqual([
      "withdrawn",
    ]);
  });

  it("refuses a body with an unknown key, naming the field", () => {
    const res = createCampusLinkMock({ token: TOKEN })(
      request("POST", "applications", { body: { ...APPLY_BODY_EXAMPLE, phone: "9876543210" } }),
    );
    expect(res.status).toBe(400);
    expect(CampusErrorBodySchema.parse(res.body).error.code).toBe("VALIDATION_FAILED");
  });

  it("answers 404 rather than crashing on a malformed escape in the path", () => {
    const res = createCampusLinkMock({ token: TOKEN })(request("DELETE", "applications/%zz"));
    expect(res.status).toBe(404);
  });

  it("answers a neutral 404 for a path outside the contract", () => {
    const res = createCampusLinkMock({ token: TOKEN })(request("GET", "students"));
    expect(res.status).toBe(404);
    expect(CampusErrorBodySchema.parse(res.body).error.code).toBeUndefined();
  });

  it("records a review that echoes the feed's content_hash, and 409s a stale one (#2746)", () => {
    const handle = createCampusLinkMock({ token: TOKEN });
    const path = `job-postings/${POSTING_EXAMPLE.id}/review`;

    const fresh = handle(request("PUT", path, { body: REVIEW_BODY_EXAMPLE }));
    const stale = handle(
      request("PUT", path, { body: { ...REVIEW_BODY_EXAMPLE, content_hash: "0".repeat(64) } }),
    );
    const noHash = handle(
      request("PUT", path, {
        body: { state: "approved", reviewer_ref: REVIEW_BODY_EXAMPLE.reviewer_ref },
      }),
    );

    expect(fresh.status).toBe(200);
    expect(CampusReviewResponseSchema.parse(fresh.body).review_state).toBe("approved");
    expect(stale.status).toBe(409);
    expect(CampusErrorBodySchema.parse(stale.body).error.code).toBe("POSTING_CHANGED");
    expect(noHash.status).toBe(400);
    expect(CampusErrorBodySchema.parse(noHash.body).error.code).toBe("VALIDATION_FAILED");
  });

  it("takes a targeting-options list and answers counts that parse against the contract (#2746)", () => {
    const handle = createCampusLinkMock({ token: TOKEN });

    const res = handle(
      request("PUT", "targeting-options", { body: TARGETING_OPTIONS_BODY_EXAMPLE }),
    );
    const noKey = handle(
      request("PUT", "targeting-options", { body: TARGETING_OPTIONS_BODY_EXAMPLE, key: null }),
    );

    expect(res.status).toBe(200);
    expect(CampusTargetingOptionsResponseSchema.parse(res.body).branches.listed).toBe(
      TARGETING_OPTIONS_BODY_EXAMPLE.branches.length,
    );
    expect(noKey.status).toBe(400);
    expect(CampusErrorBodySchema.parse(noKey.body).error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });
});
