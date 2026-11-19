import "reflect-metadata";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { type INestApplication, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { AllExceptionsFilter } from "../common/filters/all-exceptions.filter";
import { SubjectRateLimit } from "../common/rate-limit/subject-rate-limit.service";
import { SERVER_CONFIG } from "../config/config.module";
import {
  CampusCallAuditRepository,
  type CampusCallAudit,
} from "../campus-link/campus-call-audit.repository";
import { CampusServiceGuard } from "../campus-link/campus-service.guard";
import { APPLICATIONS_CHECK_BODY_EXAMPLE } from "../campus-link/campus-link.examples";
import { CampusApplicationsCheckController } from "./campus-applications-check.controller";
import { FlowCheckEnabledGuard } from "./flow-check.flag";
import { FlowCheckService } from "./flow-check.service";

/**
 * #2890 — `PUT /internal/campus/v1/applications-check` over HTTP: the real Campus guard, the real
 * switch guard, the contract pipe and the api's exception filter, with stand-ins behind them (no
 * database, no Redis), the Campus boot test's harness. The vitest setup emits no
 * `design:paramtypes`, so the harness declares the constructor types `nest build` emits.
 */
describe("PUT applications-check over HTTP", () => {
  const TOKEN = "flow-check-http-test-token-0123456789";
  const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function boot(overrides: Partial<ServerConfig>) {
    const audits: CampusCallAudit[] = [];
    const reports: [unknown, string][] = [];
    const config = {
      NODE_ENV: "test",
      CAMPUS_LINK_ENABLED: true,
      CAMPUS_SERVICE_TOKEN_SHA256S: [sha256(TOKEN)],
      CAMPUS_SERVICE_ALLOWED_IPS: ["127.0.0.1"],
      CAMPUS_SERVICE_MAX_PER_MINUTE: 600,
      FLOW_CHECK_ENABLED: true,
      ...overrides,
    } as ServerConfig;
    const seen = new Set<string>();
    const flowCheck = {
      recordCampusReport: async (body: unknown, key: string) => {
        reports.push([body, key]);
        const recorded = !seen.has(key);
        seen.add(key);
        return { recorded };
      },
    } as unknown as FlowCheckService;

    Reflect.defineMetadata(
      "design:paramtypes",
      [Object, CampusCallAuditRepository, SubjectRateLimit],
      CampusServiceGuard,
    );
    Reflect.defineMetadata("design:paramtypes", [Object], FlowCheckEnabledGuard);
    Reflect.defineMetadata(
      "design:paramtypes",
      [FlowCheckService],
      CampusApplicationsCheckController,
    );

    @Module({
      controllers: [CampusApplicationsCheckController],
      providers: [
        { provide: SERVER_CONFIG, useValue: config },
        {
          provide: CampusCallAuditRepository,
          useValue: { record: async (a: CampusCallAudit) => void audits.push(a) },
        },
        { provide: SubjectRateLimit, useValue: { assertWithinMinuteCap: async () => {} } },
        { provide: FlowCheckService, useValue: flowCheck },
      ],
    })
    class HarnessModule {}

    app = await NestFactory.create(HarnessModule, { logger: false });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.listen(0, "127.0.0.1");
    const { port } = app.getHttpServer().address() as AddressInfo;
    const put = async (body: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}/internal/campus/v1/applications-check`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-service-token": TOKEN,
          "idempotency-key": "check:20261120",
          ...headers,
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      return {
        status: res.status,
        body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
      };
    };
    return { put, audits, reports };
  }

  it("records a report once per Idempotency-Key, behind an audited Campus call", async () => {
    const { put, audits, reports } = await boot({});
    const first = await put(APPLICATIONS_CHECK_BODY_EXAMPLE);
    const replay = await put(APPLICATIONS_CHECK_BODY_EXAMPLE);

    expect(first).toEqual({ status: 200, body: { recorded: true } });
    expect(replay).toEqual({ status: 200, body: { recorded: false } });
    expect(reports[0]).toEqual([APPLICATIONS_CHECK_BODY_EXAMPLE, "check:20261120"]);
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ outcome: "accepted", method: "PUT" });
  });

  it("is a neutral 404 while the flow check is off, after the Campus guard has audited the call", async () => {
    const { put, reports, audits } = await boot({ FLOW_CHECK_ENABLED: false });
    const res = await put(APPLICATIONS_CHECK_BODY_EXAMPLE);
    expect(res.status).toBe(404);
    expect(reports).toEqual([]);
    expect(audits).toHaveLength(1);
  });

  it("is a 404 that writes nothing while the Campus link is off", async () => {
    const { put, reports, audits } = await boot({ CAMPUS_LINK_ENABLED: false });
    expect((await put(APPLICATIONS_CHECK_BODY_EXAMPLE)).status).toBe(404);
    expect(reports).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("refuses a call without the Campus token", async () => {
    const { put, reports } = await boot({});
    expect(
      (await put(APPLICATIONS_CHECK_BODY_EXAMPLE, { "x-service-token": "wrong" })).status,
    ).toBe(401);
    expect(reports).toEqual([]);
  });

  it("answers VALIDATION_FAILED for an extra field and IDEMPOTENCY_KEY_REQUIRED without a key", async () => {
    const { put, reports } = await boot({});
    const extra = await put({ ...APPLICATIONS_CHECK_BODY_EXAMPLE, findings: [] });
    const noKey = await put(APPLICATIONS_CHECK_BODY_EXAMPLE, { "idempotency-key": "x" });
    expect(extra.status).toBe(400);
    expect((extra.body.error as { code: string }).code).toBe("VALIDATION_FAILED");
    expect(noKey.status).toBe(400);
    expect((noKey.body.error as { code: string }).code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(reports).toEqual([]);
  });
});
