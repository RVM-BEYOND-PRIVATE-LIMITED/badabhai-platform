import "reflect-metadata";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { type INestApplication, Module, NotFoundException } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";
import { AllExceptionsFilter } from "../common/filters/all-exceptions.filter";
import { SubjectRateLimit } from "../common/rate-limit/subject-rate-limit.service";
import { SERVER_CONFIG } from "../config/config.module";
import { CampusCallAuditRepository, type CampusCallAudit } from "./campus-call-audit.repository";
import { REVIEW_BODY_EXAMPLE, TARGETING_OPTIONS_BODY_EXAMPLE } from "./campus-link.examples";
import { CampusPostingReviewService } from "./campus-posting-review.service";
import { CampusReviewController } from "./campus-review.controller";
import { CampusServiceGuard } from "./campus-service.guard";
import { CampusTargetingOptionsService } from "./campus-targeting-options.service";
import { largestTargetingBody } from "./campus-targeting.test-support";

const getMeta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

describe("CampusReviewController metadata", () => {
  it("is guarded by CampusServiceGuard alone, never by the shared ops token", () => {
    expect(getMeta("__guards__", CampusReviewController)).toEqual([CampusServiceGuard]);
    expect(getMeta("__guards__", CampusReviewController)).not.toContain(InternalServiceGuard);
  });
});

/**
 * The real controller, the real guard, the api's exception filter, served over HTTP on the IPv4
 * loopback (the shape of `campus-link.module.boot.test.ts`). The two services are stand-ins: their
 * rules are their own suites'. What this proves is the HTTP layer: the guard is mounted, the key
 * and the body are checked before any service runs, and the call id reaches the service.
 */
