import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditLogs,
  createDbClient,
  events,
  workerConsents,
  workerInstituteLinks,
  workerOrigins,
  workers,
  type DbClient,
} from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { WorkersRepository } from "../workers/workers.repository";
import { InstituteLinkRepository, INSTITUTE_LINK_AUDIT_ACTIONS } from "./institute-link.repository";
import { InstituteLinkService, StudentNotAvailableError } from "./institute-link.service";
import {
  RvmStudentApiUnavailableError,
  type RvmStudentApiClient,
  type RvmStudentLookup,
  type RvmStudentRead,
} from "./rvm-student-api.client";

/**
 * #2752 part B — the student link's POSTGRES contract:
 *   - a consenting student becomes one `pending` worker (encrypted name and phone), one active
 *     link with the agreed facts, an `institute` origin and one ids-only `worker.institute_linked`;
 *     no `worker_consents` row and no `worker.created`;
 *   - a repeat is idempotent; a refusal or an RVM outage creates nothing;
 *   - a phone that already belongs to a BadaBhai worker links THAT row and keeps his name;
 *   - RVM's phone change moves only a never-signed-in row; anything else is a manual case;
 *   - a second reference on one phone, or a suspended worker, is refused as a manual case;
 *   - the worker cascade erases the link and the origin.
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function assertLocalDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`institute-link.db refuses to write to a non-local host (${host})`);
  }
}

const CTX: RequestContext = { correlationId: randomUUID(), requestId: "institute-link-db" };

/** A fresh, real-shaped mobile (6–9 then nine digits), unique enough for one run. */
const phone10 = () => `9${String(randomInt(0, 1_000_000_000)).padStart(9, "0")}`;

function student(overrides: Partial<RvmStudentRead> = {}): RvmStudentRead {
  return {
    name: "Test Student",
    phone: phone10(),
    course: "CNC Programming",
    branch: "Faridabad",
    status: "current_student",
    test_score: 72.5,
    ...overrides,
  };
}

