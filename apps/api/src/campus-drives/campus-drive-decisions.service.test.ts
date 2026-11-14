import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { loadServerConfig } from "@badabhai/config";
import { validateEvent } from "@badabhai/event-schema";
import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import { defaultModeResolver, resolverOver } from "../payers/payer-tenant-scope.test-support";
import {
  CampusDriveDecisionBodySchema,
  CampusDriveRequestPageSchema,
  CampusDriveRequestsQuerySchema,
} from "../campus-link/campus-link.contract";
import {
  CampusDriveDecisionsService,
  DRIVE_DECISION_MAX_CLOCK_SKEW_MS,
} from "./campus-drive-decisions.service";
import {
  MemoryDriveRequests,
  capturingEvents,
  rolloutWith,
  testPii,
  uuid,
} from "./campus-drive-requests.test-support";
import type { DriveRequestInsert } from "./campus-drive-requests.repository";
import type { TenantKey } from "../payers/payer-tenant-scope";

const CTX: RequestContext = { correlationId: uuid(0x27460d01), requestId: "drive-decision-unit" };
const CALL = { ctx: CTX, callId: uuid(0x27460d02) };
const COMPANY = uuid(0x27460d03);
const PILOT_COMPANY = uuid(0x27460d04);
const STAFF = "9A8B7C6D-5E4F-4A3B-8C2D-1E0F9A8B7C6D";
const ON = { CAMPUS_DRIVE_REQUESTS_ROLLOUT: "on" };

const CONTACT_NAME = "Ravi Sharma";
const CONTACT_PHONE = "+919812345678";
const NOTE = "CNC operators and setters";
const REASON = "No campus slot this month, sorry";

function world(options: { settings?: Record<string, string>; pilot?: string[] } = {}) {
  const table = new MemoryDriveRequests();
  const pii = testPii();
  table.companyNames.set(COMPANY, pii.encrypt(" Sharma Precision Works "));
  table.companyNames.set(PILOT_COMPANY, pii.encrypt("Pilot Fabricators"));
  const events = capturingEvents();
  const service = new CampusDriveDecisionsService(
    table.asRepository(),
    rolloutWith(options.settings ?? ON, options.pilot ?? []),
    defaultModeResolver(),
    pii,
    events.service as unknown as EventsService,
  );

  async function seed(payerId: string, over: Partial<DriveRequestInsert> = {}): Promise<string> {
    const row = await table.insert(undefined, {
      payerId: payerId as TenantKey,
      createdBy: payerId,
      jobPostingId: null,
      branchIds: [1],
      preferredFrom: "2026-12-01",
      preferredTo: "2026-12-15",
      openings: 12,
      rolesNote: NOTE,
      contactNameEnc: pii.encrypt(CONTACT_NAME),
      contactPhoneEnc: pii.encrypt(CONTACT_PHONE),
      isTest: false,
      idempotencyKey: `seed-${table.rows.length + 1}-key`,
      ...over,
    });
    return row!.id;
  }
  return { table, events, service, seed, pii };
}

const scheduleAt = (decidedAt: string, over: Record<string, unknown> = {}) =>
  CampusDriveDecisionBodySchema.parse({
    decision: "scheduled",
    decided_by_ref: STAFF,
    decided_at: decidedAt,
    scheduled_on: "2026-12-05",
    campus_drive_ref: "campus-drive:000417",
    ...over,
  });

const decisionAt = (decision: "declined" | "completed", decidedAt: string, over = {}) =>
  CampusDriveDecisionBodySchema.parse({
    decision,
    decided_by_ref: STAFF,
    decided_at: decidedAt,
    ...over,
  });

