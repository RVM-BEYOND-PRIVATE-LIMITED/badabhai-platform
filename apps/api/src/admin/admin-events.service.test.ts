import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { createEvent, validateEvent, type CreateEventInput } from "@badabhai/event-schema";
import type { EventRow } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import { AdminEventsService } from "./admin-events.service";
import type {
  AdminEventsRepository,
  CountBucket,
  DayBucket,
} from "./admin-events.repository";
import { decodeCursor } from "./admin-events.cursor";
import {
  ADMIN_EVENTS_PAGE_DEFAULT,
  type AdminEventsQueryDto,
  type AdminExportQueryDto,
  type AdminMetricsQueryDto,
} from "./admin-events.dto";

const CTX: RequestContext = { requestId: "req-1", correlationId: "11111111-1111-1111-1111-111111111111" };

/** A representative spine row. NOTE the payload carries ONLY ids/codes (PII-free by registry). */
function row(over: Partial<EventRow> = {}): EventRow {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    eventName: "consent.accepted",
    eventVersion: 1,
    occurredAt: new Date("2026-06-27T10:00:00.000Z"),
    actorType: "worker",
    actorId: "33333333-3333-3333-3333-333333333333",
    subjectType: "consent",
    subjectId: "44444444-4444-4444-4444-444444444444",
    correlationId: CTX.correlationId,
    causationId: null,
    idempotencyKey: null,
    payload: { worker_id: "33333333-3333-3333-3333-333333333333" },
    metadata: { environment: "test", service: "api", request_id: "req-1" },
    createdAt: new Date("2026-06-27T10:00:01.000Z"),
    ...over,
  };
}

interface Mocks {
  repo: {
    listKeyset: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    traceByCorrelation: ReturnType<typeof vi.fn>;
    listForExport: ReturnType<typeof vi.fn>;
    countByEventName: ReturnType<typeof vi.fn>;
    countByDay: ReturnType<typeof vi.fn>;
    countByActorType: ReturnType<typeof vi.fn>;
    eventNameStats: ReturnType<typeof vi.fn>;
  };
  events: { emit: ReturnType<typeof vi.fn> };
  service: AdminEventsService;
}

function make(): Mocks {
  const repo = {
    listKeyset: vi.fn(),
    findById: vi.fn(),
    traceByCorrelation: vi.fn(),
    listForExport: vi.fn(),
    countByEventName: vi.fn(async (): Promise<CountBucket[]> => []),
    countByDay: vi.fn(async (): Promise<DayBucket[]> => []),
    countByActorType: vi.fn(async (): Promise<CountBucket[]> => []),
    eventNameStats: vi.fn(async () => ({ count: 0, distinctSubjects: 0 })),
  };
  const events = { emit: vi.fn(async () => undefined) };
  const service = new AdminEventsService(
    repo as unknown as AdminEventsRepository,
    events as unknown as EventsService,
  );
  return { repo, events, service };
}

const listDto = (over: Partial<AdminEventsQueryDto> = {}): AdminEventsQueryDto => ({
  limit: ADMIN_EVENTS_PAGE_DEFAULT,
  ...over,
});

// PII-shaped keys that must NEVER appear in any projected response.
const PII_KEYS = ["phone", "name", "full_name", "email", "address", "resume_text", "otp", "password"];
function assertNoPiiKeys(obj: unknown): void {
  const seen = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v)) {
        seen.add(k.toLowerCase());
        walk(val);
      }
    }
  };
  walk(obj);
  for (const bad of PII_KEYS) expect([...seen]).not.toContain(bad);
}

