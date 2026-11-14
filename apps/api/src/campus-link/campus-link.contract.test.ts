import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  CAMPUS_ERROR_CODES,
  CampusApplicationPageSchema,
  CampusApplicationSchema,
  CampusApplyBodySchema,
  CampusCompanyResponseSchema,
  CampusIdempotencyKeySchema,
  CampusPostForCompanyBodySchema,
  CampusPostForCompanyResponseSchema,
  CampusPostingPageSchema,
  CampusPostingSchema,
  CampusPostingsQuerySchema,
  CampusReviewBodySchema,
  CampusReviewResponseSchema,
  CampusSearchGrantBodySchema,
  CampusSearchGrantSchema,
  CampusTargetingOptionsBodySchema,
  CampusTargetingOptionsResponseSchema,
  CampusUnlinkResponseSchema,
  Phone10Schema,
  StudentRefSchema,
} from "./campus-link.contract";
import * as examples from "./campus-link.examples";

const PAIRS: ReadonlyArray<[string, z.ZodType, unknown]> = [
  ["posting", CampusPostingSchema, examples.POSTING_EXAMPLE],
  ["posting page", CampusPostingPageSchema, examples.POSTING_PAGE_EXAMPLE],
  ["review body", CampusReviewBodySchema, examples.REVIEW_BODY_EXAMPLE],
  ["review response", CampusReviewResponseSchema, examples.REVIEW_RESPONSE_EXAMPLE],
  [
    "targeting-options body",
    CampusTargetingOptionsBodySchema,
    examples.TARGETING_OPTIONS_BODY_EXAMPLE,
  ],
  [
    "targeting-options response",
    CampusTargetingOptionsResponseSchema,
    examples.TARGETING_OPTIONS_RESPONSE_EXAMPLE,
  ],
  ["post-for-company body", CampusPostForCompanyBodySchema, examples.POST_FOR_COMPANY_BODY_EXAMPLE],
  [
    "post-for-company response",
    CampusPostForCompanyResponseSchema,
    examples.POST_FOR_COMPANY_RESPONSE_EXAMPLE,
  ],
  ["company response", CampusCompanyResponseSchema, examples.COMPANY_RESPONSE_EXAMPLE],
  ["apply body", CampusApplyBodySchema, examples.APPLY_BODY_EXAMPLE],
  ["application", CampusApplicationSchema, examples.APPLICATION_EXAMPLE],
  ["application page", CampusApplicationPageSchema, examples.APPLICATION_PAGE_EXAMPLE],
  ["search-grant body", CampusSearchGrantBodySchema, examples.SEARCH_GRANT_BODY_EXAMPLE],
  ["search grant", CampusSearchGrantSchema, examples.SEARCH_GRANT_EXAMPLE],
  ["unlink response", CampusUnlinkResponseSchema, examples.UNLINK_RESPONSE_EXAMPLE],
];

