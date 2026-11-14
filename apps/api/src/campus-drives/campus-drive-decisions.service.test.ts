import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { validateEvent } from "@badabhai/event-schema";
import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import type { TenantKey } from "../payers/payer-tenant-scope";
import {
  CAMPUS_EARLIEST_DECISION_TIME,
  CAMPUS_MAX_CLOCK_SKEW_MS,
  CampusDriveDecisionBodySchema,
  CampusDriveRequestPageSchema,
  CampusDriveRequestsQuerySchema,
} from "../campus-link/campus-link.contract";
import { CampusDriveDecisionsService } from "./campus-drive-decisions.service";
import type { DriveCompanyColumns, DriveRequestInsert } from "./campus-drive-requests.repository";
import {
  MemoryDriveRequests,
  capturingEvents,
  testPii,
  uuid,
} from "./campus-drive-requests.test-support";

const CTX: RequestContext = { correlationId: uuid(0x27460d01), requestId: "drive-decision-unit" };
const CALL = { ctx: CTX, callId: uuid(0x27460d02) };
const COMPANY = uuid(0x27460d03);
const OTHER_COMPANY = uuid(0x27460d04);
const STAFF = "9A8B7C6D-5E4F-4A3B-8C2D-1E0F9A8B7C6D";

const CONTACT_NAME = "Ravi Sharma";
const CONTACT_PHONE = "+919812345678";
const NOTE = "CNC operators and setters";
const REASON = "No campus slot this month, sorry";

/** The service has no rollout switch and no tenancy: only the table, crypto and events. */
function world() {
  const table = new MemoryDriveRequests();
  const pii = testPii();
  table.companyNames.set(COMPANY, pii.encrypt(" Sharma Precision Works "));
  table.companyNames.set(OTHER_COMPANY, pii.encrypt("Other Fabricators"));
  const events = capturingEvents();
  const service = new CampusDriveDecisionsService(
    table.asRepository(),
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

const feed = (query: Record<string, string> = {}) => CampusDriveRequestsQuerySchema.parse(query);

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
  // 06:00 UTC = 11:30 IST on 20 Nov 2026.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-20T06:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("no rollout switch on Campus's routes (owner ruling R1: the switch gates NEW requests only)", () => {
  it("the service takes no switch and no tenancy: whatever the switch says, existing requests are listed and decided", async () => {
    // Its constructor is (repository, crypto, events): there is nothing to turn off here.
    expect(CampusDriveDecisionsService.length).toBe(3);
    const { service, seed } = world();
    const a = await seed(COMPANY);
    const b = await seed(OTHER_COMPANY);
    const page = await service.list(feed());
    expect(page.drive_requests.map((r) => r.id)).toEqual([a, b]);
    await expect(
      service.decide(b, scheduleAt("2026-11-20T05:00:00Z"), CALL),
    ).resolves.toMatchObject({ status: "scheduled" });
  });

  it("the feed skips nothing, so the cursor never moves past a row Campus has not been shown", async () => {
    const { service, seed } = world();
    const ids = [await seed(COMPANY), await seed(OTHER_COMPANY), await seed(COMPANY)];
    const first = await service.list(feed({ limit: "2" }));
    expect(first.drive_requests.map((r) => r.id)).toEqual(ids.slice(0, 2));
    const second = await service.list(feed({ limit: "2", cursor: first.next_cursor! }));
    expect(second.drive_requests.map((r) => r.id)).toEqual(ids.slice(2));
    expect(second.next_cursor).toBeNull();
  });

  it("a cancellation and an erasure reach the feed", async () => {
    const { service, seed, table } = world();
    const cancelled = await seed(COMPANY);
    const erased = await seed(COMPANY);
    const before = await service.list(feed());
    const since = before.drive_requests.at(-1)!.changed_at;
    await table.markCancelled(undefined, cancelled);
    table.eraseContact(erased);
    const after = await service.list(feed({ changed_since: since }));
    const byId = new Map(after.drive_requests.map((r) => [r.id, r]));
    expect(byId.get(cancelled)?.status).toBe("cancelled");
    expect(byId.get(erased)?.contact).toBeNull();
  });
});

