import "reflect-metadata";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { type INestApplication, Module } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import type { PayerRole } from "@badabhai/db";
import { AllExceptionsFilter } from "../common/filters/all-exceptions.filter";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";
import { SubjectRateLimit } from "../common/rate-limit/subject-rate-limit.service";
import { SERVER_CONFIG } from "../config/config.module";
import {
  CampusCallAuditRepository,
  type CampusCallAudit,
} from "../campus-link/campus-call-audit.repository";
import { DRIVE_DECISION_BODY_EXAMPLE } from "../campus-link/campus-link.examples";
import { CampusServiceGuard } from "../campus-link/campus-service.guard";
import { PayerAuthGuard } from "../payers/payer-auth.guard";
import { PAYER_ROLES_KEY, PayerRoleGuard } from "../payers/payer-role.guard";
import { PayerSessionService } from "../payers/payer-session.service";
import { PayersRepository } from "../payers/payers.repository";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import { CampusDriveDecisionsService } from "./campus-drive-decisions.service";
import { CampusDriveRequestsController } from "./campus-drive-requests.controller";
import { CampusDriveRequestsService } from "./campus-drive-requests.service";
import { PayerCampusDriveRequestsController } from "./payer-campus-drive-requests.controller";

const getMeta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

const PAYER_ROUTES = ["create", "list", "getOne", "cancel"] as const;

describe("controller metadata", () => {
  it("the company routes sit behind PayerAuthGuard then PayerRoleGuard, every one employer-only", () => {
    expect(getMeta("__guards__", PayerCampusDriveRequestsController)).toEqual([
      PayerAuthGuard,
      PayerRoleGuard,
    ]);
    for (const route of PAYER_ROUTES) {
      const handler = (
        PayerCampusDriveRequestsController.prototype as unknown as Record<string, () => unknown>
      )[route]!;
      expect(new Reflector().get<PayerRole[]>(PAYER_ROLES_KEY, handler), route).toEqual([
        "employer",
      ]);
    }
  });

  it("the Campus routes sit behind CampusServiceGuard alone, never the shared ops token", () => {
    expect(getMeta("__guards__", CampusDriveRequestsController)).toEqual([CampusServiceGuard]);
    expect(getMeta("__guards__", CampusDriveRequestsController)).not.toContain(
      InternalServiceGuard,
    );
    for (const route of ["listDriveRequests", "decideDriveRequest"]) {
      const handler = (
        CampusDriveRequestsController.prototype as unknown as Record<string, object>
      )[route]!;
      expect(getMeta("__guards__", handler), route).toEqual([]);
    }
  });
});