describe("Campus review routes over HTTP", () => {
  const TOKEN = "campus-review-test-token-0123456789";
  const POSTING = "b2c4e6f8-1a3b-4c5d-8e7f-90a1b2c3d4e5";
  const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function boot(overrides: Partial<ServerConfig> = {}) {
    const audits: CampusCallAudit[] = [];
    const config = {
      NODE_ENV: "test",
      CAMPUS_LINK_ENABLED: true,
      CAMPUS_SERVICE_TOKEN_SHA256S: [sha256(TOKEN)],
      CAMPUS_SERVICE_ALLOWED_IPS: ["127.0.0.1"],
      CAMPUS_SERVICE_MAX_PER_MINUTE: 600,
      ...overrides,
    } as ServerConfig;
    const audit = {
      record: async (a: CampusCallAudit) => {
        audits.push(a);
      },
    } as unknown as CampusCallAuditRepository;
    const rateLimit = { assertWithinMinuteCap: async () => {} } as unknown as SubjectRateLimit;
    const reviews = {
      review: vi.fn(async (id: string) => ({
        posting_id: id,
        review_state: "approved" as const,
        reviewed_at: "2026-11-14T10:00:00.000Z",
      })),
    };
    const targeting = {
      replace: vi.fn(async () => ({
        branches: { listed: 4, added: 4, updated: 0, deactivated: 0 },
        courses: { listed: 2, added: 2, updated: 0, deactivated: 0 },
      })),
    };

    // The vitest setup emits no `design:paramtypes`; declare what `nest build` emits.
    Reflect.defineMetadata(
      "design:paramtypes",
      [Object, CampusCallAuditRepository, SubjectRateLimit],
      CampusServiceGuard,
    );
    Reflect.defineMetadata(
      "design:paramtypes",
      [CampusPostingReviewService, CampusTargetingOptionsService],
      CampusReviewController,
    );

    @Module({
      controllers: [CampusReviewController],
      providers: [
        { provide: SERVER_CONFIG, useValue: config },
        { provide: CampusCallAuditRepository, useValue: audit },
        { provide: SubjectRateLimit, useValue: rateLimit },
        { provide: CampusPostingReviewService, useValue: reviews },
        { provide: CampusTargetingOptionsService, useValue: targeting },
      ],
    })
    class HarnessModule {}

    app = await NestFactory.create(HarnessModule, { logger: false });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.listen(0, "127.0.0.1");
    const { port } = app.getHttpServer().address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}/internal/campus/v1`, audits, reviews, targeting };
  }

  async function put(
    url: string,
    body: unknown,
    headers: Record<string, string> = {
      "x-service-token": TOKEN,
      "idempotency-key": "outbox:0001",
    },
  ) {
    const res = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    return { res, json, code: (json.error as { code?: unknown } | undefined)?.code };
  }

  it("PUT review: 200 with the service's answer; the guard's call id reaches the service", async () => {
    const { base, reviews, audits } = await boot();
    const { res, json } = await put(`${base}/job-postings/${POSTING}/review`, REVIEW_BODY_EXAMPLE);

    expect(res.status).toBe(200);
    expect(json).toEqual({
      posting_id: POSTING,
      review_state: "approved",
      reviewed_at: "2026-11-14T10:00:00.000Z",
    });
    const callId = res.headers.get("x-campus-call-id");
    expect(audits).toEqual([expect.objectContaining({ callId, outcome: "accepted" })]);
    expect(reviews.review).toHaveBeenCalledWith(
      POSTING,
      REVIEW_BODY_EXAMPLE,
      expect.objectContaining({ callId }),
    );
  });

  it("PUT review: 400 IDEMPOTENCY_KEY_REQUIRED without the key, before the service runs", async () => {
    const { base, reviews } = await boot();
    const missing = await put(`${base}/job-postings/${POSTING}/review`, REVIEW_BODY_EXAMPLE, {
      "x-service-token": TOKEN,
    });
    const malformed = await put(`${base}/job-postings/${POSTING}/review`, REVIEW_BODY_EXAMPLE, {
      "x-service-token": TOKEN,
      "idempotency-key": "short",
    });
    expect(missing.res.status).toBe(400);
    expect(missing.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(malformed.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(reviews.review).not.toHaveBeenCalled();
  });

  it("PUT review: 400 VALIDATION_FAILED for a body without content_hash or with an unknown key", async () => {
    const { base, reviews } = await boot();
    const { content_hash: _omitted, ...noHash } = REVIEW_BODY_EXAMPLE;
    const a = await put(`${base}/job-postings/${POSTING}/review`, noHash);
    const b = await put(`${base}/job-postings/${POSTING}/review`, {
      ...REVIEW_BODY_EXAMPLE,
      reviewer_name: "Asha",
    });
    expect(a.res.status).toBe(400);
    expect(a.code).toBe("VALIDATION_FAILED");
    expect(b.code).toBe("VALIDATION_FAILED");
    expect(reviews.review).not.toHaveBeenCalled();
  });

  it("PUT review: the service's neutral 404 goes out with no code", async () => {
    const { base, reviews } = await boot();
    reviews.review.mockRejectedValueOnce(new NotFoundException());
    const { res, code } = await put(`${base}/job-postings/${POSTING}/review`, REVIEW_BODY_EXAMPLE);
    expect(res.status).toBe(404);
    expect(code).toBeUndefined();
  });

  it("both routes: a neutral 404 with CAMPUS_LINK_ENABLED off, and nothing runs", async () => {
    const { base, reviews, targeting, audits } = await boot({ CAMPUS_LINK_ENABLED: false });
    const review = await put(`${base}/job-postings/${POSTING}/review`, REVIEW_BODY_EXAMPLE);
    const options = await put(`${base}/targeting-options`, TARGETING_OPTIONS_BODY_EXAMPLE);
    expect(review.res.status).toBe(404);
    expect(options.res.status).toBe(404);
    expect(reviews.review).not.toHaveBeenCalled();
    expect(targeting.replace).not.toHaveBeenCalled();
    expect(audits).toEqual([]);
  });

  it("both routes: 401 without the Campus token, even carrying the shared ops header", async () => {
    const { base, reviews, targeting } = await boot();
    const headers = { "x-internal-service-token": TOKEN, "idempotency-key": "outbox:0001" };
    const review = await put(
      `${base}/job-postings/${POSTING}/review`,
      REVIEW_BODY_EXAMPLE,
      headers,
    );
    const options = await put(`${base}/targeting-options`, TARGETING_OPTIONS_BODY_EXAMPLE, headers);
    expect(review.res.status).toBe(401);
    expect(options.res.status).toBe(401);
    expect(reviews.review).not.toHaveBeenCalled();
    expect(targeting.replace).not.toHaveBeenCalled();
  });

  it("PUT targeting-options: 200 with the counts; the parsed (trimmed) list reaches the service", async () => {
    const { base, targeting } = await boot();
    const { res, json } = await put(`${base}/targeting-options`, {
      ...TARGETING_OPTIONS_BODY_EXAMPLE,
      branches: [{ id: 1, name: "  Faridabad  " }],
    });
    expect(res.status).toBe(200);
    expect(json).toEqual({
      branches: { listed: 4, added: 4, updated: 0, deactivated: 0 },
      courses: { listed: 2, added: 2, updated: 0, deactivated: 0 },
    });
    expect(targeting.replace).toHaveBeenCalledWith(
      {
        as_of: TARGETING_OPTIONS_BODY_EXAMPLE.as_of,
        branches: [{ id: 1, name: "Faridabad" }],
        courses: TARGETING_OPTIONS_BODY_EXAMPLE.courses,
      },
      expect.objectContaining({ callId: res.headers.get("x-campus-call-id") }),
    );
  });

  it("PUT targeting-options: 400 IDEMPOTENCY_KEY_REQUIRED / VALIDATION_FAILED before the service", async () => {
    const { base, targeting } = await boot();
    const noKey = await put(`${base}/targeting-options`, TARGETING_OPTIONS_BODY_EXAMPLE, {
      "x-service-token": TOKEN,
    });
    const duplicate = await put(`${base}/targeting-options`, {
      as_of: TARGETING_OPTIONS_BODY_EXAMPLE.as_of,
      branches: [
        { id: 1, name: "Faridabad" },
        { id: 1, name: "Faridabad" },
      ],
      courses: TARGETING_OPTIONS_BODY_EXAMPLE.courses,
    });
    expect(noKey.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(duplicate.res.status).toBe(400);
    expect(duplicate.code).toBe("VALIDATION_FAILED");
    expect(targeting.replace).not.toHaveBeenCalled();
  });

  it("PUT targeting-options: the LARGEST valid body passes the real JSON parser (100 kB) and reaches the service", async () => {
    const { base, targeting } = await boot();
    const body = largestTargetingBody();
    expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBeGreaterThan(80 * 1024);
    const { res } = await put(base + "/targeting-options", body);
    expect(res.status).toBe(200);
    expect(targeting.replace).toHaveBeenCalledTimes(1);
  });

  // The parser refuses it before any route runs. The api-wide AllExceptionsFilter answers a non-Nest
  // error (body-parser 413 included) as 500 today; that is the filter, not this route (PR 5 report).
  it("PUT targeting-options: a body past the 100 kB parser limit is refused and the service never runs", async () => {
    const { base, targeting } = await boot();
    const res = await fetch(base + "/targeting-options", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-service-token": TOKEN,
        "idempotency-key": "outbox:0001",
      },
      body: JSON.stringify({ padding: "x".repeat(101 * 1024) }),
    });
    await res.arrayBuffer();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(targeting.replace).not.toHaveBeenCalled();
  });

  it("lone surrogates sent as JSON escapes are refused with 400, never stored as U+FFFD", async () => {
    const { base, targeting } = await boot();
    // JSON.stringify escapes a lone surrogate, so the wire carries the escape text and the parser
    // hands the lone code unit back to the schema.
    const high = String.fromCharCode(0xd800);
    const low = String.fromCharCode(0xdc00);
    const { res, code } = await put(base + "/targeting-options", {
      as_of: TARGETING_OPTIONS_BODY_EXAMPLE.as_of,
      branches: [{ id: 1, name: "Faridabad" }],
      courses: [
        { id: "c" + high, name: "One" },
        { id: "c" + low, name: "Two" },
      ],
    });
    expect(res.status).toBe(400);
    expect(code).toBe("VALIDATION_FAILED");
    expect(targeting.replace).not.toHaveBeenCalled();
  });

  it("PUT review: a NUL in course_ids is a 400 VALIDATION_FAILED, not a database error", async () => {
    const { base, reviews } = await boot();
    const { res, code } = await put(base + "/job-postings/" + POSTING + "/review", {
      ...REVIEW_BODY_EXAMPLE,
      course_ids: ["cnc" + String.fromCharCode(0)],
    });
    expect(res.status).toBe(400);
    expect(code).toBe("VALIDATION_FAILED");
    expect(reviews.review).not.toHaveBeenCalled();
  });
});
