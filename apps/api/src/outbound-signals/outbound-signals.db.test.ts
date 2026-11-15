import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "@badabhai/db";
import type { ServerConfig } from "@badabhai/config";
import { PiiCryptoService } from "../common/pii-crypto.service";
import {
  RvmStudentApiUnavailableError,
  type RvmSelectionEventBody,
} from "../campus-link/rvm-student-api.client";
import { OutboundSignalsRepository } from "./outbound-signals.repository";
import { OutboundSignalsSender } from "./outbound-signals.sender";
import { OutboundSignalsService } from "./outbound-signals.service";

/**
 * #2747 item 8 — `outbound_signals` (migration 0167) against a real Postgres.
 *
 * The unit suites prove the recorder and the sender SAY the right thing. Only a database proves:
 *  - a mark on an actively linked RVM student queues ONE row, ids only, in the caller's
 *    transaction (a rollback takes it away), and the unique key makes a repeat a no-op;
 *  - a BadaBhai worker and a withdrawn link queue nothing;
 *  - the sender claims due rows (SKIP LOCKED: two senders never take one row), builds the body
 *    from the database at send time (the decrypted company name, the posting title, the student
 *    ref), and records delivered / retried / cancelled on the row;
 *  - the CHECKs refuse an unknown status or failure code and a delivered row with no date;
 *  - erasure: deleting the worker deletes his signals (the FK cascade).
 *
 * Fixtures carry no real PII: a synthetic company name, encrypted with a test key.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api exec vitest run outbound-signals.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

const TAG = randomUUID().slice(0, 8);
const PAYER = randomUUID();
const OPS = randomUUID();
const POSTING = randomUUID();
const JOB = randomUUID();
const STUDENT = randomUUID();
const STUDENT_2 = randomUUID();
const STUDENT_3 = randomUUID();
const LEAVER = randomUUID();
const OUTSIDER = randomUUID();
const ERASED = randomUUID();
const WORKERS = [STUDENT, STUDENT_2, STUDENT_3, LEAVER, OUTSIDER, ERASED];
const STUDENT_REF = randomUUID();
const COMPANY = `Sharma Precision Works ${TAG}`;
const TITLE = `CNC Operator ${TAG}`;

const pii = new PiiCryptoService({
  PII_HASH_PEPPER: "outbound-signals-db-pepper",
  PII_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
} as unknown as ServerConfig);

describe.skipIf(!RUN)("outbound_signals against Postgres (#2747 item 8, migration 0167)", () => {
  let client!: DbClient;
  let repo!: OutboundSignalsRepository;
  let service!: OutboundSignalsService;
  const posted: RvmSelectionEventBody[] = [];
  let answer: () => Promise<unknown> = async () => ({ kind: "accepted" });
  let clock = new Date();
  let sender!: OutboundSignalsSender;

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 4 });
    repo = new OutboundSignalsRepository(client.db);
    service = new OutboundSignalsService(repo, { isEnabledFor: async () => true } as never);
    sender = new OutboundSignalsSender(
      repo,
      {
        postSelectionEvent: async (body: RvmSelectionEventBody) => {
          posted.push(body);
          return answer();
        },
      } as never,
      pii,
      { isLiveForServiceCaller: () => true } as never,
      { upsertJobScheduler: async () => undefined } as never,
      () => clock,
    );
    await seed(client);
  }, 60_000);

  afterAll(async () => {
    if (!client) return;
    const { sql } = client;
    await sql`DELETE FROM outbound_signals WHERE worker_id = ANY(${WORKERS}::uuid[])`;
    await sql`DELETE FROM worker_institute_links WHERE worker_id = ANY(${WORKERS}::uuid[])`;
    await sql`DELETE FROM workers WHERE id = ANY(${WORKERS}::uuid[])`;
    await sql`DELETE FROM job_postings WHERE id = ${POSTING}::uuid`;
    await sql`DELETE FROM jobs WHERE id = ${JOB}::uuid`;
    await sql`DELETE FROM payers WHERE id = ${PAYER}::uuid`;
    await sql.end({ timeout: 5 });
  });

  /** recordMark in its own transaction, as the stage write calls it. */
  async function mark(
    workerId: string,
    stage: "selected" | "hired",
    posting: { kind: "company_posting" | "agency_job"; id: string } = {
      kind: "company_posting",
      id: POSTING,
    },
  ) {
    return client.db.transaction((tx) =>
      service.recordMark(
        { postingKind: posting.kind, postingId: posting.id, workerId, stage, at: new Date() },
        tx as never,
      ),
    );
  }

  async function rowsFor(workerId: string) {
    return client.sql<
      {
        id: string;
        destination: string;
        kind: string;
        dedupe_key: string;
        status: string;
        attempts: number;
        last_failure: string | null;
        delivered_at: Date | string | null;
        next_attempt_at: Date | string;
        payload: Record<string, unknown>;
      }[]
    >`
      SELECT id, destination, kind, dedupe_key, status, attempts, last_failure, delivered_at,
             next_attempt_at, payload
      FROM outbound_signals WHERE worker_id = ${workerId}::uuid ORDER BY created_at, kind`;
  }

  it("the fixture is real: the table exists and holds nothing for these workers", async () => {
    const [reg] = await client.sql<{ t: string | null }[]>`
      SELECT to_regclass('public.outbound_signals')::text AS t`;
    expect(reg!.t).toBe("outbound_signals");
    for (const w of WORKERS) expect(await rowsFor(w)).toEqual([]);
  });

  it("a mark on an RVM student queues ONE pending row, ids only", async () => {
    await expect(mark(STUDENT, "selected")).resolves.toBe("queued");
    const [row, ...rest] = await rowsFor(STUDENT);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      destination: "rvm_selection_events",
      kind: "applicant_selected",
      dedupe_key: `rvm_selection_events:company_posting:${POSTING}:${STUDENT}:selected`,
      status: "pending",
      attempts: 0,
      last_failure: null,
      delivered_at: null,
    });
    expect(row!.payload).toEqual({
      posting_kind: "company_posting",
      posting_id: POSTING,
      worker_id: STUDENT,
      stage: "selected",
      marked_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(JSON.stringify(row)).not.toContain(TAG); // no company name, no title
    expect(JSON.stringify(row)).not.toContain(STUDENT_REF);
  });

  it("the same mark again is a duplicate (one row); hired is a second row", async () => {
    await expect(mark(STUDENT, "selected")).resolves.toBe("duplicate");
    await expect(mark(STUDENT, "hired")).resolves.toBe("queued");
    expect((await rowsFor(STUDENT)).map((r) => r.kind).sort()).toEqual([
      "applicant_hired",
      "applicant_selected",
    ]);
  });

  it("a transaction that rolls back takes its signal with it", async () => {
    const failed = await client.db
      .transaction(async (tx) => {
        await service.recordMark(
          {
            postingKind: "agency_job",
            postingId: JOB,
            workerId: STUDENT_2,
            stage: "selected",
            at: new Date(),
          },
          tx as never,
        );
        throw new Error("the stage write failed");
      })
      .catch((e: unknown) => e);
    expect((failed as Error).message).toBe("the stage write failed");
    expect(await rowsFor(STUDENT_2)).toEqual([]);
  });

  it("a BadaBhai worker and a withdrawn link queue nothing", async () => {
    await expect(mark(OUTSIDER, "hired")).resolves.toBe("not_rvm");
    await client.sql`
      UPDATE worker_institute_links SET status = 'withdrawn', withdrawn_at = now()
      WHERE worker_id = ${LEAVER}::uuid`;
    await expect(mark(LEAVER, "hired")).resolves.toBe("not_rvm");
    expect(await rowsFor(OUTSIDER)).toEqual([]);
    expect(await rowsFor(LEAVER)).toEqual([]);
  });

  it("the sender builds the body from the database at send time and records delivered", async () => {
    clock = new Date(Date.now() + 1_000);
    posted.length = 0;
    answer = async () => ({ kind: "accepted" });
    await sender.process();
    const rows = await rowsFor(STUDENT);
    const selected = rows.find((r) => r.kind === "applicant_selected")!;
    const body = posted.find((b) => b.event_id === selected.id);
    expect(body).toEqual({
      event_id: selected.id,
      student_ref: STUDENT_REF,
      company: COMPANY,
      job_title: TITLE,
      status: "selected",
      date: selected.payload.marked_on,
    });
    expect(posted.find((b) => b.status === "hired" && b.student_ref === STUDENT_REF)).toBeDefined();
    for (const r of rows) {
      expect(r.status).toBe("delivered");
      expect(r.delivered_at).not.toBeNull();
      expect(r.attempts).toBe(1);
    }
    // Delivered rows are never claimed again.
    posted.length = 0;
    await sender.process();
    expect(posted.filter((b) => b.student_ref === STUDENT_REF)).toEqual([]);
  });

  it("an agency job's title is read from `jobs`", async () => {
    await expect(mark(STUDENT_2, "selected", { kind: "agency_job", id: JOB })).resolves.toBe(
      "queued",
    );
    const ctx = await repo.selectionContext(STUDENT_2, "agency_job", JOB);
    expect(ctx.jobTitle).toBe(`Agency ${TITLE}`);
    expect(pii.decrypt(ctx.companyNameEnc!)).toBe(COMPANY);
  });

  it("an outage: the row is retried later, with its attempt and failure code recorded", async () => {
    clock = new Date(Date.now() + 2_000);
    posted.length = 0;
    answer = async () => {
      throw new RvmStudentApiUnavailableError("timeout");
    };
    await sender.process();
    const [row] = await rowsFor(STUDENT_2);
    expect(row).toMatchObject({ status: "pending", attempts: 1, last_failure: "timeout" });
    expect(new Date(row!.next_attempt_at).getTime()).toBeGreaterThan(clock.getTime());
    // Not due again until its back-off has passed.
    posted.length = 0;
    await sender.process();
    expect(posted.filter((b) => b.event_id === row!.id)).toEqual([]);
  });

  it("his link ended before it went: cancelled, and nothing is sent", async () => {
    await expect(mark(STUDENT_3, "hired")).resolves.toBe("queued");
    await client.sql`
      UPDATE worker_institute_links SET status = 'withdrawn', withdrawn_at = now()
      WHERE worker_id = ${STUDENT_3}::uuid`;
    clock = new Date(Date.now() + 3_000);
    posted.length = 0;
    answer = async () => ({ kind: "accepted" });
    await sender.process();
    const [row] = await rowsFor(STUDENT_3);
    expect(row).toMatchObject({ status: "cancelled", attempts: 0, last_failure: "link_inactive" });
    expect(posted.filter((b) => b.event_id === row!.id)).toEqual([]);
  });

  it("two senders claiming at once never take the same row (SKIP LOCKED)", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const [r] = await client.sql<{ id: string }[]>`
        INSERT INTO outbound_signals (destination, kind, dedupe_key, worker_id, payload)
        VALUES ('rvm_selection_events', 'applicant_selected', ${`skip-locked-${TAG}-${i}`},
                ${OUTSIDER}::uuid, '{}'::jsonb)
        RETURNING id`;
      ids.push(r!.id);
    }
    const now = new Date(Date.now() + 4_000);
    const lease = new Date(now.getTime() + 60_000);
    const [a, b] = await Promise.all([
      repo.claimDue(now, lease, 50),
      repo.claimDue(now, lease, 50),
    ]);
    const mineA = a.map((r) => r.id).filter((id) => ids.includes(id));
    const mineB = b.map((r) => r.id).filter((id) => ids.includes(id));
    expect(mineA.filter((id) => mineB.includes(id))).toEqual([]);
    expect([...mineA, ...mineB].sort()).toEqual([...ids].sort());
    // Leased: a third claim before the lease runs out takes none of them.
    const c = await repo.claimDue(now, lease, 50);
    expect(c.filter((r) => ids.includes(r.id))).toEqual([]);
  });

  it("the CHECKs refuse an unknown status, an unknown failure and a delivered row with no date", async () => {
    const insert = (status: string, failure: string | null, delivered: boolean) =>
      client.sql`
        INSERT INTO outbound_signals (destination, kind, dedupe_key, worker_id, payload, status,
                                      last_failure, delivered_at)
        VALUES ('rvm_selection_events', 'applicant_hired', ${`chk-${TAG}-${randomUUID()}`},
                ${OUTSIDER}::uuid, '{}'::jsonb, ${status}, ${failure},
                ${delivered ? new Date().toISOString() : null}::timestamptz)`.catch((e) => e);
    expect(((await insert("sent", null, false)) as { code?: string }).code).toBe("23514");
    expect(((await insert("pending", "boom", false)) as { code?: string }).code).toBe("23514");
    expect(((await insert("delivered", null, false)) as { code?: string }).code).toBe("23514");
    expect(((await insert("pending", null, true)) as { code?: string }).code).toBe("23514");
    const bad = await client.sql`
      INSERT INTO outbound_signals (destination, kind, dedupe_key, worker_id, payload)
      VALUES ('rvm_selection_events', 'applicant_hired', ${`chk-${TAG}-array`},
              ${OUTSIDER}::uuid, '[]'::jsonb)`.catch((e) => e);
    expect((bad as { code?: string }).code).toBe("23514");
  });

  it("erasure: deleting the worker deletes his signals (ON DELETE CASCADE)", async () => {
    await expect(mark(ERASED, "selected")).resolves.toBe("queued");
    expect(await rowsFor(ERASED)).toHaveLength(1);
    await client.sql`DELETE FROM worker_institute_links WHERE worker_id = ${ERASED}::uuid`;
    await client.sql`DELETE FROM workers WHERE id = ${ERASED}::uuid`;
    expect(await rowsFor(ERASED)).toEqual([]);
  });

  async function seed(c: DbClient): Promise<void> {
    const { sql } = c;
    await sql`
      INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status)
      VALUES (${PAYER}::uuid, 'employer', ${`enc:outbound-${TAG}`}, ${`hash:outbound-${TAG}`},
              ${pii.encrypt(COMPANY)}, 'active')`;
    await sql`
      INSERT INTO job_postings (id, created_by, payer_id, org_label, role_title, vacancy_band, status,
                                match_skill_ids, reach_skill_ids, published_at)
      VALUES (${POSTING}::uuid, ${OPS}::uuid, ${PAYER}::uuid, 'Outbound Fixture', ${TITLE},
              '1', 'open', '["mskill_vmc_operator"]'::jsonb, '["mskill_vmc_operator"]'::jsonb, now())`;
    await sql`
      INSERT INTO jobs (id, trade_key, title, city, status, payer_id, min_experience_years, pay_min, pay_max)
      VALUES (${JOB}::uuid, 'cnc_vmc', ${`Agency ${TITLE}`}, 'pune', 'open', ${PAYER}::uuid, 1, 18000, 30000)`;
    for (const [i, w] of WORKERS.entries()) {
      await sql`
        INSERT INTO workers (id, phone_e164, phone_hash, status)
        VALUES (${w}::uuid, ${`enc:outbound-${TAG}-${i}`}, ${`hash:outbound-${TAG}-${i}`}, 'active')`;
    }
    for (const w of [STUDENT, STUDENT_2, STUDENT_3, LEAVER, ERASED]) {
      await sql`
        INSERT INTO worker_institute_links
          (worker_id, institute_code, student_ref, status, course, branch, linked_at, synced_at)
        VALUES (${w}::uuid, 'rvm', ${w === STUDENT ? STUDENT_REF : randomUUID()},
                'active', 'Diploma in CNC', 'Nashik', now(), now())`;
    }
  }
});
