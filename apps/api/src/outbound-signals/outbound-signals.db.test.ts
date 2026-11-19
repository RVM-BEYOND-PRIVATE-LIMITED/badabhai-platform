import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "@badabhai/db";
import type { ServerConfig } from "@badabhai/config";
import { PiiCryptoService } from "../common/pii-crypto.service";
import {
  RvmStudentApiUnavailableError,
  type RvmSelectionEventBody,
  type RvmSelectionWithdrawalBody,
} from "../campus-link/rvm-student-api.client";
import type { RequestContext } from "../common/request-context";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { PayerApplicantStagesRepository } from "../payer-portal/payer-applicant-stages.repository";
import { PayerApplicantStagesService } from "../payer-portal/payer-applicant-stages.service";
import { defaultModeResolver } from "../payers/payer-tenant-scope.test-support";
import { OutboundSignalsRepository } from "./outbound-signals.repository";
import { OUTBOUND_MAX_ATTEMPTS, OutboundSignalsSender } from "./outbound-signals.sender";
import { OUTBOUND_SEND_DELAY_MS, OutboundSignalsService } from "./outbound-signals.service";

/**
 * #2747 item 8 — `outbound_signals` (migration 0167) against a real Postgres.
 *
 * The unit suites prove the recorder and the sender SAY the right thing. Only a database proves:
 *  - a mark on an actively linked RVM student queues ONE row, ids only, due ten minutes later, in
 *    the caller's transaction (a rollback takes it away), and the unique key makes a repeat a
 *    no-op;
 *  - a BadaBhai worker and a withdrawn link queue nothing;
 *  - the sender claims due rows (SKIP LOCKED: two senders never take one row; each claim counts as
 *    an attempt), re-reads the board, the worker and the link, builds the body from the database
 *    (the posting's own label or the agency owner's decrypted name, the title, the student ref)
 *    and records delivered / retried / cancelled / abandoned on the row;
 *  - the CHECKs refuse an unknown status or failure code and a delivered row with no date;
 *  - erasure: deleting the worker deletes his signals (the FK cascade);
 *  - #2771 (migration 0191), driven through the REAL stage write: an undo of a mark RVM holds
 *    queues ONE withdrawal in the stage transaction (a failed undo takes it back with the stage),
 *    a second undo queues nothing, and the sender sends it after the selection; a mark undone
 *    before it went sends nothing at all; a mark given back before its withdrawal went sends
 *    nothing more; a re-mark after a withdrawal sends a fresh selection; hired → selected
 *    withdraws `hired` only.
 *
 * Fixtures carry no real PII: synthetic names, the account name encrypted with a test key.
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
const UNDONE = randomUUID();
const LEAVING = randomUUID();
const LEAVER = randomUUID();
const OUTSIDER = randomUUID();
const ERASED = randomUUID();
/** #2771 — applicants on POSTING, moved through the real stage write. */
const UNDO_AFTER_SEND = randomUUID();
const UNDO_BEFORE_SEND = randomUUID();
const GIVEN_BACK = randomUUID();
const HIRED_TO_SELECTED = randomUUID();
const ROLLED_BACK = randomUUID();
const APPLICANTS = [UNDO_AFTER_SEND, UNDO_BEFORE_SEND, GIVEN_BACK, HIRED_TO_SELECTED, ROLLED_BACK];
const WORKERS = [
  STUDENT,
  STUDENT_2,
  STUDENT_3,
  UNDONE,
  LEAVING,
  LEAVER,
  OUTSIDER,
  ERASED,
  ...APPLICANTS,
];
const LINKED = [STUDENT, STUDENT_2, STUDENT_3, UNDONE, LEAVING, LEAVER, ERASED, ...APPLICANTS];
const STUDENT_REF = randomUUID();
const ACCOUNT_NAME = `Sharma Precision Works ${TAG}`;
const LABEL = `Sharma Precision ${TAG}`;
const TITLE = `CNC Operator ${TAG}`;

const pii = new PiiCryptoService({
  PII_HASH_PEPPER: "outbound-signals-db-pepper",
  PII_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
} as unknown as ServerConfig);

