import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  CAMPUS_ERROR_CODES,
  CAMPUS_TARGETING_LIMITS,
  CourseIdSchema,
  CampusApplicationPageSchema,
  CampusApplicationSchema,
  CampusApplicationsQuerySchema,
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
import { largestTargetingBody } from "./campus-targeting.test-support";

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

  it("needs both lists, each NON-EMPTY (an applied list must stamp a row: the as_of mark)", () => {
    expect(CampusTargetingOptionsBodySchema.safeParse({ branches: list.branches }).success).toBe(
      false,
    );
    expect(parse({ courses: [] })).toBe(false);
    expect(parse({ branches: [] })).toBe(false);
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

  it("bounds labels to 1 to 150 characters after trimming (rto_label_chk allows 200) and course ids to 64", () => {
    expect(parse({ branches: [{ id: 1, name: "   " }] })).toBe(false);
    expect(parse({ branches: [{ id: 1, name: "x".repeat(150) }] })).toBe(true);
    expect(parse({ branches: [{ id: 1, name: "x".repeat(151) }] })).toBe(false);
    expect(parse({ courses: [{ id: "c".repeat(65), name: "Long" }] })).toBe(false);
    const trimmed = CampusTargetingOptionsBodySchema.parse({
      as_of: list.as_of,
      branches: [{ id: 1, name: "  Faridabad  " }],
      courses: [{ id: "cnc", name: "CNC" }],
    });
    expect(trimmed.branches[0]!.name).toBe("Faridabad");
  });

  it("refuses an unknown key, at the top or on an option", () => {
    expect(parse({ batches: [] })).toBe(false);
    expect(parse({ branches: [{ id: 1, name: "Faridabad", sort: 1 }] })).toBe(false);
  });
});

/** Code points no editor may turn into something else. */
const cp = (codePoint: number) => String.fromCharCode(codePoint);
const NUL = cp(0x00);
const LINE_SEP = cp(0x2028);
const PARA_SEP = cp(0x2029);
const PRIVATE_USE = cp(0xe000);
const UNASSIGNED = cp(0x0378);
const HIGH_SURROGATE = cp(0xd800);
const LOW_SURROGATE = cp(0xdc00);
const NBSP = cp(0x00a0);
const KA = cp(0x0915); // Devanagari letter KA: 3 bytes in UTF-8
const ZWNJ = cp(0x200c); // zero-width non-joiner (Cf, allowed in text)
const ZWJ = cp(0x200d); // zero-width joiner (Cf, allowed in text)
const ZWSP_L = cp(0x200b); // zero-width space (Cf, refused)
const LRI = cp(0x2066); // left-to-right isolate (Cf, refused)

describe("Campus contract v1 — every decision carries its time (#2746, owner 14 Nov 2026)", () => {
  it("requires decided_at on the review, an ISO time with an offset", () => {
    const { decided_at: _omitted, ...withoutTime } = examples.REVIEW_BODY_EXAMPLE;
    expect(CampusReviewBodySchema.safeParse(withoutTime).success).toBe(false);
    expect(
      CampusReviewBodySchema.safeParse({ ...examples.REVIEW_BODY_EXAMPLE, decided_at: "yesterday" })
        .success,
    ).toBe(false);
    expect(
      CampusReviewBodySchema.safeParse({
        ...examples.REVIEW_BODY_EXAMPLE,
        decided_at: "2026-11-14T10:00:00",
      }).success,
    ).toBe(false);
  });

  it("requires as_of on the targeting list", () => {
    const { as_of: _omitted, ...withoutTime } = examples.TARGETING_OPTIONS_BODY_EXAMPLE;
    expect(CampusTargetingOptionsBodySchema.safeParse(withoutTime).success).toBe(false);
  });

  it("names DECISION_SUPERSEDED after every code that existed before", () => {
    // Right after POSTING_CHANGED; only #2752 Part E's codes, merged after PR 5, follow it.
    const at = CAMPUS_ERROR_CODES.indexOf("DECISION_SUPERSEDED");
    expect(at).toBe(CAMPUS_ERROR_CODES.indexOf("POSTING_CHANGED") + 1);
    expect(CAMPUS_ERROR_CODES.slice(at + 1)).toEqual([
      "COMPANY_NOT_CAMPUS_CREATED",
      "REQUEST_IN_PROGRESS",
    ]);
  });
});