describe("GET drive-requests", () => {
  it("each item parses against the contract and carries the contact, decrypted, for the placement team", async () => {
    const { service, seed } = world();
    const id = await seed(COMPANY, { isTest: true });
    const page = await service.list(feed());
    expect(CampusDriveRequestPageSchema.safeParse(page).success).toBe(true);
    expect(page.drive_requests[0]).toMatchObject({
      id,
      company: { id: COMPANY, name: "Sharma Precision Works" },
      company_withdrawn: false,
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

  it("filters by status and changed_since, and refuses a cursor it did not mint", async () => {
    const { service, seed } = world();
    const a = await seed(COMPANY);
    await seed(COMPANY);
    await service.decide(a, scheduleAt("2026-11-20T05:00:00Z"), CALL);
    const scheduled = await service.list(feed({ status: "scheduled" }));
    expect(scheduled.drive_requests.map((r) => r.id)).toEqual([a]);
    const since = await service.list(feed({ changed_since: "2099-01-01T00:00:00Z" }));
    expect(since.drive_requests).toEqual([]);
    const err = await refusal(() => service.list(feed({ cursor: "not-a-cursor" })));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it.each([["0000-01-01T00:00:00Z"], ["1970-01-01T00:00:00Z"], ["2025-12-31T23:59:59Z"]])(
    "a changed_since of %s is CLAMPED to the 2026-01-01 floor before SQL, never refused",
    async (early) => {
      const { service, seed, table } = world();
      const id = await seed(COMPANY);
      const listFeed = vi.spyOn(table, "listFeed");
      const page = await service.list(feed({ changed_since: early }));
      expect(page.drive_requests.map((r) => r.id)).toEqual([id]);
      expect(listFeed.mock.calls[0]![0].changedSince).toBe(CAMPUS_EARLIEST_DECISION_TIME);
    },
  );

  it("a changed_since at or after the floor reaches SQL as sent", async () => {
    const { service, table } = world();
    const listFeed = vi.spyOn(table, "listFeed");
    await service.list(feed({ changed_since: "2026-11-01T00:00:00+05:30" }));
    expect(listFeed.mock.calls[0]![0].changedSince).toBe("2026-11-01T00:00:00+05:30");
  });
});

describe("withdrawn from Campus (owner ruling R2)", () => {
  const ACTIVE_VERIFIED: DriveCompanyColumns = {
    companyStatus: "active",
    companyRole: "employer",
    companyVerification: "verified",
    companyHasGst: true,
  };
  const WITHDRAWALS: [string, Partial<DriveCompanyColumns>][] = [
    ["verification withdrawn (pending)", { companyVerification: "pending" }],
    ["verification rejected", { companyVerification: "rejected" }],
    ["no company record", { companyVerification: null, companyHasGst: false }],
    ["GSTIN removed", { companyHasGst: false }],
    ["account suspended", { companyStatus: "suspended" }],
    ["account archived", { companyStatus: "archived" }],
  ];

  it.each(WITHDRAWALS)(
    "%s: the feed keeps status and dates only, a decision is 409 COMPANY_WITHDRAWN; reinstated, both come back",
    async (_name, change) => {
      const { service, seed, table, events } = world();
      const id = await seed(COMPANY);
      table.standing.set(COMPANY, { ...ACTIVE_VERIFIED, ...change });

      const stripped = (await service.list(feed())).drive_requests[0]!;
      expect(
        CampusDriveRequestPageSchema.safeParse({ drive_requests: [stripped], next_cursor: null })
          .success,
      ).toBe(true);
      expect(stripped).toMatchObject({
        id,
        company_withdrawn: true,
        contact: null,
        roles_note: null,
        status: "requested",
        preferred_from: "2026-12-01",
        preferred_to: "2026-12-15",
      });
      // Nothing withdrawn reaches the wire, encrypted or not.
      expect(JSON.stringify(stripped)).not.toContain(CONTACT_NAME);
      expect(JSON.stringify(stripped)).not.toContain(NOTE);

      const before = table.digest();
      const err = await refusal(() => service.decide(id, scheduleAt("2026-11-20T05:00:00Z"), CALL));
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({ code: "COMPANY_WITHDRAWN" });
      expect(table.digest()).toBe(before);
      expect(events.emitted).toEqual([]);

      // Reinstated: the full item, and the decision goes through.
      table.standing.set(COMPANY, ACTIVE_VERIFIED);
      const restored = (await service.list(feed())).drive_requests[0]!;
      expect(restored).toMatchObject({
        company_withdrawn: false,
        contact: { name: CONTACT_NAME, phone: CONTACT_PHONE },
        roles_note: NOTE,
      });
      await expect(
        service.decide(id, scheduleAt("2026-11-20T05:00:00Z"), CALL),
      ).resolves.toMatchObject({ status: "scheduled" });
    },
  );

  it("an agency (not an employer) is withdrawn too", async () => {
    const { service, seed, table } = world();
    await seed(COMPANY);
    table.standing.set(COMPANY, { ...ACTIVE_VERIFIED, companyRole: "agent" });
    expect((await service.list(feed())).drive_requests[0]!.company_withdrawn).toBe(true);
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
      await service.list(feed());
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(table.rows[0]!.decisionReason).toBe(REASON);
    expect((events.emitted[0]!.payload as { has_reason: boolean }).has_reason).toBe(true);
    // PR 5's note cleaner: ZWNJ / ZWJ (Indic spellings) stay, a zero-width space goes.
    const ZWNJ = String.fromCharCode(0x200c);
    const ZWJ = String.fromCharCode(0x200d);
    const ZWSP = String.fromCharCode(0x200b);
    const other = await seed(COMPANY);
    await service.decide(
      other,
      decisionAt("declined", "2026-11-20T05:00:00Z", { reason: `a${ZWNJ}b${ZWJ}c${ZWSP}d` }),
      CALL,
    );
    expect(table.rows.find((r) => r.id === other)!.decisionReason).toBe(`a${ZWNJ}b${ZWJ}cd`);
    const spine = JSON.stringify([events.emitted, table.audits]);
    for (const secret of [REASON, CONTACT_NAME, "9812345678", NOTE]) {
      expect(spine).not.toContain(secret);
      for (const line of lines) expect(line).not.toContain(secret);
    }
    expect(lines.length).toBeGreaterThan(0);
  });

  it("the shared clock rule: 60 s skew, 2026-01-01 floor, both 400 before any read", async () => {
    expect(CAMPUS_MAX_CLOCK_SKEW_MS).toBe(60_000);
    const { service, seed, table } = world();
    const id = await seed(COMPANY);
    const lock = vi.spyOn(table, "lockForDecision");
    for (const early of ["2025-12-31T23:59:59.999Z", "0001-01-01T00:00:00Z"]) {
      const err = await refusal(() => service.decide(id, scheduleAt(early), CALL));
      expect(err.getResponse(), early).toMatchObject({
        code: "VALIDATION_FAILED",
        issues: [{ path: "decided_at" }],
      });
    }
    expect(lock).not.toHaveBeenCalled();
    // The floor itself is accepted (and reads the request, as any decision does).
    await expect(
      service.decide(id, scheduleAt(CAMPUS_EARLIEST_DECISION_TIME), CALL),
    ).resolves.toMatchObject({ status: "scheduled" });
    lock.mockClear();
    const ahead = new Date(Date.now() + CAMPUS_MAX_CLOCK_SKEW_MS + 1000).toISOString();
    const err = await refusal(() => service.decide(id, scheduleAt(ahead), CALL));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({
      code: "VALIDATION_FAILED",
      issues: [{ path: "decided_at" }],
    });
    expect(lock).not.toHaveBeenCalled();
    // Within the skew is accepted (a newer reschedule of the request scheduled at the floor).
    const nearly = new Date(Date.now() + CAMPUS_MAX_CLOCK_SKEW_MS - 1000).toISOString();
    await expect(service.decide(id, scheduleAt(nearly), CALL)).resolves.toMatchObject({
      status: "scheduled",
    });
  });

  it("scheduled_on runs from today in India to a year after it; anything else is 400 before any read", async () => {
    const { service, seed, table } = world();
    const id = await seed(COMPANY);
    const lock = vi.spyOn(table, "lockForDecision");
    for (const day of ["2026-11-19", "2027-11-21", "2099-12-05"]) {
      const err = await refusal(() =>
        service.decide(id, scheduleAt("2026-11-20T05:00:00Z", { scheduled_on: day }), CALL),
      );
      expect(err.getResponse(), day).toMatchObject({
        code: "VALIDATION_FAILED",
        issues: [{ path: "scheduled_on" }],
      });
    }
    expect(lock).not.toHaveBeenCalled();
    // Today and a year ahead are both fine.
    await expect(
      service.decide(id, scheduleAt("2026-11-20T05:00:00Z", { scheduled_on: "2026-11-20" }), CALL),
    ).resolves.toMatchObject({ scheduled_on: "2026-11-20" });
    await expect(
      service.decide(id, scheduleAt("2026-11-20T05:01:00Z", { scheduled_on: "2027-11-20" }), CALL),
    ).resolves.toMatchObject({ scheduled_on: "2027-11-20" });
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

    it("a newer reschedule replaces the date; completion, on or after that day, keeps it", async () => {
      const { service, seed, table, events } = world();
      const id = await seed(COMPANY);
      await service.decide(id, scheduleAt("2026-11-20T05:00:00Z"), CALL);
      await service.decide(
        id,
        scheduleAt("2026-11-20T05:10:00Z", { scheduled_on: "2026-12-09", campus_drive_ref: "d:2" }),
        CALL,
      );
      expect(table.rows[0]).toMatchObject({ scheduledOn: "2026-12-09", campusDriveRef: "d:2" });
      // Time passes: the drive happens on 9 Dec.
      vi.setSystemTime(new Date("2026-12-09T12:00:00.000Z"));
      await service.decide(id, decisionAt("completed", "2026-12-09T11:00:00Z"), CALL);
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

    it("completed dated before the drive's day is 409 DECISION_NOT_ALLOWED and stores nothing", async () => {
      const { service, seed, table, events } = world();
      const id = await seed(COMPANY);
      await service.decide(id, scheduleAt("2026-11-20T05:00:00Z"), CALL); // the drive is on 5 Dec
      const before = table.digest();
      const err = await refusal(() =>
        service.decide(id, decisionAt("completed", "2026-11-20T05:30:00Z"), CALL),
      );
      expect(err.getResponse()).toMatchObject({
        code: "DECISION_NOT_ALLOWED",
        status: "scheduled",
        message: "completed before the drive's scheduled_on",
      });
      expect(table.digest()).toBe(before);
      expect(events.emitted).toHaveLength(1);
    });

    it.each([["declined"], ["completed"], ["cancelled"]] as const)(
      "nothing leaves %s",
      async (final) => {
        const { service, seed, table, events } = world();
        const id = await seed(COMPANY);
        // A drive dated today, so it can be completed today.
        await service.decide(
          id,
          scheduleAt("2026-11-20T05:00:00Z", { scheduled_on: "2026-11-20" }),
          CALL,
        );
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
});
