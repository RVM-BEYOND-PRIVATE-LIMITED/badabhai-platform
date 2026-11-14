import "reflect-metadata";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { type INestApplication, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { AllExceptionsFilter } from "../common/filters/all-exceptions.filter";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";
import { SubjectRateLimit } from "../common/rate-limit/subject-rate-limit.service";
import { SERVER_CONFIG } from "../config/config.module";
import { CampusCallAuditRepository, type CampusCallAudit } from "./campus-call-audit.repository";
import { CampusGrantsController } from "./campus-grants.controller";
import { CampusLinkController } from "./campus-link.controller";
import { CampusLinkModule } from "./campus-link.module";
import { CampusServiceGuard } from "./campus-service.guard";
import { InstituteLinkService, StudentNotAvailableError } from "./institute-link.service";
import {
  GrantNotFoundError,
  GrantRefConflictError,
  InstituteSearchGrantsService,
} from "./institute-search-grants.service";
import { RvmStudentApiUnavailableError } from "./rvm-student-api.client";

const getMeta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

describe("CampusLinkModule wiring", () => {
  it("declares the controller, the guard and the audit repository", () => {
    expect(getMeta("controllers", CampusLinkModule)).toEqual([
      CampusLinkController,
      CampusGrantsController,
    ]);
    expect(getMeta("providers", CampusLinkModule)).toEqual(
      expect.arrayContaining([CampusServiceGuard, CampusCallAuditRepository]),
    );
  });

  it("exports the guard, so #2746 and #2750 mount their Campus routes behind the same credential", () => {
    expect(getMeta("exports", CampusLinkModule)).toContain(CampusServiceGuard);
  });

  it("is guarded by CampusServiceGuard alone, never by the shared ops token", () => {
    expect(getMeta("__guards__", CampusLinkController)).toEqual([CampusServiceGuard]);
    expect(getMeta("__guards__", CampusLinkController)).not.toContain(InternalServiceGuard);
  });
});

/**
 * The real controller and guard, served over HTTP on the IPv4 loopback, the guard resolved by Nest
 * from `@UseGuards` exactly as in production, and the api's own exception filter, so an error
 * answers in the published envelope. The vitest setup emits no `design:paramtypes`, so the harness
 * declares the constructor types `nest build` emits for the guard and the controller; the values
 * behind them are stand-ins (no database, no Redis, no RVM).
 */
describe("the Campus routes over HTTP", () => {
  const TOKEN = "campus-boot-test-token-0123456789";
  const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  /** What the grant service stand-in does next: answer a grant, or throw a domain error. */
  let grantOutcome: Error | null = null;

  async function boot(overrides: Partial<ServerConfig>) {
    const audits: CampusCallAudit[] = [];
    const config = {
      // A loopback peer is Campus only in development and tests; production refuses it.
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
    const unlinks: [string, string][] = [];
    const links = {
      unlinkStudent: async (ref: string, reason: string) => {
        unlinks.push([ref, reason]);
      },
    } as unknown as InstituteLinkService;
    const grantCalls: string[] = [];
    const answerGrant = async (grantRef: string) => {
      grantCalls.push(grantRef);
      if (grantOutcome) throw grantOutcome;
      return {
        grantRef,
        companyId: "7d3f2a10-5b8e-4c1d-9a6f-0e2b4c6d8f10",
        studentRef: "3c9e7b21-4f6a-4d8e-b1c2-a3d4e5f60718",
        state: "active" as const,
        changedAt: new Date("2026-11-14T09:30:00.000Z"),
      };
    };
    const grants = {
      grant: answerGrant,
      revoke: answerGrant,
    } as unknown as InstituteSearchGrantsService;

    Reflect.defineMetadata(
      "design:paramtypes",
      [Object, CampusCallAuditRepository, SubjectRateLimit],
      CampusServiceGuard,
    );
    Reflect.defineMetadata("design:paramtypes", [InstituteLinkService], CampusLinkController);
    Reflect.defineMetadata(
      "design:paramtypes",
      [InstituteSearchGrantsService],
      CampusGrantsController,
    );

    @Module({
      controllers: [CampusLinkController, CampusGrantsController],
      providers: [
        { provide: SERVER_CONFIG, useValue: config },
        { provide: CampusCallAuditRepository, useValue: audit },
        { provide: SubjectRateLimit, useValue: rateLimit },
        { provide: InstituteLinkService, useValue: links },
        { provide: InstituteSearchGrantsService, useValue: grants },
      ],
    })
    class HarnessModule {}

    app = await NestFactory.create(HarnessModule, { logger: false });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.listen(0, "127.0.0.1");
    const { port } = app.getHttpServer().address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}/internal/campus/v1`, audits, unlinks, grantCalls };
  }

  it("answers 200 with the audit row's id in both the header and the body", async () => {
    const { base, audits } = await boot({});

    const res = await fetch(`${base}/ping`, { headers: { "x-service-token": TOKEN } });
    const body = (await res.json()) as { ok: boolean; call_id: string };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(res.headers.get("x-campus-call-id")).toBe(body.call_id);
    expect(audits).toEqual([
      expect.objectContaining({ callId: body.call_id, outcome: "accepted", tokenSlot: 0 }),
    ]);
  });

  it("answers 404 with the flag off and writes nothing", async () => {
    const { base, audits } = await boot({ CAMPUS_LINK_ENABLED: false });

    const res = await fetch(`${base}/ping`, { headers: { "x-service-token": TOKEN } });
    await res.arrayBuffer();

    expect(res.status).toBe(404);
    expect(audits).toEqual([]);
  });

  it("answers 401 without the Campus token, even carrying the shared ops header", async () => {
    const { base } = await boot({});

    const res = await fetch(`${base}/ping`, { headers: { "x-internal-service-token": TOKEN } });
    await res.arrayBuffer();

    expect(res.status).toBe(401);
  });

  it("answers 403 to an address off the allow-list", async () => {
    const { base, audits } = await boot({ CAMPUS_SERVICE_ALLOWED_IPS: ["203.0.113.7"] });

    const res = await fetch(`${base}/ping`, { headers: { "x-service-token": TOKEN } });
    await res.arrayBuffer();

    expect(res.status).toBe(403);
    expect(audits).toEqual([]);
  });

  describe("DELETE students/:student_ref", () => {
    const REF = "3c9e7b21-4f6a-4d8e-b1c2-a3d4e5f60718";
    const KEY = "campus-unlink-000001";

    it("unlinks the student for the Campus request and answers unlinked", async () => {
      const { base, unlinks } = await boot({});

      const res = await fetch(`${base}/students/${REF}`, {
        method: "DELETE",
        headers: { "x-service-token": TOKEN, "idempotency-key": KEY },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ student_ref: REF, state: "unlinked" });
      expect(unlinks).toEqual([[REF, "campus_request"]]);
    });

    it("audits the route template, never the student reference in the path", async () => {
      const { base, audits } = await boot({});

      const res = await fetch(`${base}/students/${REF}`, {
        method: "DELETE",
        headers: { "x-service-token": TOKEN, "idempotency-key": KEY },
      });
      await res.arrayBuffer();

      expect(audits.map((a) => a.path)).toEqual(["/internal/campus/v1/students/:student_ref"]);
      expect(JSON.stringify(audits)).not.toContain(REF);
    });

    it("answers 400 IDEMPOTENCY_KEY_REQUIRED without a key, and unlinks nothing", async () => {
      const { base, unlinks } = await boot({});

      const res = await fetch(`${base}/students/${REF}`, {
        method: "DELETE",
        headers: { "x-service-token": TOKEN },
      });
      const body = (await res.json()) as { error: { code?: string } };

      expect(res.status).toBe(400);
      expect(body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
      expect(unlinks).toEqual([]);
    });

    it("answers 400 VALIDATION_FAILED for a reference that is not a uuid, and unlinks nothing", async () => {
      const { base, unlinks } = await boot({});

      const res = await fetch(`${base}/students/not-a-ref`, {
        method: "DELETE",
        headers: { "x-service-token": TOKEN, "idempotency-key": KEY },
      });
      const body = (await res.json()) as { error: { code?: string } };

      expect(res.status).toBe(400);
      expect(body.error.code).toBe("VALIDATION_FAILED");
      expect(unlinks).toEqual([]);
    });

    it("answers 401 without the Campus token before anything else runs", async () => {
      const { base, unlinks } = await boot({});

      const res = await fetch(`${base}/students/${REF}`, {
        method: "DELETE",
        headers: { "idempotency-key": KEY },
      });
      await res.arrayBuffer();

      expect(res.status).toBe(401);
      expect(unlinks).toEqual([]);
    });

    it("answers 404 with the flag off and unlinks nothing", async () => {
      const { base, unlinks } = await boot({ CAMPUS_LINK_ENABLED: false });

      const res = await fetch(`${base}/students/${REF}`, {
        method: "DELETE",
        headers: { "x-service-token": TOKEN, "idempotency-key": KEY },
      });
      await res.arrayBuffer();

      expect(res.status).toBe(404);
      expect(unlinks).toEqual([]);
    });
  });

  describe("search-grants/:grant_ref", () => {
    const GRANT = "grant-000000001";
    const BODY = {
      company_id: "7d3f2a10-5b8e-4c1d-9a6f-0e2b4c6d8f10",
      student_ref: "3c9e7b21-4f6a-4d8e-b1c2-a3d4e5f60718",
      consent_ref: "consent-req-000456",
    };
    const put = (base: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}/search-grants/${GRANT}`, {
        method: "PUT",
        headers: {
          "x-service-token": TOKEN,
          "idempotency-key": "grant-key-0001",
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
      });

    afterEach(() => {
      grantOutcome = null;
    });

    it("answers the stored grant in the contract's shape", async () => {
      const { base } = await boot({});
      const res = await put(base, BODY);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        grant_ref: GRANT,
        company_id: BODY.company_id,
        student_ref: BODY.student_ref,
        state: "active",
        changed_at: "2026-11-14T09:30:00.000Z",
      });
    });

    it("refuses an unknown body key before the service runs", async () => {
      const { base, grantCalls } = await boot({});
      const res = await put(base, { ...BODY, name: "x" });
      const body = (await res.json()) as { error: { code?: string } };
      expect(res.status).toBe(400);
      expect(body.error.code).toBe("VALIDATION_FAILED");
      expect(grantCalls).toEqual([]);
    });

    it.each([
      [new StudentNotAvailableError(), 409, "STUDENT_NOT_AVAILABLE"],
      [new RvmStudentApiUnavailableError("timeout"), 503, "RVM_UNAVAILABLE"],
      [new GrantRefConflictError(), 409, "EXTERNAL_REF_CONFLICT"],
      [new GrantNotFoundError(), 404, undefined],
    ])("answers %s as %i %s", async (err, status, code) => {
      grantOutcome = err as Error;
      const { base } = await boot({});
      const res = await put(base, BODY);
      const body = (await res.json()) as { error: { code?: string } };
      expect(res.status).toBe(status);
      expect(body.error.code).toBe(code);
    });

    it("revokes by DELETE, with the key", async () => {
      const { base, grantCalls } = await boot({});
      const res = await fetch(`${base}/search-grants/${GRANT}`, {
        method: "DELETE",
        headers: { "x-service-token": TOKEN, "idempotency-key": "grant-key-0002" },
      });
      expect(res.status).toBe(200);
      expect(grantCalls).toEqual([GRANT]);
    });
  });
});