describe("Campus contract v1 — CourseIdSchema, shared by the review, the options and the feed", () => {
  const ok = (id: string) => CourseIdSchema.safeParse(id).success;

  it("trims, and refuses an id of whitespace only", () => {
    expect(CourseIdSchema.parse("  cnc-programming  ")).toBe("cnc-programming");
    expect(ok("   ")).toBe(false);
    expect(ok(NBSP)).toBe(false);
  });

  it("refuses control (a NUL would be a 22021 in Postgres), format and separator characters", () => {
    expect(ok("cnc" + NUL)).toBe(false);
    // A plain ASCII space inside the id is allowed (the Scheduler's format is unconfirmed); the ends
    // are trimmed. Every other separator is refused.
    expect(ok("cnc programming")).toBe(true);
    expect(CourseIdSchema.parse(" cnc programming ")).toBe("cnc programming");
    expect(ok("cnc" + NBSP + "x")).toBe(false);
    expect(ok("cnc" + LINE_SEP + "x")).toBe(false);
    expect(ok("cnc" + PARA_SEP + "x")).toBe(false);
  });

  it("refuses lone surrogates (the driver would collapse two of them into one U+FFFD key)", () => {
    expect(ok("cnc" + HIGH_SURROGATE)).toBe(false);
    expect(ok("cnc" + LOW_SURROGATE)).toBe(false);
    // Two ids that differ only in their lone surrogate never reach the database together.
    expect(
      CampusTargetingOptionsBodySchema.safeParse({
        as_of: examples.TARGETING_OPTIONS_BODY_EXAMPLE.as_of,
        branches: [{ id: 1, name: "Faridabad" }],
        courses: [
          { id: "c" + HIGH_SURROGATE, name: "One" },
          { id: "c" + LOW_SURROGATE, name: "Two" },
        ],
      }).success,
    ).toBe(false);
  });

  it("refuses private-use and unassigned code points, and imposes no charset beyond that", () => {
    expect(ok("cnc" + ZWJ)).toBe(false);
    expect(ok("cnc" + PRIVATE_USE)).toBe(false);
    expect(ok("cnc" + UNASSIGNED)).toBe(false);
    expect(ok("CNC_101.v2:a/b")).toBe(true);
    expect(ok(KA.repeat(64))).toBe(true);
  });

  it("the review's narrowing refuses the same ids (a NUL is a 400, not a 500)", () => {
    expect(
      CampusReviewBodySchema.safeParse({
        ...examples.REVIEW_BODY_EXAMPLE,
        course_ids: ["a" + NUL],
      }).success,
    ).toBe(false);
  });
});

describe("Campus contract v1 — targeting labels and the body's size", () => {
  const list = examples.TARGETING_OPTIONS_BODY_EXAMPLE;
  const label = (name: string) =>
    CampusTargetingOptionsBodySchema.safeParse({ ...list, branches: [{ id: 1, name }] }).success;

  it("refuses line and paragraph separators, private-use, unassigned and lone surrogates in a label", () => {
    expect(label("Fari" + LINE_SEP + "dabad")).toBe(false);
    expect(label("Fari" + PARA_SEP + "dabad")).toBe(false);
    expect(label("Fari" + PRIVATE_USE + "dabad")).toBe(false);
    expect(label("Fari" + UNASSIGNED + "dabad")).toBe(false);
    expect(label("Fari" + HIGH_SURROGATE + "dabad")).toBe(false);
    // Ordinary spaces and any script stay.
    expect(label("Faridabad Sector 24")).toBe(true);
    // ZWNJ and ZWJ, which Indic spellings need, are the only format characters a label keeps.
    expect(label("x" + ZWNJ + "y" + ZWJ + "z")).toBe(true);
    expect(label("Fari" + ZWSP_L + "dabad")).toBe(false);
    expect(label("Fari" + LRI + "dabad")).toBe(false);
    expect(label(KA.repeat(20))).toBe(true);
  });

  it("caps the lists at 50 branches and 100 courses (what one posting may target)", () => {
    const branches = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: "B" }));
    const courses = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: "c" + String(i), name: "C" }));
    const parse = (b: number, c: number) =>
      CampusTargetingOptionsBodySchema.safeParse({
        as_of: list.as_of,
        branches: branches(b),
        courses: courses(c),
      }).success;
    expect(CAMPUS_TARGETING_LIMITS).toMatchObject({ branches: 50, courses: 100, labelLength: 150 });
    expect(parse(50, 100)).toBe(true);
    expect(parse(51, 1)).toBe(false);
    expect(parse(1, 101)).toBe(false);
  });

  it("the LARGEST valid body, in plain UTF-8, fits the api's 100 kB JSON limit", () => {
    const body = largestTargetingBody();
    expect(CampusTargetingOptionsBodySchema.safeParse(body).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBeLessThanOrEqual(100 * 1024);
  });
});