async function refusal(run: () => Promise<unknown>): Promise<HttpException> {
  try {
    await run();
  } catch (err) {
    if (err instanceof HttpException) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-20T06:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the switch (capabilities only)", () => {
  it("off everywhere: the feed and a decision are the neutral 404, before any read", async () => {
    const { service, seed, table } = world({ settings: { CAMPUS_DRIVE_REQUESTS_ROLLOUT: "off" } });
    const id = await seed(COMPANY);
    const listFeed = vi.spyOn(table, "listFeed");
    const findOwner = vi.spyOn(table, "findOwner");
    await expect(service.list(CampusDriveRequestsQuerySchema.parse({}))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.decide(id, scheduleAt("2026-11-20T05:00:00Z"), CALL),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(listFeed).not.toHaveBeenCalled();
    expect(findOwner).not.toHaveBeenCalled();
  });

  it("pilot: the feed lists only pilot companies' requests, and a decision on another is 404", async () => {
    const { service, seed, table, events } = world({
      settings: { CAMPUS_DRIVE_REQUESTS_ROLLOUT: "pilot" },
      pilot: [PILOT_COMPANY],
    });
    const hidden = await seed(COMPANY);
    const listed = await seed(PILOT_COMPANY);
    const page = await service.list(CampusDriveRequestsQuerySchema.parse({}));
    expect(page.drive_requests.map((r) => r.id)).toEqual([listed]);
    const before = table.digest();
    await expect(
      service.decide(hidden, scheduleAt("2026-11-20T05:00:00Z"), CALL),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(table.digest()).toBe(before);
    expect(events.emitted).toEqual([]);
    await expect(
      service.decide(listed, scheduleAt("2026-11-20T05:00:00Z"), CALL),
    ).resolves.toMatchObject({ status: "scheduled" });
  });

  it("a page whose every request is left out still moves Campus forward", async () => {
    const { service, seed } = world({
      settings: { CAMPUS_DRIVE_REQUESTS_ROLLOUT: "pilot" },
      pilot: [PILOT_COMPANY],
    });
    await seed(COMPANY);
    await seed(COMPANY);
    const listed = await seed(PILOT_COMPANY);
    const first = await service.list(CampusDriveRequestsQuerySchema.parse({ limit: "2" }));
    expect(first.drive_requests).toEqual([]);
    expect(first.next_cursor).not.toBeNull();
    const second = await service.list(
      CampusDriveRequestsQuerySchema.parse({ limit: "2", cursor: first.next_cursor }),
    );
    expect(second.drive_requests.map((r) => r.id)).toEqual([listed]);
    expect(second.next_cursor).toBeNull();
  });
});

describe("GET drive-requests", () => {
  it("each item parses against the contract and carries the contact, decrypted, for the placement team", async () => {
    const { service, seed } = world();
    const id = await seed(COMPANY, { isTest: true });
    const page = await service.list(CampusDriveRequestsQuerySchema.parse({}));
    expect(CampusDriveRequestPageSchema.safeParse(page).success).toBe(true);
    expect(page.drive_requests[0]).toMatchObject({
      id,
      company: { id: COMPANY, name: "Sharma Precision Works" },
      branch_ids: [1],
      preferred_from: "2026-12-01",
      preferred_to: "2026-12-15",
      openings: 12,
      roles_note: NOTE,
      contact: { name: CONTACT_NAME, phone: CONTACT_PHONE },
      status: "requested",
      is_test: true,
      decided_at: null,
    });
  });

  it("an erased contact is listed as null; the request stays", async () => {
    const { service, seed, table } = world();
    await seed(COMPANY);
    Object.assign(table.rows[0]!, {
      contactNameEnc: null,
      contactPhoneEnc: null,
      contactErasedAt: new Date(),
    });
    const page = await service.list(CampusDriveRequestsQuerySchema.parse({}));
    expect(page.drive_requests[0]!.contact).toBeNull();
  });

  it("filters by status and changed_since, and refuses a cursor it did not mint", async () => {
    const { service, seed } = world();
    const a = await seed(COMPANY);
    await seed(COMPANY);
    await service.decide(a, scheduleAt("2026-11-20T05:00:00Z"), CALL);
    const scheduled = await service.list(
      CampusDriveRequestsQuerySchema.parse({ status: "scheduled" }),
    );
    expect(scheduled.drive_requests.map((r) => r.id)).toEqual([a]);
    const since = await service.list(
      CampusDriveRequestsQuerySchema.parse({ changed_since: "2099-01-01T00:00:00Z" }),
    );
    expect(since.drive_requests).toEqual([]);
    const err = await refusal(() =>
      service.list(CampusDriveRequestsQuerySchema.parse({ cursor: "not-a-cursor" })),
    );
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("POST drive-requests/:id/decision", () => {
  it("schedules: stores Campus's decided_at, one campus_drive.decided, one staff audit row, all in the transaction", async () => {
    const { service, seed, table, events } = world();
    const id = await seed(COMPANY);
    const answer = await service.decide(id, scheduleAt("2026-11-20T10:30:00+05:30"), CALL);
    expect(answer).toMatchObject({
      drive_request_id: id,
      status: "scheduled",
      scheduled_on: "2026-12-05",
      campus_drive_ref: "campus-drive:000417",
      decided_at: "2026-11-20T10:30:00+05:30",
    });
    expect(table.rows[0]).toMatchObject({
      status: "scheduled",
      decidedByRef: STAFF.toLowerCase(),
      decidedAt: new Date("2026-11-20T05:00:00.000Z"),
    });

    expect(events.emitted).toHaveLength(1);
    const e = events.emitted[0]!;
    expect(e.event_name).toBe("campus_drive.decided");
    expect(e.tx).toBeDefined();
    expect(e.actor).toEqual({ actor_type: "system", actor_id: null });
    expect(e.payload).toEqual({
      campus_drive_request_id: id,
      payer_id: COMPANY,
      decision: "scheduled",
      previous_status: "requested",
      decided_by_ref: STAFF.toLowerCase(),
      decided_at: "2026-11-20T10:30:00+05:30",
      scheduled_on: "2026-12-05",
      campus_drive_ref: "campus-drive:000417",
      has_reason: false,
    });
    const envelope = {
      event_id: uuid(1),
      event_name: e.event_name,
      event_version: 1,
      occurred_at: "2026-11-20T06:00:00.000Z",
      actor: e.actor,
      subject: e.subject,
      source: "api",
      correlation_id: CTX.correlationId,
      payload: e.payload,
      metadata: { environment: "test", service: "api" },
    };
    expect(validateEvent(envelope).success).toBe(true);

    expect(table.audits).toHaveLength(1);
    expect(table.audits[0]).toMatchObject({
      driveRequestId: id,
      decidedByRef: STAFF.toLowerCase(),
      metadata: {
        decision: "scheduled",
        previous_status: "requested",
        campus_call_id: CALL.callId,
        event_id: uuid(0xe0001),
        has_reason: false,
      },
    });
  });

  it("then the company reads the scheduled date (the issue's check, end to end in memory)", async () => {
    const { service, seed, table } = world();
    const id = await seed(COMPANY);
    await service.decide(id, scheduleAt("2026-11-20T05:00:00Z"), CALL);
    expect(table.rows[0]).toMatchObject({ scheduledOn: "2026-12-05", status: "scheduled" });
  });

  it("the reason is cleaned, stored for the company, and never in the event, the audit row or a log", async () => {
    const { service, seed, table, events } = world();
    const id = await seed(COMPANY);
    const RLO = String.fromCharCode(0x202e);
    const lines: string[] = [];
    const spies = (["log", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      }),
    );
    try {
      await service.decide(
        id,
        decisionAt("declined", "2026-11-20T05:00:00Z", { reason: `${RLO}${REASON}` }),
        CALL,
      );
      await service.list(CampusDriveRequestsQuerySchema.parse({}));
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(table.rows[0]!.decisionReason).toBe(REASON);
    expect((events.emitted[0]!.payload as { has_reason: boolean }).has_reason).toBe(true);
    const spine = JSON.stringify([events.emitted, table.audits]);
    for (const secret of [REASON, CONTACT_NAME, "9812345678", NOTE]) {
      expect(spine).not.toContain(secret);
      for (const line of lines) expect(line).not.toContain(secret);
    }
    expect(lines.length).toBeGreaterThan(0);
  });

  it("a decided_at more than five minutes ahead of BadaBhai's clock is 400, before any read", async () => {
    const { service, seed, table } = world();
    const id = await seed(COMPANY);
    const findOwner = vi.spyOn(table, "findOwner");
    const ahead = new Date(Date.now() + DRIVE_DECISION_MAX_CLOCK_SKEW_MS + 1000).toISOString();
    const err = await refusal(() => service.decide(id, scheduleAt(ahead), CALL));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({
      code: "VALIDATION_FAILED",
      issues: [{ path: "decided_at" }],
    });
    expect(findOwner).not.toHaveBeenCalled();
    // Within the skew is accepted.
    const nearly = new Date(Date.now() + DRIVE_DECISION_MAX_CLOCK_SKEW_MS - 1000).toISOString();
    await expect(service.decide(id, scheduleAt(nearly), CALL)).resolves.toMatchObject({
      status: "scheduled",
    });
  });

  it("an unknown or malformed id is the neutral 404", async () => {
    const { service } = world();
    for (const id of [uuid(0xdead), "not-a-uuid"]) {
      await expect(
        service.decide(id, scheduleAt("2026-11-20T05:00:00Z"), CALL),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  describe("ordering: the newest decision wins", () => {
    it("the same decision replayed is an unchanged 200: no write, no event, no audit", async () => {
      const { service, seed, table, events } = world();
      const id = await seed(COMPANY);
      const first = await service.decide(id, scheduleAt("2026-11-20T05:00:00Z"), CALL);
      const before = table.digest();
      // The same instant, written with another offset: still the same decision.
      const replay = await service.decide(id, scheduleAt("2026-11-20T10:30:00+05:30"), CALL);
      expect({ ...replay, decided_at: first.decided_at }).toEqual(first);
      expect(replay.decided_at).toBe("2026-11-20T10:30:00+05:30");
      expect(table.digest()).toBe(before);
      expect(events.emitted).toHaveLength(1);
      expect(table.audits).toHaveLength(1);
    });

    it("an OLDER decision is 409 DECISION_SUPERSEDED and stores nothing", async () => {
      const { service, seed, table, events } = world();
      const id = await seed(COMPANY);
      await service.decide(id, scheduleAt("2026-11-20T05:00:00Z"), CALL);
      const before = table.digest();
      const err = await refusal(() =>
        service.decide(id, decisionAt("declined", "2026-11-20T04:59:59.999Z"), CALL),
      );
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toEqual({ code: "DECISION_SUPERSEDED" });
      expect(table.digest()).toBe(before);
      expect(events.emitted).toHaveLength(1);
    });

    it("the same instant with a different outcome is DECISION_SUPERSEDED", async () => {
      const { service, seed } = world();
      const id = await seed(COMPANY);
      await service.decide(id, scheduleAt("2026-11-20T05:00:00Z"), CALL);
      for (const other of [
        decisionAt("declined", "2026-11-20T05:00:00Z"),
        scheduleAt("2026-11-20T05:00:00Z", { scheduled_on: "2026-12-06" }),
        scheduleAt("2026-11-20T05:00:00Z", { reason: "Morning slot" }),
      ]) {
        const err = await refusal(() => service.decide(id, other, CALL));
        expect(err.getResponse()).toEqual({ code: "DECISION_SUPERSEDED" });
      }
    });

    it("a newer reschedule replaces the date; then completion keeps it", async () => {
      const { service, seed, table, events } = world();
      const id = await seed(COMPANY);
      await service.decide(id, scheduleAt("2026-11-20T05:00:00Z"), CALL);
      await service.decide(
        id,
        scheduleAt("2026-11-20T05:10:00Z", { scheduled_on: "2026-12-09", campus_drive_ref: "d:2" }),
        CALL,
      );
      expect(table.rows[0]).toMatchObject({ scheduledOn: "2026-12-09", campusDriveRef: "d:2" });
      await service.decide(id, decisionAt("completed", "2026-11-20T05:20:00Z"), CALL);
      expect(table.rows[0]).toMatchObject({
        status: "completed",
        scheduledOn: "2026-12-09",
        campusDriveRef: "d:2",
      });
      expect(
        events.emitted.map((e) => (e.payload as { previous_status: string }).previous_status),
      ).toEqual(["requested", "scheduled", "scheduled"]);
    });
  });

  describe("transitions", () => {
    it("completed straight from requested is 409 DECISION_NOT_ALLOWED, naming the status", async () => {
      const { service, seed, table } = world();
      const id = await seed(COMPANY);
      const before = table.digest();
      const err = await refusal(() =>
        service.decide(id, decisionAt("completed", "2026-11-20T05:00:00Z"), CALL),
      );
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toEqual({ code: "DECISION_NOT_ALLOWED", status: "requested" });
      expect(table.digest()).toBe(before);
    });

    it.each([["declined"], ["completed"], ["cancelled"]] as const)(
      "nothing leaves %s",
      async (final) => {
        const { service, seed, table, events } = world();
        const id = await seed(COMPANY);
        await service.decide(id, scheduleAt("2026-11-20T05:00:00Z"), CALL);
        if (final === "declined") {
          await service.decide(id, decisionAt("declined", "2026-11-20T05:01:00Z"), CALL);
        } else if (final === "completed") {
          await service.decide(id, decisionAt("completed", "2026-11-20T05:01:00Z"), CALL);
        } else {
          Object.assign(table.rows[0]!, { status: "cancelled", cancelledAt: new Date() });
        }
        const emitted = events.emitted.length;
        for (const next of [
          scheduleAt("2026-11-20T05:30:00Z"),
          decisionAt("declined", "2026-11-20T05:30:00Z"),
          decisionAt("completed", "2026-11-20T05:30:00Z"),
        ]) {
          const err = await refusal(() => service.decide(id, next, CALL));
          expect(err.getResponse()).toEqual({ code: "DECISION_NOT_ALLOWED", status: final });
        }
        expect(events.emitted).toHaveLength(emitted);
      },
    );

    it("a late retry of the decision the company then cancelled is NOT_ALLOWED, not a replay", async () => {
      const { service, seed, table } = world();
      const id = await seed(COMPANY);
      await service.decide(id, scheduleAt("2026-11-20T05:00:00Z"), CALL);
      Object.assign(table.rows[0]!, { status: "cancelled", cancelledAt: new Date() });
      const err = await refusal(() => service.decide(id, scheduleAt("2026-11-20T05:00:00Z"), CALL));
      expect(err.getResponse()).toEqual({ code: "DECISION_NOT_ALLOWED", status: "cancelled" });
    });
  });

  it("a request owner tenancy refuses (org tenancy `on`, no usable org) reads as not live: 404", async () => {
    const table = new MemoryDriveRequests();
    const pii = testPii();
    const denied = {
      resolve: async () => {
        throw new ForbiddenException("Not permitted for this organization");
      },
    };
    const service = new CampusDriveDecisionsService(
      table.asRepository(),
      rolloutWith({ CAMPUS_DRIVE_REQUESTS_ROLLOUT: "pilot" }, [COMPANY]),
      denied as never,
      pii,
      capturingEvents().service as unknown as EventsService,
    );
    const row = await table.insert(undefined, {
      payerId: COMPANY as TenantKey,
      createdBy: COMPANY,
      jobPostingId: null,
      branchIds: [],
      preferredFrom: "2026-12-01",
      preferredTo: "2026-12-02",
      openings: 1,
      rolesNote: null,
      contactNameEnc: pii.encrypt(CONTACT_NAME),
      contactPhoneEnc: pii.encrypt(CONTACT_PHONE),
      isTest: false,
      idempotencyKey: "seed-key-0001",
    });
    await expect(
      service.decide(row!.id, scheduleAt("2026-11-20T05:00:00Z"), CALL),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect((await service.list(CampusDriveRequestsQuerySchema.parse({}))).drive_requests).toEqual(
      [],
    );
  });

  it("under org tenancy `on` a company is live by its anchor's pilot place", async () => {
    const MEMBER = uuid(0x27460d09);
    const table = new MemoryDriveRequests();
    const pii = testPii();
    table.companyNames.set(MEMBER, pii.encrypt("Member Login"));
    const service = new CampusDriveDecisionsService(
      table.asRepository(),
      rolloutWith({ CAMPUS_DRIVE_REQUESTS_ROLLOUT: "pilot" }, [COMPANY]),
      resolverOver(loadServerConfig({ NODE_ENV: "test", PAYER_ORG_TENANCY_MODE: "on" }), [
        { anchor: COMPANY, members: [MEMBER] },
      ]),
      pii,
      capturingEvents().service as unknown as EventsService,
    );
    // A row stored under the member's own id (written while tenancy was `off`).
    await table.insert(undefined, {
      payerId: MEMBER as TenantKey,
      createdBy: MEMBER,
      jobPostingId: null,
      branchIds: [],
      preferredFrom: "2026-12-01",
      preferredTo: "2026-12-02",
      openings: 1,
      rolesNote: null,
      contactNameEnc: pii.encrypt(CONTACT_NAME),
      contactPhoneEnc: pii.encrypt(CONTACT_PHONE),
      isTest: false,
      idempotencyKey: "seed-key-0001",
    });
    expect(
      (await service.list(CampusDriveRequestsQuerySchema.parse({}))).drive_requests,
    ).toHaveLength(1);
  });
});