/** An HTTP harness: the real controller(s), the real guards with stubbed dependencies. */
async function listen(app: INestApplication): Promise<string> {
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function call(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

const errorOf = (json: Record<string, unknown>) => json.error as Record<string, unknown>;

describe("company routes over HTTP", () => {
  const EMPLOYER = "11111111-1111-4111-8111-111111111111";
  const AGENT = "22222222-2222-4222-8222-222222222222";
  const ID = "5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function boot() {
    const drives = {
      create: vi.fn(async (payerId: string) => ({ id: ID, created_for: payerId })),
      list: vi.fn(async () => ({ drive_requests: [], next_cursor: null })),
      getOne: vi.fn(async (_payerId: string, id: string) => ({ id })),
      cancel: vi.fn(async (_payerId: string, id: string) => ({ id, status: "cancelled" })),
    };
    // A bearer token names the payer; the row read gives its role and an active status.
    const session = {
      validateAndTouch: async (token: string) => ({
        payerId: token === "agent" ? AGENT : EMPLOYER,
        sid: "sid-1",
        remainingSeconds: 30 * 86400,
        createdAtMs: Date.now(),
        issuedAtSeconds: Math.floor(Date.now() / 1000),
      }),
    };
    const payers = {
      findAuthFacts: async (id: string) => ({
        role: id === AGENT ? "agent" : "employer",
        status: "active",
        sessionsValidAfter: null,
        mustChangePassword: false,
      }),
    };
    Reflect.defineMetadata(
      "design:paramtypes",
      [PayerSessionService, Object, PayersRepository, PayerTenantScopeService],
      PayerAuthGuard,
    );
    Reflect.defineMetadata("design:paramtypes", [Reflector], PayerRoleGuard);
    Reflect.defineMetadata(
      "design:paramtypes",
      [CampusDriveRequestsService],
      PayerCampusDriveRequestsController,
    );

    @Module({
      controllers: [PayerCampusDriveRequestsController],
      providers: [
        { provide: SERVER_CONFIG, useValue: { SESSION_TTL_DAYS: 30 } },
        { provide: PayerSessionService, useValue: session },
        { provide: PayersRepository, useValue: payers },
        { provide: PayerTenantScopeService, useValue: {} },
        { provide: CampusDriveRequestsService, useValue: drives },
      ],
    })
    class HarnessModule {}

    app = await NestFactory.create(HarnessModule, { logger: false });
    const base = `${await listen(app)}/payer/campus-drive-requests`;
    return { base, drives };
  }

  const BODY = {
    preferred_from: "2099-12-01",
    preferred_to: "2099-12-15",
    openings: 12,
    contact_name: "Ravi Sharma",
    contact_phone: "+919812345678",
  };

  it("an agency account gets the house 403 on every route, and the service never runs", async () => {
    const { base, drives } = await boot();
    const agent = { authorization: "Bearer agent", "idempotency-key": "key-0000001" };
    for (const [method, url, body] of [
      ["POST", base, BODY],
      ["GET", base, undefined],
      ["GET", `${base}/${ID}`, undefined],
      ["POST", `${base}/${ID}/cancel`, undefined],
    ] as const) {
      const res = await call(method, url, agent, body);
      expect(res.status, `${method} ${url}`).toBe(403);
    }
    expect(drives.create).not.toHaveBeenCalled();
    expect(drives.list).not.toHaveBeenCalled();
    expect(drives.getOne).not.toHaveBeenCalled();
    expect(drives.cancel).not.toHaveBeenCalled();
  });

  it("without a session the routes are 401", async () => {
    const { base } = await boot();
    expect((await call("GET", base, {})).status).toBe(401);
  });

  it("create REQUIRES a valid Idempotency-Key: missing or malformed → 400 idempotency_key_required", async () => {
    const { base, drives } = await boot();
    for (const key of [undefined, "short", "has space 12345", "x".repeat(201)]) {
      const headers: Record<string, string> = { authorization: "Bearer employer" };
      if (key !== undefined) headers["idempotency-key"] = key;
      const res = await call("POST", base, headers, BODY);
      expect(res.status, String(key)).toBe(400);
      expect(errorOf(res.json)).toMatchObject({ reason: "idempotency_key_required" });
    }
    expect(drives.create).not.toHaveBeenCalled();
  });

  it("create passes the SESSION payer and the key; a body carrying payer_id is a 400", async () => {
    const { base, drives } = await boot();
    const headers = { authorization: "Bearer employer", "idempotency-key": "outbox:0001" };
    const ok = await call("POST", base, headers, BODY);
    expect(ok.status).toBe(201);
    expect(drives.create).toHaveBeenCalledWith(
      EMPLOYER,
      expect.objectContaining({ openings: 12, branch_ids: [] }),
      "outbox:0001",
      expect.anything(),
    );
    const smuggled = await call("POST", base, headers, { ...BODY, payer_id: AGENT });
    expect(smuggled.status).toBe(400);
    expect(drives.create).toHaveBeenCalledTimes(1);
  });

  it("read and cancel take a uuid id and the session payer; a malformed id is 400", async () => {
    const { base, drives } = await boot();
    const headers = { authorization: "Bearer employer" };
    expect((await call("GET", `${base}/${ID}`, headers)).status).toBe(200);
    expect(drives.getOne).toHaveBeenCalledWith(EMPLOYER, ID);
    expect((await call("POST", `${base}/${ID}/cancel`, headers)).status).toBe(200);
    expect(drives.cancel).toHaveBeenCalledWith(EMPLOYER, ID, expect.anything());
    expect((await call("GET", `${base}/not-a-uuid`, headers)).status).toBe(400);
  });

  it("list validates its query: a bad cursor or an unknown key is 400", async () => {
    const { base, drives } = await boot();
    const headers = { authorization: "Bearer employer" };
    expect((await call("GET", `${base}?limit=5`, headers)).status).toBe(200);
    expect((await call("GET", `${base}?cursor=forged`, headers)).status).toBe(400);
    expect((await call("GET", `${base}?status=requested`, headers)).status).toBe(400);
    expect((await call("GET", `${base}?limit=101`, headers)).status).toBe(400);
    expect(drives.list).toHaveBeenCalledTimes(1);
  });
});

describe("Campus routes over HTTP", () => {
  const TOKEN = "campus-drive-test-token-0123456789";
  const ID = "5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
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
    const decisions = {
      list: vi.fn(async () => ({ drive_requests: [], next_cursor: null })),
      decide: vi.fn(async (id: string) => ({
        drive_request_id: id,
        status: "scheduled",
        scheduled_on: "2026-12-05",
        campus_drive_ref: "campus-drive:000417",
        decided_at: "2026-11-20T09:00:00.000+05:30",
        changed_at: "2026-11-20T03:30:00.412851Z",
      })),
    };
    Reflect.defineMetadata(
      "design:paramtypes",
      [Object, CampusCallAuditRepository, SubjectRateLimit],
      CampusServiceGuard,
    );
    Reflect.defineMetadata(
      "design:paramtypes",
      [CampusDriveDecisionsService],
      CampusDriveRequestsController,
    );

    @Module({
      controllers: [CampusDriveRequestsController],
      providers: [
        { provide: SERVER_CONFIG, useValue: config },
        { provide: CampusCallAuditRepository, useValue: audit },
        { provide: SubjectRateLimit, useValue: rateLimit },
        { provide: CampusDriveDecisionsService, useValue: decisions },
      ],
    })
    class HarnessModule {}

    app = await NestFactory.create(HarnessModule, { logger: false });
    const base = `${await listen(app)}/internal/campus/v1`;
    return { base, audits, decisions };
  }

  const auth = { "x-service-token": TOKEN };
  const write = { ...auth, "idempotency-key": "outbox:0001" };

  it("with the link flag off, both routes are the neutral 404 and nothing is audited", async () => {
    const { base, audits, decisions } = await boot({ CAMPUS_LINK_ENABLED: false });
    expect((await call("GET", `${base}/drive-requests`, auth)).status).toBe(404);
    expect(
      (
        await call(
          "POST",
          `${base}/drive-requests/${ID}/decision`,
          write,
          DRIVE_DECISION_BODY_EXAMPLE,
        )
      ).status,
    ).toBe(404);
    expect(audits).toEqual([]);
    expect(decisions.list).not.toHaveBeenCalled();
  });

  it("without the Campus token both are 401: the ops token is not a credential here", async () => {
    const { base, decisions } = await boot();
    const ops = { "x-internal-token": "ops-secret", "idempotency-key": "outbox:0001" };
    expect((await call("GET", `${base}/drive-requests`, ops)).status).toBe(401);
    expect(
      (
        await call(
          "POST",
          `${base}/drive-requests/${ID}/decision`,
          ops,
          DRIVE_DECISION_BODY_EXAMPLE,
        )
      ).status,
    ).toBe(401);
    expect(decisions.list).not.toHaveBeenCalled();
    expect(decisions.decide).not.toHaveBeenCalled();
  });

  it("the feed validates its query strictly, and each accepted call is audited", async () => {
    const { base, audits, decisions } = await boot();
    expect(
      (await call("GET", `${base}/drive-requests?status=scheduled&limit=50`, auth)).status,
    ).toBe(200);
    const bad = await call("GET", `${base}/drive-requests?branch=1`, auth);
    expect(bad.status).toBe(400);
    expect(errorOf(bad.json)).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(decisions.list).toHaveBeenCalledTimes(1);
    expect(audits.filter((a) => a.outcome === "accepted")).toHaveLength(2);
    expect(audits[0]!.path).toBe("/internal/campus/v1/drive-requests");
  });

  it("a decision needs the Idempotency-Key and a strict body, both checked before the service", async () => {
    const { base, decisions } = await boot();
    const url = `${base}/drive-requests/${ID}/decision`;
    const noKey = await call("POST", url, auth, DRIVE_DECISION_BODY_EXAMPLE);
    expect(noKey.status).toBe(400);
    expect(errorOf(noKey.json)).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    for (const body of [
      { ...DRIVE_DECISION_BODY_EXAMPLE, scheduled_on: undefined },
      { ...DRIVE_DECISION_BODY_EXAMPLE, decided_at: undefined },
      { ...DRIVE_DECISION_BODY_EXAMPLE, decided_by_ref: "asha@rvm.example" },
      { ...DRIVE_DECISION_BODY_EXAMPLE, decision: "cancelled" },
      {
        decision: "declined",
        decided_by_ref: DRIVE_DECISION_BODY_EXAMPLE.decided_by_ref,
        decided_at: DRIVE_DECISION_BODY_EXAMPLE.decided_at,
        scheduled_on: "2026-12-05",
      },
      { ...DRIVE_DECISION_BODY_EXAMPLE, contact_phone: "9812345678" },
    ]) {
      const res = await call("POST", url, write, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(errorOf(res.json)).toMatchObject({ code: "VALIDATION_FAILED" });
    }
    expect(decisions.decide).not.toHaveBeenCalled();
  });

  it("a valid decision reaches the service with the guard's call id", async () => {
    const { base, audits, decisions } = await boot();
    const res = await call(
      "POST",
      `${base}/drive-requests/${ID}/decision`,
      write,
      DRIVE_DECISION_BODY_EXAMPLE,
    );
    expect(res.status).toBe(200);
    const callId = audits.find((a) => a.outcome === "accepted")!.callId;
    expect(decisions.decide).toHaveBeenCalledWith(
      ID,
      expect.objectContaining({ decision: "scheduled", scheduled_on: "2026-12-05" }),
      expect.objectContaining({ callId }),
    );
  });
});