describe("Campus contract v1 — POST job-postings texts follow the shared character rules (#2752 Part E)", () => {
  const body = examples.POST_FOR_COMPANY_BODY_EXAMPLE;
  const accepts = (patch: Record<string, unknown>) =>
    CampusPostForCompanyBodySchema.safeParse({ ...body, ...patch }).success;
  const CR = cp(0x0d);
  const TAB = cp(0x09);

  it("refuses a company name, title or place that hides a bidi override, an isolate or a zero-width space", () => {
    expect(accepts({ company: { ...body.company, name: "Sharma" + RLO + "Works" } })).toBe(false);
    expect(accepts({ title: "CNC" + ZWSP_L + " Operator" })).toBe(false);
    expect(accepts({ city: "Fari" + NEWLINE + "dabad" })).toBe(false);
    expect(accepts({ state: "Har" + LRI + "yana" })).toBe(false);
    expect(accepts({ location_label: "Plot 7" + NUL + " Sector 24" })).toBe(false);
    // ZWNJ / ZWJ stay, as in every Campus label; so do ordinary spaces and any script.
    expect(accepts({ title: "x" + ZWNJ + "y" + ZWJ + "z" })).toBe(true);
    expect(accepts({ title: KA.repeat(10) + " Operator" })).toBe(true);
  });

  it("refuses a name, title or place of joiners and spaces only (it would render blank)", () => {
    expect(accepts({ company: { ...body.company, name: ZWJ + ZWNJ } })).toBe(false);
    expect(accepts({ title: ZWNJ + " " + ZWJ })).toBe(false);
    expect(accepts({ city: ZWJ })).toBe(false);
    expect(accepts({ location_label: NBSP + ZWNJ })).toBe(false);
  });

  it("keeps a description's lines, turns CR LF into a newline and a tab into a space", () => {
    const parsed = CampusPostForCompanyBodySchema.parse({
      ...body,
      description: "Day shift" + CR + NEWLINE + "3-axis" + TAB + "lathe" + CR + "Faridabad",
    });
    expect(parsed.description).toBe("Day shift" + NEWLINE + "3-axis lathe" + NEWLINE + "Faridabad");
  });

  it("refuses any other hidden character in a description, never cleaning it silently", () => {
    expect(accepts({ description: "Day" + RLO + " shift" })).toBe(false);
    expect(accepts({ description: "Day" + NUL + " shift" })).toBe(false);
    expect(accepts({ description: "Day" + LINE_SEP + "shift" })).toBe(false);
    expect(accepts({ description: "Day" + ZWNJ + " shift" })).toBe(true);
  });
});

describe("Campus contract v1 — every Campus time is within ±14:00 of UTC (Postgres refuses past ±15:59)", () => {
  // Each REQUEST field that carries a time, with a parse of a valid request around it.
  const requests: [string, (time: string) => boolean][] = [
    [
      "review decided_at",
      (t) =>
        CampusReviewBodySchema.safeParse({ ...examples.REVIEW_BODY_EXAMPLE, decided_at: t })
          .success,
    ],
    [
      "targeting as_of",
      (t) =>
        CampusTargetingOptionsBodySchema.safeParse({
          ...examples.TARGETING_OPTIONS_BODY_EXAMPLE,
          as_of: t,
        }).success,
    ],
    [
      "postings changed_since",
      (t) => CampusPostingsQuerySchema.safeParse({ changed_since: t }).success,
    ],
    [
      "applications changed_since",
      (t) => CampusApplicationsQuerySchema.safeParse({ changed_since: t }).success,
    ],
    [
      "apply applied_at",
      (t) =>
        CampusApplyBodySchema.safeParse({ ...examples.APPLY_BODY_EXAMPLE, applied_at: t }).success,
    ],
  ];

  it.each(requests)("%s: accepts Z, IST and the widest real offsets (+14:00, -12:00)", (_n, ok) => {
    expect(ok("2026-11-14T10:00:00.000Z")).toBe(true);
    expect(ok("2026-11-14T15:30:00.000+05:30")).toBe(true);
    expect(ok("2026-11-15T00:00:00.000+14:00")).toBe(true);
    expect(ok("2026-11-13T22:00:00.000-12:00")).toBe(true);
    expect(ok("2026-11-13T20:00:00.000-14:00")).toBe(true);
  });

  it.each(requests)(
    "%s: refuses an offset past ±14:00 (zod and V8 take up to ±23:59)",
    (_n, ok) => {
      expect(ok("2026-11-15T00:01:00.000+14:01")).toBe(false);
      expect(ok("2026-11-15T02:00:00.000+16:00")).toBe(false);
      expect(ok("2026-11-15T09:59:00.000+23:59")).toBe(false);
      expect(ok("2026-11-13T18:00:00.000-16:00")).toBe(false);
    },
  );
});

describe("Campus contract v1 — a targeting label must show something", () => {
  const label = (name: string) =>
    CampusTargetingOptionsBodySchema.safeParse({
      ...examples.TARGETING_OPTIONS_BODY_EXAMPLE,
      branches: [{ id: 1, name }],
    }).success;
  const ZWJ_V = String.fromCharCode(0x200d);
  const ZWNJ_V = String.fromCharCode(0x200c);

  it("refuses a label of joiners (and spaces) only, which passes the character rules but renders blank", () => {
    expect(label(ZWJ_V + ZWNJ_V)).toBe(false);
    expect(label(ZWJ_V + " " + ZWNJ_V)).toBe(false);
  });

  it("accepts joiners beside a visible character", () => {
    expect(label("x" + ZWJ_V)).toBe(true);
  });
});