describe("Campus contract v1 — every published example parses against its schema", () => {
  it.each(PAIRS)("%s", (_name, schema, example) => {
    const parsed = schema.safeParse(example);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("covers every example the module exports", () => {
    const covered = new Set(PAIRS.map(([, , example]) => example));
    for (const [name, example] of Object.entries(examples)) {
      expect(covered.has(example), `${name} has no schema check`).toBe(true);
    }
  });
});

describe("Campus contract v1 — requests are strict", () => {
  it("refuses an unknown key in a request body", () => {
    expect(
      CampusApplyBodySchema.safeParse({ ...examples.APPLY_BODY_EXAMPLE, phone: "9000000001" })
        .success,
    ).toBe(false);
  });

  it("refuses an apply body that carries student facts instead of reading them from RVM", () => {
    expect(
      CampusApplyBodySchema.safeParse({ ...examples.APPLY_BODY_EXAMPLE, course: "CNC" }).success,
    ).toBe(false);
  });

  it("refuses a pay range whose max is below its min", () => {
    expect(
      CampusPostForCompanyBodySchema.safeParse({
        ...examples.POST_FOR_COMPANY_BODY_EXAMPLE,
        pay: { min: 20000, max: 10000, type: "in_hand" },
      }).success,
    ).toBe(false);
  });

  it("refuses an unknown query parameter and caps the page size", () => {
    expect(CampusPostingsQuerySchema.safeParse({ branch: "1" }).success).toBe(false);
    expect(CampusPostingsQuerySchema.safeParse({ limit: "201" }).success).toBe(false);
    expect(CampusPostingsQuerySchema.parse({}).limit).toBe(100);
    expect(CampusPostingsQuerySchema.parse({ branch_id: "2" }).branch_id).toBe(2);
  });
});

describe("Campus contract v1 — responses are open", () => {
  it("accepts a response with a field added in a later release", () => {
    expect(
      CampusApplicationSchema.safeParse({ ...examples.APPLICATION_EXAMPLE, added_later: true })
        .success,
    ).toBe(true);
  });
});

describe("Campus contract v1 — primitives", () => {
  it("Idempotency-Key: 8 to 200 characters of A-Z a-z 0-9 . _ : -", () => {
    expect(CampusIdempotencyKeySchema.safeParse("outbox:1234").success).toBe(true);
    expect(CampusIdempotencyKeySchema.safeParse("short").success).toBe(false);
    expect(CampusIdempotencyKeySchema.safeParse("a".repeat(201)).success).toBe(false);
    expect(CampusIdempotencyKeySchema.safeParse("has space 123").success).toBe(false);
  });

  it("phone: ten digits starting 6 to 9, never with a country code", () => {
    expect(Phone10Schema.safeParse("9876543210").success).toBe(true);
    expect(Phone10Schema.safeParse("5876543210").success).toBe(false);
    expect(Phone10Schema.safeParse("+919876543210").success).toBe(false);
  });

  it("student ref: a uuid of at most 128 characters", () => {
    expect(StudentRefSchema.safeParse("3c9e7b21-4f6a-4d8e-b1c2-a3d4e5f60718").success).toBe(true);
    expect(StudentRefSchema.safeParse("student-42").success).toBe(false);
  });
});

// Hidden characters, built from code points so no editor can turn them into anything else.
const RLO = String.fromCharCode(0x202e); // right-to-left override (Cf)
const ZWSP = String.fromCharCode(0x200b); // zero-width space (Cf)
const NEWLINE = String.fromCharCode(0x0a); // a control character (Cc)

describe("Campus contract v1 — the review carries the content it decided on (#2746)", () => {
  const body = examples.REVIEW_BODY_EXAMPLE;

  it("requires content_hash: 64 lower-case hex characters, from the posting feed", () => {
    const { content_hash: _omitted, ...withoutHash } = body;
    expect(CampusReviewBodySchema.safeParse(withoutHash).success).toBe(false);
    expect(CampusReviewBodySchema.safeParse({ ...body, content_hash: "ABC" }).success).toBe(false);
    expect(
      CampusReviewBodySchema.safeParse({ ...body, content_hash: body.content_hash.toUpperCase() })
        .success,
    ).toBe(false);
    expect(CampusReviewBodySchema.safeParse(body).success).toBe(true);
  });

  it("the feed exposes the same hash shape, so a posting read can be echoed as is", () => {
    const posting = examples.POSTING_EXAMPLE;
    expect(posting.content_hash).toBe(body.content_hash);
    const { content_hash: _omitted, ...withoutHash } = posting;
    expect(CampusPostingSchema.safeParse(withoutHash).success).toBe(false);
  });

  it("refuses an empty narrowing: an empty list would widen to every branch", () => {
    expect(CampusReviewBodySchema.safeParse({ ...body, branch_ids: [] }).success).toBe(false);
    expect(CampusReviewBodySchema.safeParse({ ...body, course_ids: [] }).success).toBe(false);
  });

  it("names POSTING_CHANGED among the error codes, after every code that existed before", () => {
    expect(CAMPUS_ERROR_CODES).toContain("POSTING_CHANGED");
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

describe("Campus contract v1 — PUT targeting-options (#2746)", () => {
  const list = examples.TARGETING_OPTIONS_BODY_EXAMPLE;
  const parse = (over: Record<string, unknown>) =>
    CampusTargetingOptionsBodySchema.safeParse({ ...list, ...over }).success;

  it("needs both lists, and an empty list is a valid answer (it retires every option of the kind)", () => {
    expect(CampusTargetingOptionsBodySchema.safeParse({ branches: list.branches }).success).toBe(
      false,
    );
    expect(parse({ courses: [] })).toBe(true);
  });

  it("refuses an id listed twice", () => {
    expect(parse({ branches: [...list.branches, { id: 1, name: "Faridabad again" }] })).toBe(false);
    expect(parse({ courses: [...list.courses, { id: "cad-design", name: "CAD" }] })).toBe(false);
  });

  it("keeps a branch id within the ten digits rvm_targeting_options stores (rto_branch_ref_chk)", () => {
    expect(parse({ branches: [{ id: 9_999_999_999, name: "Edge" }] })).toBe(true);
    expect(parse({ branches: [{ id: 10_000_000_000, name: "Too long" }] })).toBe(false);
    expect(parse({ branches: [{ id: 0, name: "Zero" }] })).toBe(false);
    expect(parse({ branches: [{ id: "1", name: "Text id" }] })).toBe(false);
  });

  it("refuses a label or a course id that hides a control or format character", () => {
    expect(parse({ branches: [{ id: 1, name: `Fari${RLO}dabad` }] })).toBe(false);
    expect(parse({ courses: [{ id: `cnc${ZWSP}`, name: "CNC" }] })).toBe(false);
    expect(parse({ courses: [{ id: `cnc${NEWLINE}x`, name: "CNC" }] })).toBe(false);
  });

  it("bounds labels to rto_label_chk (1 to 200 after trimming) and course ids to 64", () => {
    expect(parse({ branches: [{ id: 1, name: "   " }] })).toBe(false);
    expect(parse({ branches: [{ id: 1, name: "x".repeat(201) }] })).toBe(false);
    expect(parse({ courses: [{ id: "c".repeat(65), name: "Long" }] })).toBe(false);
    const trimmed = CampusTargetingOptionsBodySchema.parse({
      branches: [{ id: 1, name: "  Faridabad  " }],
      courses: [],
    });
    expect(trimmed.branches[0]!.name).toBe("Faridabad");
  });

  it("refuses an unknown key, at the top or on an option", () => {
    expect(parse({ batches: [] })).toBe(false);
    expect(parse({ branches: [{ id: 1, name: "Faridabad", sort: 1 }] })).toBe(false);
  });
});
