import "reflect-metadata";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { type INestApplication, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { AllExceptionsFilter } from "../common/filters/all-exceptions.filter";
import { RequestIdempotency } from "../common/idempotency/request-idempotency.service";
import { SubjectRateLimit } from "../common/rate-limit/subject-rate-limit.service";
import { SERVER_CONFIG } from "../config/config.module";
import { CampusApplicationsController } from "./campus-applications.controller";
import { CampusApplicationsService } from "./campus-applications.service";
import { CampusCallAuditRepository } from "./campus-call-audit.repository";
import { CampusRefusal } from "./campus-errors";
import { CampusJobsController } from "./campus-jobs.controller";
import { CampusPostingsService } from "./campus-postings.service";
import { CampusServiceGuard } from "./campus-service.guard";

/**
 * #2752 part E — the jobs and applications routes over HTTP: the real controllers, the real guard
 * and the api's exception filter, with stand-in services. The vitest setup emits no
 * `design:paramtypes`, so the harness declares the constructor types `nest build` emits.
 */
describe("the Campus jobs and applications routes over HTTP", () => {
  const TOKEN = "campus-jobs-http-token-0123456789";
  const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
  const APPLICATION = {
    application_id: "c0d1e2f3-a4b5-4c6d-9e8f-a0b1c2d3e4f5",
    external_ref: "campus-app-000123",
    posting_id: "b2c4e6f8-1a3b-4c5d-8e7f-90a1b2c3d4e5",
    student_ref: "3c9e7b21-4f6a-4d8e-b1c2-a3d4e5f60718",
    stage: "new",
    changed_at: "2026-11-14T09:30:00.000Z",
  };
  let app: INestApplication | undefined;
  /** What the applications stand-in does next. */
  let applyOutcome: { created: boolean } | Error = { created: true };

  afterEach(async () => {
    await app?.close();
    app = undefined;
    applyOutcome = { created: true };
  });

  async function boot() {
    const config = {
      NODE_ENV: "test",
      CAMPUS_LINK_ENABLED: true,
      CAMPUS_SERVICE_TOKEN_SHA256S: [sha256(TOKEN)],
      CAMPUS_SERVICE_ALLOWED_IPS: ["127.0.0.1"],
      CAMPUS_SERVICE_MAX_PER_MINUTE: 600,
    } as ServerConfig;
    const calls: string[] = [];
    const applications = {
      apply: async () => {
        calls.push("apply");
        if (applyOutcome instanceof Error) throw applyOutcome;
        return { created: applyOutcome.created, application: APPLICATION };
      },
      feed: async () => ({ applications: [APPLICATION], next_cursor: null }),
      withdraw: async () => ({ ...APPLICATION, stage: "withdrawn" }),
    } as unknown as CampusApplicationsService;
    const postings = {
      feed: async () => ({ postings: [], next_cursor: null }),
      postForCompany: async () => ({
        posting_id: APPLICATION.posting_id,
        company_id: "7d3f2a10-5b8e-4c1d-9a6f-0e2b4c6d8f10",
        company_created: true,
      }),
      findCompany: async () => null,
    } as unknown as CampusPostingsService;
    const idempotency = {
      runOnce: async (o: { work: () => Promise<unknown> }) => o.work(),
    } as unknown as RequestIdempotency;

    Reflect.defineMetadata(
      "design:paramtypes",
      [Object, CampusCallAuditRepository, SubjectRateLimit],
      CampusServiceGuard,
    );
    Reflect.defineMetadata(
      "design:paramtypes",
      [CampusPostingsService, RequestIdempotency],
      CampusJobsController,
    );
    Reflect.defineMetadata(
      "design:paramtypes",
      [CampusApplicationsService],
      CampusApplicationsController,
    );

    @Module({
      controllers: [CampusJobsController, CampusApplicationsController],
      providers: [
        { provide: SERVER_CONFIG, useValue: config },
        { provide: CampusCallAuditRepository, useValue: { record: async () => undefined } },
        { provide: SubjectRateLimit, useValue: { assertWithinMinuteCap: async () => {} } },
        { provide: CampusApplicationsService, useValue: applications },
        { provide: CampusPostingsService, useValue: postings },
        { provide: RequestIdempotency, useValue: idempotency },
      ],
    })
    class HarnessModule {}

    app = await NestFactory.create(HarnessModule, { logger: false });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.listen(0, "127.0.0.1");
    const { port } = app.getHttpServer().address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}/internal/campus/v1`, calls };
  }

  const headers = (extra: Record<string, string> = {}) => ({
    "x-service-token": TOKEN,
    "content-type": "application/json",
    ...extra,
  });
  const APPLY_BODY = {
    external_ref: APPLICATION.external_ref,
    posting_id: APPLICATION.posting_id,
    student_ref: APPLICATION.student_ref,
  };

  it("answers 201 for a new application and 200 for the same one again", async () => {
    const { base } = await boot();
    const post = () =>
      fetch(`${base}/applications`, {
        method: "POST",
        headers: headers({ "idempotency-key": APPLICATION.external_ref }),
        body: JSON.stringify(APPLY_BODY),
      });

    const first = await post();
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual(APPLICATION);
    applyOutcome = { created: false };
    expect((await post()).status).toBe(200);
  });

  it("answers a refusal with its contract code, and refuses a body with an unknown key", async () => {
    const { base, calls } = await boot();
    applyOutcome = new CampusRefusal("POSTING_NOT_APPROVED", 409);
    const refused = await fetch(`${base}/applications`, {
      method: "POST",
      headers: headers({ "idempotency-key": APPLICATION.external_ref }),
      body: JSON.stringify(APPLY_BODY),
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      "POSTING_NOT_APPROVED",
    );

    const extra = await fetch(`${base}/applications`, {
      method: "POST",
      headers: headers({ "idempotency-key": APPLICATION.external_ref }),
      body: JSON.stringify({ ...APPLY_BODY, name: "x" }),
    });
    expect(extra.status).toBe(400);
    expect(calls).toEqual(["apply"]);
  });

  it("refuses a write with no Idempotency-Key before the service runs", async () => {
    const { base, calls } = await boot();
    const res = await fetch(`${base}/applications`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(APPLY_BODY),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "IDEMPOTENCY_KEY_REQUIRED",
    );
    expect(calls).toEqual([]);
  });

  it("serves the feeds and the company lookup with the contract's query rules", async () => {
    const { base } = await boot();
    const feed = await fetch(`${base}/applications?limit=10`, { headers: headers() });
    expect(feed.status).toBe(200);
    const unknownKey = await fetch(`${base}/job-postings?colour=red`, { headers: headers() });
    expect(unknownKey.status).toBe(400);
    const company = await fetch(`${base}/companies?phone=9000000001`, { headers: headers() });
    expect(await company.json()).toEqual({ company: null });
  });

  it("posts for a company with 201 and the approved review state", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/job-postings`, {
      method: "POST",
      headers: headers({ "idempotency-key": "campus-post-000001" }),
      body: JSON.stringify({
        company: { phone: "9000000001", name: "Sharma Precision Works" },
        title: "CNC Operator",
        description: "Run a 3-axis CNC lathe.",
        city: "Faridabad",
        openings: 3,
        branch_ids: [1],
        course_ids: ["cnc-programming"],
        staff_ref: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
      }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ company_created: true, review_state: "approved" });
  });
});
