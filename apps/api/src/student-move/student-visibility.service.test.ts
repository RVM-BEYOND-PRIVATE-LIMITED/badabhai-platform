import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { StudentVisibilityService } from "./student-visibility.service";
import type { MovedStudentRow } from "./student-visibility.repository";

/**
 * #2887 — the moved students' visibility switch: 404 while the switch is off; a change writes its
 * rows, ONE audit row and its event in one transaction, then rebuilds each changed student's reach;
 * a repeat changes nothing; a missing table is a 503.
 */

const ADMIN = "ad000000-0000-4000-8000-000000000001";
const WORKER = "22222222-2222-4222-8222-222222222222";
const OTHER = "22222222-2222-4222-8222-222222222223";
const BATCH = "33333333-3333-4333-8333-333333333333";
const CTX = { correlationId: "corr", requestId: "req" } as never;

const ROW: MovedStudentRow = {
  workerId: WORKER,
  visible: true,
  batchId: BATCH,
  branch: "Pune",
  course: "Diploma in CAD",
  changedAt: new Date("2026-11-17T10:00:00Z"),
  createdAt: new Date("2026-11-17T09:00:00Z"),
};

function harness(opts: { on?: boolean; changed?: string[]; found?: boolean; txError?: unknown } = {}) {
  const tx = { tx: true };
  const repo = {
    withTransaction: vi.fn(async (work: (t: unknown) => Promise<unknown>) => {
      if (opts.txError) throw opts.txError;
      return work(tx);
    }),
    findOne: vi.fn(async () => (opts.found === false ? undefined : ROW)),
    set: vi.fn(async () => opts.changed ?? [WORKER]),
    audit: vi.fn(async () => undefined),
    list: vi.fn(async () => [] as MovedStudentRow[]),
  };
  const events = { emit: vi.fn(async () => undefined) };
  const workerSkills = { rebuildQuietly: vi.fn(async () => undefined) };
  const service = new StudentVisibilityService(
    repo as never,
    events as never,
    workerSkills as never,
    { STUDENT_MOVE_ENABLED: opts.on ?? true },
  );
  return { service, repo, events, workerSkills, tx };
}

const eventsNamed = (h: ReturnType<typeof harness>) =>
  h.events.emit.mock.calls.map((c) => (c as unknown[])[0] as Record<string, unknown>);

describe("StudentVisibilityService — the switch", () => {
  it("off: every method is a 404 that reads nothing", async () => {
    const h = harness({ on: false });
    await expect(h.service.list({ limit: 10 })).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      h.service.setOne(ADMIN, WORKER, { visible: true, reason: "x" }, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      h.service.setBulk(ADMIN, { kind: "batch", batchId: BATCH }, { visible: true, reason: "x" }, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.repo.withTransaction).not.toHaveBeenCalled();
    expect(h.repo.list).not.toHaveBeenCalled();
  });

  it("a missing table is a 503, never a guessed success", async () => {
    const h = harness({ txError: Object.assign(new Error("no table"), { code: "42P01" }) });
    await expect(
      h.service.setOne(ADMIN, WORKER, { visible: true, reason: "x" }, CTX),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe("StudentVisibilityService.setOne", () => {
  it("a worker who was never moved is a 404, nothing written", async () => {
    const h = harness({ found: false });
    await expect(
      h.service.setOne(ADMIN, WORKER, { visible: true, reason: "x" }, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.repo.set).not.toHaveBeenCalled();
  });

  it("on: the row, one audit row and the event on the same transaction, then his reach rebuilt", async () => {
    const h = harness();
    const out = await h.service.setOne(ADMIN, WORKER, { visible: true, reason: "Placement ok" }, CTX);
    expect(out).toEqual({ student: ROW, changed: true });
    expect(h.repo.set).toHaveBeenCalledWith(
      h.tx,
      { kind: "worker", workerId: WORKER },
      { visible: true, adminId: ADMIN, reason: "Placement ok" },
    );
    expect(h.repo.audit).toHaveBeenCalledWith(h.tx, {
      adminId: ADMIN,
      action: "student_visibility_changed",
      entityType: "worker",
      entityId: WORKER,
      metadata: { visible: true, reason_text: "Placement ok" },
    });
    expect(eventsNamed(h)).toEqual([
      expect.objectContaining({
        event_name: "admin.student_visibility_changed",
        actor: { actor_type: "admin", actor_id: ADMIN },
        subject: { subject_type: "worker", subject_id: WORKER },
        payload: { worker_id: WORKER, visible: true },
        tx: h.tx,
      }),
    ]);
    expect(h.workerSkills.rebuildQuietly).toHaveBeenCalledWith(WORKER, CTX);
  });

  it("a repeat changes nothing: no audit row, no event, no rebuild", async () => {
    const h = harness({ changed: [] });
    const out = await h.service.setOne(ADMIN, WORKER, { visible: true, reason: "again" }, CTX);
    expect(out.changed).toBe(false);
    expect(h.repo.audit).not.toHaveBeenCalled();
    expect(h.events.emit).not.toHaveBeenCalled();
    expect(h.workerSkills.rebuildQuietly).not.toHaveBeenCalled();
  });
});

describe("StudentVisibilityService.setBulk", () => {
  it("one import run: one audit row and one event with the count, then each changed student rebuilt", async () => {
    const h = harness({ changed: [WORKER, OTHER] });
    const out = await h.service.setBulk(
      ADMIN,
      { kind: "batch", batchId: BATCH },
      { visible: true, reason: "Batch 1 approved" },
      CTX,
    );
    expect(out).toEqual({ changed: 2 });
    expect(h.repo.audit).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({
        action: "student_visibility_bulk_changed",
        entityType: "student_visibility_bulk",
        metadata: expect.objectContaining({ selector: "batch", batch_id: BATCH, changed: 2 }),
      }),
    );
    expect(eventsNamed(h)).toEqual([
      expect.objectContaining({
        event_name: "admin.student_visibility_bulk_changed",
        subject: { subject_type: "admin_session", subject_id: ADMIN },
        payload: { selector: "batch", batch_id: BATCH, visible: true, changed: 2 },
      }),
    ]);
    expect(h.workerSkills.rebuildQuietly.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      WORKER,
      OTHER,
    ]);
  });

  it("a branch carries its name on the audit row only, never on the event", async () => {
    const h = harness({ changed: [] });
    await h.service.setBulk(ADMIN, { kind: "branch", branch: "Pune" }, { visible: false, reason: "x" }, CTX);
    expect(h.repo.audit).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({ metadata: expect.objectContaining({ branch: "Pune", changed: 0 }) }),
    );
    expect(eventsNamed(h)[0]!.payload).toEqual({
      selector: "branch",
      batch_id: null,
      visible: false,
      changed: 0,
    });
  });
});

describe("StudentVisibilityService.list", () => {
  it("pages newest first: one extra row read means a next cursor", async () => {
    const h = harness();
    h.repo.list.mockResolvedValue([ROW, { ...ROW, workerId: OTHER }]);
    const page = await h.service.list({ batchId: BATCH, visible: true, limit: 1 });
    expect(h.repo.list).toHaveBeenCalledWith({ batchId: BATCH, visible: true, after: null, limit: 2 });
    expect(page.students).toEqual([ROW]);
    expect(page.nextCursor).not.toBeNull();
  });
});