/** A clock past the send delay of every mark made so far. */
const due = (extraMs = 0) => new Date(Date.now() + OUTBOUND_SEND_DELAY_MS + 1_000 + extraMs);

describe.skipIf(!RUN)("outbound_signals against Postgres (#2747 item 8, migration 0167)", () => {
  let client!: DbClient;
  let repo!: OutboundSignalsRepository;
  let service!: OutboundSignalsService;
  const posted: RvmSelectionEventBody[] = [];
  const withdrawn: RvmSelectionWithdrawalBody[] = [];
  let answer: () => Promise<unknown> = async () => ({ kind: "accepted" });
  let clock = new Date();
  let sender!: OutboundSignalsSender;
  /** #2771 — the real stage write, with this file's recorder and every switch on. */
  let stages!: PayerApplicantStagesService;
  /** …and one whose hire write fails on an undo of `hired`, to prove the rollback. */
  let failingStages!: PayerApplicantStagesService;
  const correlations: string[] = [];

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 4 });
    repo = new OutboundSignalsRepository(client.db);
    service = new OutboundSignalsService(repo, { stateFor: async () => "on" } as never);
    sender = new OutboundSignalsSender(
      repo,
      {
        postSelectionEvent: async (body: RvmSelectionEventBody) => {
          posted.push(body);
          return answer();
        },
        postSelectionWithdrawal: async (body: RvmSelectionWithdrawalBody) => {
          withdrawn.push(body);
          return answer();
        },
        isConfigured: () => true,
        timeoutMs: 5_000,
      } as never,
      pii,
      { isLiveForServiceCaller: () => true } as never,
      { upsertJobScheduler: async () => undefined } as never,
      () => clock,
    );
    const events = new EventsService(new EventsRepository(client.db), {
      NODE_ENV: "test",
    } as never);
    const build = (hires: unknown) =>
      new PayerApplicantStagesService(
        new PayerApplicantStagesRepository(client.db),
        events,
        { PAYER_APPLICANT_STAGES_ENABLED: true } as never,
        defaultModeResolver(),
        { isEnabledFor: async () => true } as never,
        service,
        hires as never,
      );
    stages = build({ enabled: false });
    failingStages = build({
      enabled: true,
      recordCompanyMark: async () => ({ changed: true, hire: null }),
      undoCompanyMark: async () => {
        throw new Error("the hire write failed");
      },
    });
    await seed(client);
  }, 60_000);

  afterAll(async () => {
    if (!client) return;
    const { sql } = client;
    await sql`DELETE FROM outbound_signals WHERE worker_id = ANY(${WORKERS}::uuid[])`;
    await sql`DELETE FROM payer_applicant_stages WHERE worker_id = ANY(${WORKERS}::uuid[])`;
    await sql`DELETE FROM applications WHERE worker_id = ANY(${WORKERS}::uuid[])`;
    await sql`DELETE FROM worker_profiles WHERE worker_id = ANY(${WORKERS}::uuid[])`;
    if (correlations.length > 0) {
      await sql`DELETE FROM events WHERE correlation_id = ANY(${correlations}::uuid[])`;
    }
    await sql`DELETE FROM worker_institute_links WHERE worker_id = ANY(${WORKERS}::uuid[])`;
    await sql`DELETE FROM workers WHERE id = ANY(${WORKERS}::uuid[])`;
    await sql`DELETE FROM job_postings WHERE id = ${POSTING}::uuid`;
    await sql`DELETE FROM jobs WHERE id = ${JOB}::uuid`;
    await sql`DELETE FROM payers WHERE id = ${PAYER}::uuid`;
    await sql.end({ timeout: 5 });
  });

  /** The board holds `stage` for him (the stage write the mark rides on). */
  async function board(
    workerId: string,
    stage: string,
    posting: { kind: "company_posting" | "agency_job"; id: string },
  ) {
    await client.sql`
      INSERT INTO payer_applicant_stages (posting_kind, posting_id, worker_id, stage, actor_payer_id)
      VALUES (${posting.kind}, ${posting.id}::uuid, ${workerId}::uuid, ${stage}, ${PAYER}::uuid)
      ON CONFLICT (posting_kind, posting_id, worker_id) DO UPDATE SET stage = EXCLUDED.stage`;
  }

  const COMPANY_POSTING = { kind: "company_posting" as const, id: POSTING };
  const AGENCY_JOB = { kind: "agency_job" as const, id: JOB };

  /** The board move and recordMark in one transaction, as the stage write calls it. */
  async function mark(
    workerId: string,
    stage: "selected" | "hired",
    posting: { kind: "company_posting" | "agency_job"; id: string } = COMPANY_POSTING,
  ) {
    await board(workerId, stage, posting);
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
        created_at: Date | string;
        payload: Record<string, unknown>;
      }[]
    >`
      SELECT id, destination, kind, dedupe_key, status, attempts, last_failure, delivered_at,
             next_attempt_at, created_at, payload
      FROM outbound_signals WHERE worker_id = ${workerId}::uuid ORDER BY created_at, kind`;
  }

  /** One sweep at `at`, returning what was posted for these ids. */
  async function sweep(at: Date) {
    clock = at;
    posted.length = 0;
    withdrawn.length = 0;
    await sender.process();
    return [...posted];
  }

  /** #2771 — the company moves one of its applicants on POSTING, through the real stage write. */
  async function move(
    workerId: string,
    stage: "new" | "shortlist" | "passed" | "selected" | "hired",
    svc: PayerApplicantStagesService = stages,
  ) {
    const ctx: RequestContext = { correlationId: randomUUID(), requestId: `outbound-db-${TAG}` };
    correlations.push(ctx.correlationId);
    return svc.setStage(PAYER, POSTING, workerId, stage, ctx);
  }

  async function boardStage(workerId: string) {
    const [row] = await client.sql<{ stage: string }[]>`
      SELECT stage FROM payer_applicant_stages
      WHERE posting_kind = 'company_posting' AND posting_id = ${POSTING}::uuid
        AND worker_id = ${workerId}::uuid`;
    return row?.stage ?? null;
  }

  const firstKey = (workerId: string, stage: "selected" | "hired") =>
    `rvm_selection_events:company_posting:${POSTING}:${workerId}:${stage}`;

  it("the fixture is real: the table exists and holds nothing for these workers", async () => {
    const [reg] = await client.sql<{ t: string | null }[]>`
      SELECT to_regclass('public.outbound_signals')::text AS t`;
    expect(reg!.t).toBe("outbound_signals");
    for (const w of WORKERS) expect(await rowsFor(w)).toEqual([]);
  });

  it("a mark on an RVM student queues ONE pending row, ids only, due ten minutes later", async () => {
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
    const delay = new Date(row!.next_attempt_at).getTime() - new Date(row!.created_at).getTime();
    expect(delay).toBe(OUTBOUND_SEND_DELAY_MS);
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

  it("not sent before its ten minutes are up", async () => {
    const early = await sweep(new Date(Date.now() + 1_000));
    expect(early.filter((b) => b.student_ref === STUDENT_REF)).toEqual([]);
    expect((await rowsFor(STUDENT))[0]).toMatchObject({ status: "pending", attempts: 0 });
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

  it("the sender builds the body from the database (the posting's own label) and records delivered", async () => {
    answer = async () => ({ kind: "accepted" });
    const sent = await sweep(due());
    const rows = await rowsFor(STUDENT);
    const selected = rows.find((r) => r.kind === "applicant_selected")!;
    expect(sent.find((b) => b.event_id === selected.id)).toEqual({
      event_id: selected.id,
      student_ref: STUDENT_REF,
      company: LABEL,
      job_title: TITLE,
      status: "selected",
      date: selected.payload.marked_on,
    });
    expect(sent.find((b) => b.status === "hired" && b.student_ref === STUDENT_REF)).toBeDefined();
    for (const r of rows) {
      expect(r).toMatchObject({ status: "delivered", attempts: 1, last_failure: null });
      expect(r.delivered_at).not.toBeNull();
    }
    // Delivered rows are never claimed again.
    const again = await sweep(due(60_000));
    expect(again.filter((b) => b.student_ref === STUDENT_REF)).toEqual([]);
  });

  it("an agency job: its title from `jobs`, the owner account's name decrypted", async () => {
    await expect(mark(STUDENT_2, "selected", AGENCY_JOB)).resolves.toBe("queued");
    const ctx = await repo.selectionContext(STUDENT_2, "agency_job", JOB);
    expect(ctx).toMatchObject({
      jobTitle: `Agency ${TITLE}`,
      companyLabel: null,
      currentStage: "selected",
      workerActive: true,
    });
    expect(pii.decrypt(ctx.companyNameEnc!)).toBe(ACCOUNT_NAME);
  });

  it("an outage: retried later, with the claimed attempt and the failure code recorded", async () => {
    answer = async () => {
      throw new RvmStudentApiUnavailableError("timeout");
    };
    const at = due(120_000);
    await sweep(at);
    const [row] = await rowsFor(STUDENT_2);
    expect(row).toMatchObject({ status: "pending", attempts: 1, last_failure: "timeout" });
    expect(new Date(row!.next_attempt_at).getTime()).toBeGreaterThan(at.getTime());
    // Not due again until its back-off has passed.
    const again = await sweep(at);
    expect(again.filter((b) => b.event_id === row!.id)).toEqual([]);
    answer = async () => ({ kind: "accepted" });
  });

  it("the mark undone before it went: cancelled (mark_undone), nothing sent", async () => {
    await expect(mark(UNDONE, "hired")).resolves.toBe("queued");
    await board(UNDONE, "shortlist", COMPANY_POSTING);
    const sent = await sweep(due(180_000));
    const [row] = await rowsFor(UNDONE);
    expect(row).toMatchObject({ status: "cancelled", last_failure: "mark_undone" });
    expect(sent.filter((b) => b.event_id === row!.id)).toEqual([]);
  });

  it("scheduled for deletion after the mark: cancelled (worker_inactive), nothing sent", async () => {
    await expect(mark(LEAVING, "selected")).resolves.toBe("queued");
    await client.sql`
      UPDATE workers SET deletion_scheduled_at = now() + interval '7 days'
      WHERE id = ${LEAVING}::uuid`;
    const sent = await sweep(due(240_000));
    const [row] = await rowsFor(LEAVING);
    expect(row).toMatchObject({ status: "cancelled", last_failure: "worker_inactive" });
    expect(sent.filter((b) => b.event_id === row!.id)).toEqual([]);
  });

  it("his link ended before it went: cancelled (link_inactive), nothing sent", async () => {
    await expect(mark(STUDENT_3, "hired")).resolves.toBe("queued");
    await client.sql`
      UPDATE worker_institute_links SET status = 'withdrawn', withdrawn_at = now()
      WHERE worker_id = ${STUDENT_3}::uuid`;
    const sent = await sweep(due(300_000));
    const [row] = await rowsFor(STUDENT_3);
    expect(row).toMatchObject({ status: "cancelled", last_failure: "link_inactive" });
    expect(sent.filter((b) => b.event_id === row!.id)).toEqual([]);
  });

  it("two senders claiming at once never take the same row (SKIP LOCKED), and each claim is an attempt", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const [r] = await client.sql<{ id: string }[]>`
        INSERT INTO outbound_signals (destination, kind, dedupe_key, worker_id, payload)
        VALUES ('rvm_selection_events', 'applicant_selected', ${`skip-locked-${TAG}-${i}`},
                ${OUTSIDER}::uuid, '{}'::jsonb)
        RETURNING id`;
      ids.push(r!.id);
    }
    const now = due(360_000);
    const lease = new Date(now.getTime() + 600_000);
    const [a, b] = await Promise.all([
      repo.claimDue(now, lease, 50, OUTBOUND_MAX_ATTEMPTS),
      repo.claimDue(now, lease, 50, OUTBOUND_MAX_ATTEMPTS),
    ]);
    const mineA = a.filter((r) => ids.includes(r.id));
    const mineB = b.filter((r) => ids.includes(r.id));
    expect(mineA.filter((r) => mineB.some((s) => s.id === r.id))).toEqual([]);
    expect([...mineA, ...mineB].map((r) => r.id).sort()).toEqual([...ids].sort());
    for (const r of [...mineA, ...mineB]) expect(r.attempts).toBe(1);
    // Leased: a third claim before the lease runs out takes none of them.
    const c = await repo.claimDue(now, lease, 50, OUTBOUND_MAX_ATTEMPTS);
    expect(c.filter((r) => ids.includes(r.id))).toEqual([]);
    await client.sql`UPDATE outbound_signals SET status = 'cancelled', last_failure = 'contract'
                     WHERE id = ANY(${ids}::uuid[])`;
  });

  it("a row claimed the maximum number of times without an outcome is given up (abandoned)", async () => {
    const [r] = await client.sql<{ id: string }[]>`
      INSERT INTO outbound_signals (destination, kind, dedupe_key, worker_id, payload, attempts)
      VALUES ('rvm_selection_events', 'applicant_hired', ${`abandoned-${TAG}`},
              ${OUTSIDER}::uuid, '{}'::jsonb, ${OUTBOUND_MAX_ATTEMPTS})
      RETURNING id`;
    const now = due(420_000);
    const claimed = await repo.claimDue(
      now,
      new Date(now.getTime() + 60_000),
      50,
      OUTBOUND_MAX_ATTEMPTS,
    );
    expect(claimed.map((c) => c.id)).not.toContain(r!.id);
    const [row] = await client.sql<{ status: string; last_failure: string }[]>`
      SELECT status, last_failure FROM outbound_signals WHERE id = ${r!.id}::uuid`;
    expect(row).toEqual({ status: "dead", last_failure: "abandoned" });
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

  // ── #2771 — the withdrawal of an undone mark, through the real stage write ──────────────────

  it("#2771: an undo of a mark RVM holds queues ONE withdrawal in the stage transaction; a second undo none", async () => {
    await expect(move(UNDO_AFTER_SEND, "selected")).resolves.toMatchObject({ changed: true });
    await sweep(due(600_000));
    const [sel] = await rowsFor(UNDO_AFTER_SEND);
    expect(sel).toMatchObject({ kind: "applicant_selected", status: "delivered" });

    await expect(move(UNDO_AFTER_SEND, "shortlist")).resolves.toMatchObject({
      changed: true,
      previousStage: "selected",
    });
    const rows = await rowsFor(UNDO_AFTER_SEND);
    expect(rows).toHaveLength(2);
    const wd = rows.find((r) => r.kind === "applicant_mark_withdrawn")!;
    expect(wd).toMatchObject({
      destination: "rvm_selection_events",
      dedupe_key: `${firstKey(UNDO_AFTER_SEND, "selected")}:after:${sel!.id}`,
      status: "pending",
      attempts: 0,
      last_failure: null,
    });
    expect(wd.payload).toEqual({
      posting_kind: "company_posting",
      posting_id: POSTING,
      worker_id: UNDO_AFTER_SEND,
      stage: "selected",
      undone_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      after_signal_id: sel!.id,
    });
    const delay = new Date(wd.next_attempt_at).getTime() - new Date(wd.created_at).getTime();
    expect(delay).toBe(OUTBOUND_SEND_DELAY_MS);
    expect(JSON.stringify(wd)).not.toContain(TAG); // no company name, no title

    // Exactly once per undo: further moves that keep the mark undone queue nothing.
    await move(UNDO_AFTER_SEND, "passed");
    await move(UNDO_AFTER_SEND, "new");
    expect(await rowsFor(UNDO_AFTER_SEND)).toHaveLength(2);
  });

  it("#2771: the sender sends the withdrawal (ids, a status and a day) and records it delivered", async () => {
    const rows = await rowsFor(UNDO_AFTER_SEND);
    const sel = rows.find((r) => r.kind === "applicant_selected")!;
    const wd = rows.find((r) => r.kind === "applicant_mark_withdrawn")!;
    await sweep(due(1_200_000));
    expect(withdrawn.filter((b) => b.event_id === wd.id)).toEqual([
      {
        event_id: wd.id,
        withdraws_event_id: sel.id,
        status: "withdrawn",
        date: wd.payload.undone_on,
      },
    ]);
    const [after] = (await rowsFor(UNDO_AFTER_SEND)).filter((r) => r.id === wd.id);
    expect(after).toMatchObject({ status: "delivered", attempts: 1, last_failure: null });
  });

  it("#2771: marked again after the withdrawal went — a fresh selection, its own event id, sent", async () => {
    await move(UNDO_AFTER_SEND, "selected");
    const rows = await rowsFor(UNDO_AFTER_SEND);
    expect(rows).toHaveLength(3);
    const wd = rows.find((r) => r.kind === "applicant_mark_withdrawn")!;
    const fresh = rows.find((r) => r.payload.after_signal_id === wd.id)!;
    expect(fresh).toMatchObject({
      kind: "applicant_selected",
      dedupe_key: `${firstKey(UNDO_AFTER_SEND, "selected")}:after:${wd.id}`,
      status: "pending",
    });
    const sent = await sweep(due(1_800_000));
    expect(sent.filter((b) => b.event_id === fresh.id)).toEqual([
      expect.objectContaining({ event_id: fresh.id, status: "selected", company: LABEL }),
    ]);
  });

  it("#2771: undone before the mark went — nothing reaches RVM; the withdrawal waits at no attempt, then is cancelled", async () => {
    await move(UNDO_BEFORE_SEND, "hired");
    await move(UNDO_BEFORE_SEND, "shortlist");
    const queued = await rowsFor(UNDO_BEFORE_SEND);
    expect(queued.map((r) => [r.kind, r.status])).toEqual([
      ["applicant_hired", "pending"],
      ["applicant_mark_withdrawn", "pending"],
    ]);
    const [hire, wd] = queued;

    // First sweep: the mark is cancelled; the withdrawal is not even claimed (its predecessor was
    // still pending when the claim ran), so the wait cost it no attempt.
    await sweep(due(2_400_000));
    let rows = await rowsFor(UNDO_BEFORE_SEND);
    expect(rows.find((r) => r.id === hire!.id)).toMatchObject({
      status: "cancelled",
      last_failure: "mark_undone",
    });
    expect(rows.find((r) => r.id === wd!.id)).toMatchObject({ status: "pending", attempts: 0 });

    // Next sweep: RVM never received the mark, so the withdrawal is cancelled too.
    await sweep(due(2_400_000));
    rows = await rowsFor(UNDO_BEFORE_SEND);
    expect(rows.find((r) => r.id === wd!.id)).toMatchObject({
      status: "cancelled",
      last_failure: "mark_never_sent",
    });
    expect(posted.filter((b) => b.event_id === hire!.id)).toEqual([]);
    expect(withdrawn.filter((b) => b.event_id === wd!.id)).toEqual([]);
  });

  it("#2771: undone and given back before the withdrawal went — RVM keeps its one selection, nothing more is sent", async () => {
    await move(GIVEN_BACK, "selected");
    await sweep(due(3_000_000));
    await move(GIVEN_BACK, "shortlist");
    await move(GIVEN_BACK, "selected");
    const chain = await rowsFor(GIVEN_BACK);
    expect(chain.map((r) => [r.kind, r.status])).toEqual([
      ["applicant_selected", "delivered"],
      ["applicant_mark_withdrawn", "pending"],
      ["applicant_selected", "pending"],
    ]);
    const [, wd, again] = chain;

    await sweep(due(3_600_000));
    await sweep(due(3_600_000));
    const rows = await rowsFor(GIVEN_BACK);
    expect(rows.find((r) => r.id === wd!.id)).toMatchObject({
      status: "cancelled",
      last_failure: "mark_restored",
    });
    expect(rows.find((r) => r.id === again!.id)).toMatchObject({
      status: "cancelled",
      last_failure: "mark_already_sent",
    });
    expect(withdrawn.filter((b) => b.event_id === wd!.id)).toEqual([]);
    expect(posted.filter((b) => b.event_id === again!.id)).toEqual([]);
  });

  it("#2771: hired → selected withdraws the hired mark only", async () => {
    await move(HIRED_TO_SELECTED, "selected");
    await move(HIRED_TO_SELECTED, "hired");
    await sweep(due(4_200_000));
    await move(HIRED_TO_SELECTED, "selected");
    const rows = await rowsFor(HIRED_TO_SELECTED);
    const hire = rows.find((r) => r.kind === "applicant_hired")!;
    const wds = rows.filter((r) => r.kind === "applicant_mark_withdrawn");
    expect(wds).toHaveLength(1);
    expect(wds[0]!.payload).toMatchObject({ stage: "hired", after_signal_id: hire.id });
    await sweep(due(4_800_000));
    expect(withdrawn.filter((b) => b.event_id === wds[0]!.id)).toEqual([
      expect.objectContaining({ withdraws_event_id: hire.id, status: "withdrawn" }),
    ]);
  });

  it("#2771: an undo whose transaction fails takes its withdrawal back with the stage", async () => {
    await move(ROLLED_BACK, "hired");
    await sweep(due(5_400_000));
    expect(await rowsFor(ROLLED_BACK)).toEqual([
      expect.objectContaining({ kind: "applicant_hired", status: "delivered" }),
    ]);
    const err = await move(ROLLED_BACK, "shortlist", failingStages).catch((e: unknown) => e);
    expect((err as Error).message).toBe("the hire write failed");
    expect(await boardStage(ROLLED_BACK)).toBe("hired");
    expect(await rowsFor(ROLLED_BACK)).toHaveLength(1);
    // The same undo, succeeding, queues it.
    await move(ROLLED_BACK, "shortlist");
    expect((await rowsFor(ROLLED_BACK)).map((r) => r.kind)).toEqual([
      "applicant_hired",
      "applicant_mark_withdrawn",
    ]);
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
              ${pii.encrypt(ACCOUNT_NAME)}, 'active')`;
    await sql`
      INSERT INTO job_postings (id, created_by, payer_id, org_label, role_title, vacancy_band, status,
                                match_skill_ids, reach_skill_ids, published_at)
      VALUES (${POSTING}::uuid, ${OPS}::uuid, ${PAYER}::uuid, ${LABEL}, ${TITLE},
              '1', 'open', '["mskill_vmc_operator"]'::jsonb, '["mskill_vmc_operator"]'::jsonb, now())`;
    await sql`
      INSERT INTO jobs (id, trade_key, title, city, status, payer_id, min_experience_years, pay_min, pay_max)
      VALUES (${JOB}::uuid, 'cnc_vmc', ${`Agency ${TITLE}`}, 'pune', 'open', ${PAYER}::uuid, 1, 18000, 30000)`;
    for (const [i, w] of WORKERS.entries()) {
      await sql`
        INSERT INTO workers (id, phone_e164, phone_hash, status)
        VALUES (${w}::uuid, ${`enc:outbound-${TAG}-${i}`}, ${`hash:outbound-${TAG}-${i}`}, 'active')`;
    }
    // #2771 — the applicants the real stage write moves: a profile and an application on POSTING.
    for (const w of APPLICANTS) {
      await sql`
        INSERT INTO worker_profiles (worker_id, profile_status, canonical_role_id, canonical_trade_id,
                                     experience, location_preference, availability)
        VALUES (${w}::uuid, 'extracted', 'vmc_operator', 'cnc_vmc',
                ${JSON.stringify({ total_years: 3 })}::jsonb,
                ${JSON.stringify({ preferred_cities: ["pune"] })}::jsonb,
                ${JSON.stringify({ status: "immediate" })}::jsonb)`;
      await sql`
        INSERT INTO applications (id, worker_id, job_id, job_posting_id, action, source_surface,
                                  match_tier, engine_version)
        VALUES (${randomUUID()}::uuid, ${w}::uuid, NULL, ${POSTING}::uuid, 'applied', 'feed', 1, 'v1.0')`;
    }
    for (const w of LINKED) {
      await sql`
        INSERT INTO worker_institute_links
          (worker_id, institute_code, student_ref, status, course, branch, linked_at, synced_at)
        VALUES (${w}::uuid, 'rvm', ${w === STUDENT ? STUDENT_REF : randomUUID()},
                'active', 'Diploma in CNC', 'Nashik', now(), now())`;
    }
  }
});