describe("AdminEventsService — keyset pagination + cursor", () => {
  let m: Mocks;
  beforeEach(() => (m = make()));

  it("returns a page + opaque next-cursor when there is more (fetches limit+1)", async () => {
    // limit=2 → service asks for 3; repo returns 3 → hasMore.
    const rows = [
      row({ id: "a", occurredAt: new Date("2026-06-27T12:00:00Z") }),
      row({ id: "b", occurredAt: new Date("2026-06-27T11:00:00Z") }),
      row({ id: "c", occurredAt: new Date("2026-06-27T10:00:00Z") }),
    ];
    m.repo.listKeyset.mockResolvedValue(rows);
    const res = await m.service.list(listDto({ limit: 2 }));

    expect(m.repo.listKeyset).toHaveBeenCalledWith(expect.any(Object), 3, null);
    expect(res.events).toHaveLength(2); // capped to limit, the extra row is dropped
    expect(res.nextCursor).not.toBeNull();
    // The cursor points at the LAST returned row (b) — the keyset boundary.
    expect(decodeCursor(res.nextCursor!)).toEqual({
      occurredAt: new Date("2026-06-27T11:00:00Z").toISOString(),
      id: "b",
    });
  });

  it("returns nextCursor=null on the last page (fewer than limit+1 rows)", async () => {
    m.repo.listKeyset.mockResolvedValue([row({ id: "a" })]);
    const res = await m.service.list(listDto({ limit: 50 }));
    expect(res.nextCursor).toBeNull();
  });

  it("threads an incoming cursor through to the repository keyset", async () => {
    m.repo.listKeyset.mockResolvedValue([]);
    const cursor = Buffer.from('{"o":"2026-06-27T09:00:00.000Z","i":"x"}', "utf8").toString("base64url");
    await m.service.list(listDto({ cursor, limit: 10 }));
    expect(m.repo.listKeyset).toHaveBeenCalledWith(
      expect.any(Object),
      11,
      { occurredAt: "2026-06-27T09:00:00.000Z", id: "x" },
    );
  });
});

