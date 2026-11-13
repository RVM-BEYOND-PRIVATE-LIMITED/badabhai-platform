import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
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