describe.skipIf(!RUN)("#2752 institute link — against Postgres", () => {
  let client!: DbClient;
  let pii!: PiiCryptoService;
  let workersRepo!: WorkersRepository;
  let service!: InstituteLinkService;
  /** What the fake Student API answers next, per reference (a queue answers one item per call). */
  const answers = new Map<string, RvmStudentLookup | Error | RvmStudentLookup[]>();

  beforeAll(() => {
    assertLocalDatabase(DATABASE_URL);
    client = createDbClient(DATABASE_URL, { max: 4 });
    const eventsService = new EventsService(new EventsRepository(client.db), {
      NODE_ENV: "test",
    } as never);
    pii = new PiiCryptoService({
      PII_HASH_PEPPER: "institute-link-test-pepper",
      PII_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
      PIN_PEPPER: "institute-link-test-pin",
    } as never);
    workersRepo = new WorkersRepository(client.db);
    const rvm = {
      readStudent: async (ref: string) => {
        const stored = answers.get(ref);
        const answer = Array.isArray(stored) ? stored.shift() : stored;
        if (answer === undefined) throw new Error(`no fake answer for ${ref}`);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    } as unknown as RvmStudentApiClient;
    service = new InstituteLinkService(
      new InstituteLinkRepository(client.db),
      workersRepo,
      rvm,
      pii,
      eventsService,
      { RVM_CONSENT_RECHECK_SECONDS: 300 } as never,
    );
  });

  afterAll(async () => {
    if (!client) return;
    try {
      await client.sql`DELETE FROM events WHERE correlation_id = ${CTX.correlationId}::uuid`;
      for (const id of touched) {
        await client.sql`DELETE FROM audit_logs WHERE entity_id = ${id}::uuid`;
        await client.sql`DELETE FROM workers WHERE id = ${id}::uuid`;
      }
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  });

  /** Every worker a test made or linked; the cascade takes its link and origin with it. */
  const touched = new Set<string>();
  const track = <T extends { workerId: string } | { id: string }>(row: T): T => {
    touched.add("workerId" in row ? row.workerId : row.id);
    return row;
  };

  const hashOf = (p10: string) => pii.hashPhone(`+91${p10}`);
  const linkOf = async (workerId: string) =>
    (
      await client.db
        .select()
        .from(workerInstituteLinks)
        .where(eq(workerInstituteLinks.workerId, workerId))
    )[0];
  const workerOf = async (workerId: string) =>
    (await client.db.select().from(workers).where(eq(workers.id, workerId)))[0]!;
  const eventsOf = (workerId: string, name: string) =>
    client.db
      .select()
      .from(events)
      .where(and(eq(events.subjectId, workerId), eq(events.eventName, name)));
  const manualCases = (workerId: string, action: string) =>
    client.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, workerId), eq(auditLogs.action, action)));

  it("links a consenting student as one pending worker, with the agreed facts and an ids-only event", async () => {
    const ref = randomUUID();
    const s = student();
    answers.set(ref, { kind: "available", student: s });

    const linked = track(await service.linkStudent(ref, CTX));

    expect(linked.workerCreated).toBe(true);
    const worker = await workerOf(linked.workerId);
    expect(worker.status).toBe("pending");
    expect(worker.phoneHash).toBe(hashOf(s.phone));
    expect(worker.phoneE164).not.toContain(s.phone);
    expect(pii.decrypt(worker.phoneE164)).toBe(`+91${s.phone}`);
    expect(pii.decrypt(worker.fullName!)).toBe("Test Student");
    expect(worker.isTestAccount).toBe(false);

    const link = await linkOf(linked.workerId);
    expect(link).toMatchObject({
      instituteCode: "rvm",
      studentRef: ref,
      status: "active",
      studentStatus: "current_student",
      course: "CNC Programming",
      branch: "Faridabad",
      testScore: "72.50",
      appReachable: false,
      withdrawnAt: null,
    });
    expect(link?.syncedAt).toBeInstanceOf(Date);

    const origin = await client.db
      .select()
      .from(workerOrigins)
      .where(eq(workerOrigins.workerId, linked.workerId));
    expect(origin).toEqual([expect.objectContaining({ kind: "institute", ref: "rvm" })]);

    const linkedEvents = await eventsOf(linked.workerId, "worker.institute_linked");
    expect(linkedEvents).toHaveLength(1);
    expect(linkedEvents[0]!.payload).toEqual({
      worker_id: linked.workerId,
      institute_code: "rvm",
      worker_created: true,
    });
    expect(JSON.stringify(linkedEvents[0])).not.toContain(s.phone);
    expect(JSON.stringify(linkedEvents[0])).not.toContain(ref);

    expect(await eventsOf(linked.workerId, "worker.created")).toHaveLength(0);
    const consents = await client.db
      .select()
      .from(workerConsents)
      .where(eq(workerConsents.workerId, linked.workerId));
    expect(consents).toHaveLength(0);
  });

  it("is idempotent: the same student again is the same worker, link and single event", async () => {
    const ref = randomUUID();
    answers.set(ref, { kind: "available", student: student() });

    const first = track(await service.linkStudent(ref, CTX));
    const again = track(await service.linkStudent(ref, CTX));

    expect(again).toEqual({ workerId: first.workerId, workerCreated: false });
    expect(await eventsOf(first.workerId, "worker.institute_linked")).toHaveLength(1);
  });

  it("stores the reference lower-cased, so one student cannot be two keys", async () => {
    const ref = randomUUID();
    answers.set(ref, { kind: "available", student: student() });

    const linked = track(await service.linkStudent(ref.toUpperCase(), CTX));

    expect((await linkOf(linked.workerId))?.studentRef).toBe(ref);
  });

  it("creates nothing when RVM refuses the student", async () => {
    const ref = randomUUID();
    answers.set(ref, { kind: "not_available" });

    await expect(service.linkStudent(ref, CTX)).rejects.toBeInstanceOf(StudentNotAvailableError);

    const rows = await client.db
      .select()
      .from(workerInstituteLinks)
      .where(eq(workerInstituteLinks.studentRef, ref));
    expect(rows).toHaveLength(0);
  });

  it("creates nothing when RVM is down, and says so as retryable", async () => {
    const ref = randomUUID();
    const s = student();
    answers.set(ref, new RvmStudentApiUnavailableError("timeout"));

    await expect(service.linkStudent(ref, CTX)).rejects.toBeInstanceOf(
      RvmStudentApiUnavailableError,
    );
    expect(await workersRepo.findByPhoneHash(hashOf(s.phone))).toBeUndefined();
  });

  it("links the BadaBhai worker who already holds the phone, keeping his own name and origin", async () => {
    const s = student();
    const own = track(
      await workersRepo.create({
        phoneE164: pii.encrypt(`+91${s.phone}`),
        phoneHash: hashOf(s.phone),
        fullName: pii.encrypt("His Own Name"),
        status: "active",
      }),
    );
    const ref = randomUUID();
    answers.set(ref, { kind: "available", student: s });

    const linked = track(await service.linkStudent(ref, CTX));

    expect(linked).toEqual({ workerId: own.id, workerCreated: false });
    const worker = await workerOf(own.id);
    expect(worker.status).toBe("active");
    expect(pii.decrypt(worker.fullName!)).toBe("His Own Name");
    const origin = await client.db
      .select()
      .from(workerOrigins)
      .where(eq(workerOrigins.workerId, own.id));
    expect(origin).toHaveLength(0);
    expect((await eventsOf(own.id, "worker.institute_linked"))[0]!.payload).toMatchObject({
      worker_created: false,
    });
  });

  it("follows RVM's phone change on a row that has never signed in", async () => {
    const ref = randomUUID();
    answers.set(ref, { kind: "available", student: student() });
    const linked = track(await service.linkStudent(ref, CTX));

    const newPhone = phone10();
    answers.set(ref, { kind: "available", student: student({ phone: newPhone }) });
    await service.linkStudent(ref, CTX);

    const worker = await workerOf(linked.workerId);
    expect(worker.phoneHash).toBe(hashOf(newPhone));
    expect(pii.decrypt(worker.phoneE164)).toBe(`+91${newPhone}`);
  });

  it("never rewrites the phone of a worker who signs in himself: a manual case instead", async () => {
    const s = student();
    const own = track(
      await workersRepo.create({
        phoneE164: pii.encrypt(`+91${s.phone}`),
        phoneHash: hashOf(s.phone),
        status: "active",
      }),
    );
    const ref = randomUUID();
    answers.set(ref, { kind: "available", student: s });
    await service.linkStudent(ref, CTX);

    answers.set(ref, { kind: "available", student: student({ phone: phone10() }) });
    await service.linkStudent(ref, CTX);

    expect((await workerOf(own.id)).phoneHash).toBe(hashOf(s.phone));
    const cases = await manualCases(own.id, INSTITUTE_LINK_AUDIT_ACTIONS.phoneMismatch);
    expect(cases).toHaveLength(1);
    expect(cases[0]!.metadata).toEqual({
      institute_code: "rvm",
      student_ref: ref,
      reason: "worker_signs_in_himself",
    });
  });

  it("refuses a second reference on one phone as a manual case, leaving the first link alone", async () => {
    const s = student();
    const firstRef = randomUUID();
    answers.set(firstRef, { kind: "available", student: s });
    const first = track(await service.linkStudent(firstRef, CTX));

    const secondRef = randomUUID();
    answers.set(secondRef, { kind: "available", student: s });
    await expect(service.linkStudent(secondRef, CTX)).rejects.toBeInstanceOf(
      StudentNotAvailableError,
    );

    expect((await linkOf(first.workerId))?.studentRef).toBe(firstRef);
    const cases = await manualCases(first.workerId, INSTITUTE_LINK_AUDIT_ACTIONS.refused);
    expect(cases.map((c) => c.metadata)).toEqual([
      { institute_code: "rvm", student_ref: secondRef, reason: "worker_linked_to_another_ref" },
    ]);
  });

  it("refuses to link a suspended worker, as a manual case", async () => {
    const s = student();
    const suspended = track(
      await workersRepo.create({
        phoneE164: pii.encrypt(`+91${s.phone}`),
        phoneHash: hashOf(s.phone),
        status: "suspended",
      }),
    );
    const ref = randomUUID();
    answers.set(ref, { kind: "available", student: s });

    await expect(service.linkStudent(ref, CTX)).rejects.toBeInstanceOf(StudentNotAvailableError);

    expect(await linkOf(suspended.id)).toBeUndefined();
    expect(await manualCases(suspended.id, INSTITUTE_LINK_AUDIT_ACTIONS.refused)).toHaveLength(1);
  });

  it("refuses, rather than refreshes, an existing link whose worker is now suspended", async () => {
    const ref = randomUUID();
    answers.set(ref, { kind: "available", student: student({ course: "Before" }) });
    const linked = track(await service.linkStudent(ref, CTX));
    await client.db
      .update(workers)
      .set({ status: "suspended" })
      .where(eq(workers.id, linked.workerId));

    answers.set(ref, { kind: "available", student: student({ course: "After" }) });
    await expect(service.linkStudent(ref, CTX)).rejects.toBeInstanceOf(StudentNotAvailableError);

    expect((await linkOf(linked.workerId))?.course).toBe("Before");
    const cases = await manualCases(linked.workerId, INSTITUTE_LINK_AUDIT_ACTIONS.refused);
    expect(cases.map((c) => (c.metadata as Record<string, string>).reason)).toEqual([
      "worker_suspended",
    ]);
  });

  it("refuses to link a worker whose deletion is scheduled, as a manual case", async () => {
    const s = student();
    const deleting = track(
      await workersRepo.create({
        phoneE164: pii.encrypt(`+91${s.phone}`),
        phoneHash: hashOf(s.phone),
        status: "active",
        deletionScheduledAt: new Date(),
      }),
    );
    const ref = randomUUID();
    answers.set(ref, { kind: "available", student: s });

    await expect(service.linkStudent(ref, CTX)).rejects.toBeInstanceOf(StudentNotAvailableError);

    expect(await linkOf(deleting.id)).toBeUndefined();
    const cases = await manualCases(deleting.id, INSTITUTE_LINK_AUDIT_ACTIONS.refused);
    expect(cases.map((c) => (c.metadata as Record<string, string>).reason)).toEqual([
      "worker_deletion_scheduled",
    ]);
  });

  it("never moves the phone of a pending row the link did not create", async () => {
    // A `pending` row with no institute origin is not one the link made: its phone is a login.
    const s = student();
    const legacy = track(
      await workersRepo.create({
        phoneE164: pii.encrypt(`+91${s.phone}`),
        phoneHash: hashOf(s.phone),
        status: "pending",
      }),
    );
    const ref = randomUUID();
    answers.set(ref, { kind: "available", student: s });
    await service.linkStudent(ref, CTX);

    answers.set(ref, { kind: "available", student: student({ phone: phone10() }) });
    await service.linkStudent(ref, CTX);

    expect((await workerOf(legacy.id)).phoneHash).toBe(hashOf(s.phone));
    expect(await manualCases(legacy.id, INSTITUTE_LINK_AUDIT_ACTIONS.phoneMismatch)).toHaveLength(
      1,
    );
  });

  it("re-activates a withdrawn link with a fresh event", async () => {
    const ref = randomUUID();
    answers.set(ref, { kind: "available", student: student() });
    const linked = track(await service.linkStudent(ref, CTX));
    await client.db
      .update(workerInstituteLinks)
      .set({ status: "withdrawn", withdrawnAt: new Date() })
      .where(eq(workerInstituteLinks.workerId, linked.workerId));

    await service.linkStudent(ref, CTX);

    expect(await linkOf(linked.workerId)).toMatchObject({ status: "active", withdrawnAt: null });
    expect(await eventsOf(linked.workerId, "worker.institute_linked")).toHaveLength(2);
  });

  it("two concurrent links of one student leave one worker and no orphan row", async () => {
    const ref = randomUUID();
    const [p1, p2] = [phone10(), phone10()];
    answers.set(ref, [
      { kind: "available", student: student({ phone: p1 }) },
      { kind: "available", student: student({ phone: p2 }) },
    ]);

    const results = await Promise.all([
      service.linkStudent(ref, CTX),
      service.linkStudent(ref, CTX),
    ]);
    results.forEach(track);

    expect(results[0]!.workerId).toBe(results[1]!.workerId);
    const holders = [
      await workersRepo.findByPhoneHash(hashOf(p1)),
      await workersRepo.findByPhoneHash(hashOf(p2)),
    ].filter((w) => w !== undefined);
    expect(holders.map((w) => w.id)).toEqual([results[0]!.workerId]);
  });

  it("his first sign-in reaches the same row, which activates once (pending → active)", async () => {
    const ref = randomUUID();
    const s = student();
    answers.set(ref, { kind: "available", student: s });
    const linked = track(await service.linkStudent(ref, CTX));

    // The sign-in path finds the worker by the same hashed +91 phone.
    expect((await workersRepo.findByPhoneHash(hashOf(s.phone)))?.id).toBe(linked.workerId);

    const moved = await workersRepo.activatePending(linked.workerId, hashOf(phone10()));
    const first = await workersRepo.activatePending(linked.workerId, hashOf(s.phone));
    const again = await workersRepo.activatePending(linked.workerId, hashOf(s.phone));

    // A sign-in with a phone the row no longer holds activates nothing.
    expect(moved).toBeUndefined();

    expect(first?.status).toBe("active");
    expect(again).toBeUndefined();
    expect((await linkOf(linked.workerId))?.status).toBe("active");
  });

  it("erases the link and the origin with the worker (DPDP cascade)", async () => {
    const ref = randomUUID();
    answers.set(ref, { kind: "available", student: student() });
    const linked = track(await service.linkStudent(ref, CTX));

    await client.db.delete(workers).where(eq(workers.id, linked.workerId));

    expect(await linkOf(linked.workerId)).toBeUndefined();
    const origin = await client.db
      .select()
      .from(workerOrigins)
      .where(eq(workerOrigins.workerId, linked.workerId));
    expect(origin).toHaveLength(0);
  });
});