describe("AdminEventsService — PII-free projections (faceless)", () => {
  let m: Mocks;
  beforeEach(() => (m = make()));

  it("list items expose ONLY spine fields (no payload/metadata, no PII keys)", async () => {
    m.repo.listKeyset.mockResolvedValue([row()]);
    const res = await m.service.list(listDto());
    const item = res.events[0]!;
    expect(Object.keys(item).sort()).toEqual(
      [
        "actor_id",
        "actor_type",
        "causation_id",
        "correlation_id",
        "event_name",
        "event_version",
        "id",
        "occurred_at",
        "subject_id",
        "subject_type",
      ].sort(),
    );
    expect(item).not.toHaveProperty("payload");
    expect(item).not.toHaveProperty("metadata");
    assertNoPiiKeys(item);
  });

  it("timeline projection is faceless + has no PII keys", async () => {
    m.repo.listKeyset.mockResolvedValue([row({ subjectType: "worker", subjectId: "w-1" })]);
    const res = await m.service.timeline("worker", "55555555-5555-5555-5555-555555555555", { limit: 50 });
    expect(res.subject_type).toBe("worker");
    expect(res.events[0]).not.toHaveProperty("payload");
    assertNoPiiKeys(res);
  });

  it("detail returns the (already PII-free) payload + metadata", async () => {
    m.repo.findById.mockResolvedValue(row());
    const res = await m.service.getById("22222222-2222-2222-2222-222222222222");
    expect(res.payload).toEqual({ worker_id: "33333333-3333-3333-3333-333333333333" });
    expect(res).toHaveProperty("metadata");
    assertNoPiiKeys(res); // worker_id is an opaque id, not a PII-shaped key
  });

  it("getById 404s on a missing event", async () => {
    m.repo.findById.mockResolvedValue(undefined);
    await expect(m.service.getById("nope")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("trace returns the causal chain (with causation linkage) for a correlation id", async () => {
    m.repo.traceByCorrelation.mockResolvedValue([
      row({ id: "e1", causationId: null }),
      row({ id: "e2", causationId: "e1" }),
    ]);
    const res = await m.service.trace(CTX.correlationId);
    expect(res.correlation_id).toBe(CTX.correlationId);
    expect(res.events.map((e) => e.causation_id)).toEqual([null, "e1"]);
    assertNoPiiKeys(res);
  });
});

describe("AdminEventsService — metrics k-anon floor", () => {
  let m: Mocks;
  beforeEach(() => (m = make()));

  const metricsDto: AdminMetricsQueryDto = { windowDays: 30 };

  it("SUPPRESSES a funnel stage whose distinct-subject count is below the floor", async () => {
    // contact.revealed reached by ONE distinct worker → below K_ANON_FLOOR (5) → floored to 0.
    m.repo.eventNameStats.mockImplementation(async (name: string) => {
      if (name === "contact.revealed") return { count: 1, distinctSubjects: 1 };
      return { count: 100, distinctSubjects: 40 };
    });
    const res = await m.service.metrics(metricsDto);
    const revealed = res.funnel.find((f) => f.event_name === "contact.revealed")!;
    expect(revealed.distinct_subjects).toBe(0);
    expect(revealed.suppressed).toBe(true);
    // A stage at/above the floor is shown verbatim.
    const shown = res.funnel.find((f) => f.event_name === "feed.shown")!;
    expect(shown.distinct_subjects).toBe(40);
    expect(shown.suppressed).toBe(false);
    expect(res.k_anon_floor).toBe(AdminEventsService.K_ANON_FLOOR);
  });

  it("does NOT suppress a zero-subject stage (nothing to single out)", async () => {
    m.repo.eventNameStats.mockResolvedValue({ count: 0, distinctSubjects: 0 });
    const res = await m.service.metrics(metricsDto);
    expect(res.funnel.every((f) => f.suppressed === false)).toBe(true);
  });

  it("surfaces breach counters from the by-event-name aggregate (0 when absent)", async () => {
    m.repo.countByEventName.mockResolvedValue([
      { key: "ai.spend_cap_exceeded", count: 3 },
      { key: "consent.accepted", count: 99 },
    ]);
    const res = await m.service.metrics(metricsDto);
    const spend = res.breaches.find((b) => b.key === "ai.spend_cap_exceeded")!;
    const pace = res.breaches.find((b) => b.key === "pace.ops_alert_raised")!;
    expect(spend.count).toBe(3);
    expect(pace.count).toBe(0);
  });
});

describe("AdminEventsService — export emits a PII-free admin.action_performed", () => {
  let m: Mocks;
  beforeEach(() => (m = make()));

  const exportDto = (over: Partial<AdminExportQueryDto> = {}): AdminExportQueryDto => ({
    format: "json",
    limit: 100,
    ...over,
  });

  it("returns the PII-free rows + emits an audited export event that VALIDATES against the registry", async () => {
    m.repo.listForExport.mockResolvedValue([row()]);
    const adminId = "66666666-6666-6666-6666-666666666666";
    const res = await m.service.export(adminId, exportDto({ eventName: ["consent.accepted"] }), CTX);

    expect(res.count).toBe(1);
    expect(res.rows[0]).not.toHaveProperty("payload");
    assertNoPiiKeys(res.rows);

    // Exactly one audit event, and it is the registered admin.action_performed.
    expect(m.events.emit).toHaveBeenCalledTimes(1);
    const params = m.events.emit.mock.calls[0]![0] as CreateEventInput<"admin.action_performed"> & {
      correlationId: string;
      requestId: string;
    };
    expect(params.event_name).toBe("admin.action_performed");
    expect(params.payload).toMatchObject({
      admin_id: adminId,
      action_code: "events.export",
      target_type: "events",
    });
    // Rebuild the full event the way EventsService would, then validate against the registry.
    const built = createEvent({
      event_name: "admin.action_performed",
      actor: params.actor,
      subject: params.subject,
      payload: params.payload,
      source: "api",
      correlation_id: params.correlationId,
      causation_id: null,
      metadata: { environment: "test", service: "api", request_id: params.requestId },
    });
    const result = validateEvent(built);
    expect(result.success).toBe(true);
    // The audit payload carries NO filter VALUE / PII — codes + an opaque target id only.
    assertNoPiiKeys(params.payload);
    expect(params.payload.target_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("the export target_id is DETERMINISTIC for the same filter, DIFFERENT for another", async () => {
    m.repo.listForExport.mockResolvedValue([]);
    const adminId = "66666666-6666-6666-6666-666666666666";
    await m.service.export(adminId, exportDto({ eventName: ["a"] }), CTX);
    await m.service.export(adminId, exportDto({ eventName: ["a"] }), CTX);
    await m.service.export(adminId, exportDto({ eventName: ["b"] }), CTX);
    const ids = m.events.emit.mock.calls.map(
      (c) => (c[0] as { payload: { target_id: string } }).payload.target_id,
    );
    expect(ids[0]).toBe(ids[1]); // same filter → same opaque id
    expect(ids[0]).not.toBe(ids[2]); // different filter → different id
  });
});
