import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { sql } from "drizzle-orm";
import { createDbClient, type Database, type DbClient } from "@badabhai/db";
import { AdminActionsRepository } from "../admin/admin-actions.repository";
import { AdminCompaniesRepository } from "../admin/companies/admin-companies.repository";
import {
  CampusDriveDecisionBodySchema,
  CampusDriveRequestsQuerySchema,
} from "../campus-link/campus-link.contract";
import { sqlStateOf } from "../common/db-error";
import type { RequestContext } from "../common/request-context";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { PostingAudienceRepository } from "../job-postings/posting-audience.repository";
import { PayerAccountDeletionService } from "../payers/payer-account-deletion.service";
import { PayerRoleGuard } from "../payers/payer-role.guard";
import { PayersRepository } from "../payers/payers.repository";
import { defaultModeResolver } from "../payers/payer-tenant-scope.test-support";
import { CampusDriveContactErasureRepository } from "./campus-drive-contact-erasure.repository";
import { addDays, indiaDay } from "./campus-drive-dates";
import { CampusDriveDecisionsService } from "./campus-drive-decisions.service";
import { PayerCreateCampusDriveRequestSchema } from "./campus-drive-requests.dto";
import {
  CampusDriveRequestsRepository,
  type DriveRequestRow,
} from "./campus-drive-requests.repository";
import { CampusDriveRequestsService } from "./campus-drive-requests.service";
import { memoryIdempotency, rolloutWith, testPii } from "./campus-drive-requests.test-support";
import { PayerCampusDriveRequestsController } from "./payer-campus-drive-requests.controller";

/**
 * #2746 PR 6 — CAMPUS-DRIVE REQUESTS, against a real Postgres.
 *
 * The real `CampusDriveRequestsService` (the company) and `CampusDriveDecisionsService` (Campus)
 * over the real repository and a migrated database. What only Postgres can show:
 *
 *   - the issue's checks: a company submits a drive request; it appears in the service list for
 *     Campus (contact decrypted for the placement team); after the decision call the company sees
 *     the scheduled date. Repeating the create with the same Idempotency-Key creates ONE request,
 *     after Redis has forgotten it and when two creates race on two connections (the second's
 *     insert waits on the first's key, then `ON CONFLICT DO NOTHING` returns no row). An agency
 *     account cannot ask;
 *   - tenancy in the query: another company's request and posting are the same 404 as unknown;
 *   - ordering in SQL: `decided_at` compared by Postgres, microsecond exact, whatever the offset;
 *     a `changed_since` before 2026-01-01 (year 0000, the epoch) clamped, never refused;
 *   - owner ruling R1: the switch gates NEW requests only — off or removed from the pilot, a
 *     company still cancels, and Campus still lists and decides, cancellations and erasures
 *     included;
 *   - owner ruling R2, through the REAL admin writers (migration review M1): a verification
 *     change, a GSTIN removal, a suspension and an archive each re-stamp the company's requests in
 *     their own transaction, so the request re-enters the feed with a newer `changed_at` and the
 *     withdrawn shape (no contact, no roles note), and cannot be decided; each restore brings the
 *     full item back the same way; a login, which stamps `payers.updated_at`, moves nothing;
 *   - THE RACE: a Campus decision and the company's cancel on two connections serialise on the
 *     request row's `FOR UPDATE` (the second waits on the parked backend — `pg_blocking_pids` —
 *     then decides
 *     against the committed row), never a 40P01, and one wins cleanly either way round;
 *   - DPDP erasure: the account deletion erases the contacts a login entered on requests that
 *     outlive it, in the row delete's transaction (a delete that fails — the `employer_profiles`
 *     FK holds every verified company — erases nothing), `cdr_contact_chk` refuses a half-erasure,
 *     and the company's own requests go with its `payers` row.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   RUN_DB_TESTS=1 DATABASE_URL=<a migrated LOCAL database> \
 *     pnpm --filter @badabhai/api run test campus-drives.db
 *
 * Runs in CI as one of the DB-backed gates in `ci.yml`, which asserts per-file that it EXECUTED.
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const CORRELATION = uuid(0x2746d0001);
const CTX: RequestContext = { correlationId: CORRELATION, requestId: "campus-drives-db" };
const CALL = { ctx: CTX, callId: uuid(0x2746d0002) };
/** A verified employer: admin-approved, GST on file. */
const COMPANY = uuid(0x2746d0010);
/** A second verified employer, for the cross-tenant cases. */
const OTHER = uuid(0x2746d0011);
/** An employer with no approval and no GST. */
const UNVERIFIED = uuid(0x2746d0012);
/** An agency account (its own `agency_profiles` world; it never reaches an employer record). */
const AGENCY = uuid(0x2746d0013);
/** A login that typed a contact on COMPANY's request and then deleted its account. */
const LEAVER = uuid(0x2746d0014);
/** A verified employer an admin later withdraws and reinstates (owner ruling R2). */
const WITHDRAWN = uuid(0x2746d0015);
/** A login (no `payers` row) whose typed contacts are erased while the switch is off. */
const ERASED_LOGIN = uuid(0x2746d0016);
const COMPANY_POSTING = uuid(0x2746d0020);
const OTHER_POSTING = uuid(0x2746d0021);
const STAFF = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
/** Fixture branch refs: digits (`rto_branch_ref_chk`), none a real RVM location. */
const BRANCH_A = 2746401;
const BRANCH_B = 2746402;
const BRANCH_RETIRED = 2746409;
const COMPANIES = [COMPANY, OTHER, UNVERIFIED, AGENCY, LEAVER, WITHDRAWN];

/** Synthetic contact: no real person or number. */
const CONTACT_NAME = "Fixture Contact t2746d";
const CONTACT_PHONE = "+919000027460";
const ROLES_NOTE = "CNC operators and setters t2746d";

/** Dates relative to today in India, inside the one-year caps (security review L1, L2). */
const TODAY = indiaDay();
const PREFERRED_FROM = addDays(TODAY, 30);
const PREFERRED_TO = addDays(TODAY, 44);
const DRIVE_DAY = addDays(TODAY, 34);

const ON = { CAMPUS_DRIVE_REQUESTS_ROLLOUT: "on" };
const pii = testPii();

describe.skipIf(!RUN)("#2746 PR 6 — campus-drive requests (Postgres)", () => {
  let client!: DbClient;
  let raceClient!: DbClient;
  let events!: EventsService;

  /** The company side over `repo` (and `db` for its other reads), with the switch at `settings`. */
  function companyOver(
    repo: CampusDriveRequestsRepository,
    db: DbClient["db"],
    settings: Record<string, string> = ON,
    pilot: string[] = [],
  ) {
    return new CampusDriveRequestsService(
      repo,
      new PostingAudienceRepository(db),
      rolloutWith(settings, pilot),
      defaultModeResolver(),
      memoryIdempotency(pii).seam,
      pii,
      new EventsService(new EventsRepository(db), { NODE_ENV: "test" } as never),
    );
  }

  function company(db = client.db, settings: Record<string, string> = ON, pilot: string[] = []) {
    return companyOver(new CampusDriveRequestsRepository(db), db, settings, pilot);
  }

  /** Campus's side: no switch and no tenancy (owner ruling R1). */
  function campus(repo = new CampusDriveRequestsRepository(client.db)) {
    return new CampusDriveDecisionsService(repo, pii, events);
  }

  const body = (over: Record<string, unknown> = {}) =>
    PayerCreateCampusDriveRequestSchema.parse({
      branch_ids: [BRANCH_B, BRANCH_A],
      preferred_from: PREFERRED_FROM,
      preferred_to: PREFERRED_TO,
      openings: 12,
      roles_note: ROLES_NOTE,
      contact_name: CONTACT_NAME,
      contact_phone: CONTACT_PHONE,
      ...over,
    });

  const decision = (over: Record<string, unknown> = {}) =>
    CampusDriveDecisionBodySchema.parse({
      decision: "scheduled",
      decided_by_ref: STAFF,
      decided_at: new Date(Date.now() - 60_000).toISOString(),
      scheduled_on: DRIVE_DAY,
      campus_drive_ref: "campus-drive:t2746d",
      ...over,
    });

  const feedOf = async (query: Record<string, string> = {}) =>
    campus().list(CampusDriveRequestsQuerySchema.parse({ limit: "200", ...query }));

  type Stored = {
    id: string;
    payer_id: string;
    created_by: string;
    status: string;
    branch_ids: number[];
    contact_name_enc: string | null;
    contact_phone_enc: string | null;
    contact_erased_at: string | null;
    is_test: boolean;
    idempotency_key: string;
    scheduled_on: string | null;
    updated_at: string;
  };
  async function stored(where: { id?: string; payerId?: string }): Promise<Stored[]> {
    return client.sql<Stored[]>`
      SELECT id, payer_id, created_by, status, branch_ids, contact_name_enc, contact_phone_enc,
             contact_erased_at, is_test, idempotency_key, scheduled_on::text AS scheduled_on,
             updated_at::text AS updated_at
        FROM campus_drive_requests
       WHERE (${where.id ?? null}::uuid IS NULL OR id = ${where.id ?? null}::uuid)
         AND (${where.payerId ?? null}::uuid IS NULL OR payer_id = ${where.payerId ?? null}::uuid)
       ORDER BY created_at, id`;
  }

  async function eventsNamed(name: string): Promise<Record<string, unknown>[]> {
    const rows = await client.sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM events
       WHERE event_name = ${name} AND correlation_id = ${CORRELATION}::uuid
       ORDER BY occurred_at, id`;
    return rows.map((r) => r.payload);
  }

  async function caught(run: () => Promise<unknown>): Promise<unknown> {
    try {
      await run();
    } catch (err) {
      return err;
    }
    return undefined;
  }

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 4 });
    raceClient = createDbClient(DATABASE_URL, { max: 2 });
    await cleanup(client);
    await seed(client);
    events = new EventsService(new EventsRepository(client.db), { NODE_ENV: "test" } as never);
  }, 60_000);

  afterAll(async () => {
    // The race connections first, so no transaction a failed race left open holds a row the
    // cleanup must delete.
    if (raceClient !== undefined) await raceClient.sql.end({ timeout: 5 });
    if (client !== undefined) {
      await cleanup(client);
      await client.sql.end({ timeout: 5 });
    }
  }, 60_000);

  // ── The issue's checks ──────────────────────────────────────────────────────

  it("a company submits a drive request; Campus lists it; after the decision the company sees the scheduled date", async () => {
    const svc = company();
    const made = await svc.create(
      COMPANY,
      body({ job_posting_id: COMPANY_POSTING }),
      "t2746d-key-0001",
      CTX,
    );
    expect(made).toMatchObject({
      status: "requested",
      job_posting_id: COMPANY_POSTING,
      branch_ids: [BRANCH_A, BRANCH_B],
      contact: { name: CONTACT_NAME, phone_last4: "7460" },
      scheduled_on: null,
    });

    // At rest: ciphertext only, the test marker copied, the key stored.
    const [row] = await stored({ id: made.id });
    expect(row).toMatchObject({
      payer_id: COMPANY,
      created_by: COMPANY,
      status: "requested",
      is_test: true,
      idempotency_key: "t2746d-key-0001",
      contact_erased_at: null,
    });
    expect(row!.contact_name_enc).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain(CONTACT_NAME);
    expect(JSON.stringify(row)).not.toContain("9000027460");
    const requested = (await eventsNamed("campus_drive.requested")).filter(
      (p) => p.campus_drive_request_id === made.id,
    );
    expect(requested).toHaveLength(1);
    expect(JSON.stringify(requested)).not.toContain(CONTACT_NAME);

    // Campus's feed: the request, its company name and its contact, decrypted for the team.
    const item = (await feedOf()).drive_requests.find((r) => r.id === made.id);
    expect(item).toMatchObject({
      company: { id: COMPANY, name: "Fixture Works t2746d" },
      company_withdrawn: false,
      job_posting_id: COMPANY_POSTING,
      contact: { name: CONTACT_NAME, phone: CONTACT_PHONE },
      roles_note: ROLES_NOTE,
      status: "requested",
      is_test: true,
    });
    expect(item!.changed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);

    // The decision.
    const decided = await campus().decide(made.id, decision(), CALL);
    expect(decided).toMatchObject({ status: "scheduled", scheduled_on: DRIVE_DAY });
    expect(
      (await eventsNamed("campus_drive.decided")).filter(
        (p) => p.campus_drive_request_id === made.id,
      ),
    ).toHaveLength(1);
    const audits = await client.sql<
      { actor_type: string; actor_id: string; metadata: Record<string, unknown> }[]
    >`
      SELECT actor_type, actor_id::text AS actor_id, metadata FROM audit_logs
       WHERE entity_type = 'campus_drive_request' AND entity_id = ${made.id}::uuid`;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_type: "campus_staff",
      actor_id: STAFF,
      metadata: { decision: "scheduled", campus_call_id: CALL.callId },
    });

    // The company sees the date.
    await expect(svc.getOne(COMPANY, made.id)).resolves.toMatchObject({
      status: "scheduled",
      scheduled_on: DRIVE_DAY,
      campus_drive_ref: "campus-drive:t2746d",
    });
  }, 30_000);

  it("repeating the create with the same Idempotency-Key creates ONE request, after Redis forgot it too", async () => {
    const first = await company().create(COMPANY, body({ openings: 5 }), "t2746d-key-0002", CTX);
    // A fresh service: a fresh, empty Redis, as after the window.
    const again = await company().create(COMPANY, body({ openings: 5 }), "t2746d-key-0002", CTX);
    expect(again.id).toBe(first.id);
    const rows = (await stored({ payerId: COMPANY })).filter(
      (r) => r.idempotency_key === "t2746d-key-0002",
    );
    expect(rows).toHaveLength(1);
    // The same key for a different request is refused, and still writes nothing.
    const err = await caught(() =>
      company().create(COMPANY, body({ openings: 6 }), "t2746d-key-0002", CTX),
    );
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      reason: "idempotency_key_reused",
    });
  }, 30_000);

  it("two creates with one key racing: B's insert waits on A's key, then ON CONFLICT returns no row and B answers A's request", async () => {
    const before = (await eventsNamed("campus_drive.requested")).length;
    const inserts: { who: "A" | "B"; row: DriveRequestRow | undefined }[] = [];

    // A parks INSIDE its transaction right after its insert, holding the key uncommitted.
    const repoA = new CampusDriveRequestsRepository(client.db);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inserted!: () => void;
    const holding = new Promise<void>((r) => (inserted = r));
    let pidA = 0;
    const insertA = repoA.insert.bind(repoA);
    repoA.insert = async (tx, row) => {
      const made = await insertA(tx, row);
      inserts.push({ who: "A", row: made });
      pidA = await backendPid(tx);
      inserted();
      await gate;
      return made;
    };
    const repoB = new CampusDriveRequestsRepository(raceClient.db);
    const insertB = repoB.insert.bind(repoB);
    repoB.insert = async (...args) => {
      const row = await insertB(...args);
      inserts.push({ who: "B", row });
      return row;
    };

    const creatingA = companyOver(repoA, client.db).create(
      COMPANY,
      body({ openings: 7 }),
      "t2746d-key-0003",
      CTX,
    );
    let creatingB: Promise<unknown> | undefined;
    try {
      await holding;
      creatingB = companyOver(repoB, raceClient.db).create(
        COMPANY,
        body({ openings: 7 }),
        "t2746d-key-0003",
        CTX,
      );
      // B's insert is a lock waiter on A's uncommitted key: blocked by A's backend, not any other.
      await waitForLockWaiter(pidA);
      release();
      const [a, b] = await Promise.allSettled([creatingA, creatingB]);
      expect(a.status).toBe("fulfilled");
      expect(b.status).toBe("fulfilled");
      const idA = (a as PromiseFulfilledResult<{ id: string }>).value.id;
      expect((b as PromiseFulfilledResult<{ id: string }>).value.id).toBe(idA);
      // A's insert wrote the row; B's, released after A's commit, returned NO row.
      expect(inserts.map((i) => [i.who, i.row?.id ?? null])).toEqual([
        ["A", idA],
        ["B", null],
      ]);
      expect(
        (await stored({ payerId: COMPANY })).filter((r) => r.idempotency_key === "t2746d-key-0003"),
      ).toHaveLength(1);
      expect(await eventsNamed("campus_drive.requested")).toHaveLength(before + 1);
    } finally {
      release();
      await Promise.allSettled([creatingA, creatingB ?? Promise.resolve()]);
    }
  }, 30_000);

  it("an agency account cannot ask for a drive: the route's 403, and the service refuses it too", async () => {
    const guard = new PayerRoleGuard(new Reflector());
    const handler = (
      PayerCampusDriveRequestsController.prototype as unknown as Record<string, () => unknown>
    ).create!;
    const ctx = {
      getHandler: () => handler,
      getClass: () => PayerCampusDriveRequestsController,
      switchToHttp: () => ({
        getRequest: () => ({ payer: { id: AGENCY, sid: "s", role: "agent" } }),
      }),
    } as unknown as ExecutionContext;
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);

    const err = await caught(() => company().create(AGENCY, body(), "t2746d-key-0004", CTX));
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(await stored({ payerId: AGENCY })).toEqual([]);
  }, 30_000);

  it("an unverified employer gets 403 company_not_verified, naming what is missing", async () => {
    const err = await caught(() => company().create(UNVERIFIED, body(), "t2746d-key-0005", CTX));
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({
      reason: "company_not_verified",
      missing: ["admin_approval", "gst_number"],
    });
    expect(await stored({ payerId: UNVERIFIED })).toEqual([]);
  }, 30_000);

  it("a branch Campus retired is refused; an active one is taken", async () => {
    const err = await caught(() =>
      company().create(COMPANY, body({ branch_ids: [BRANCH_RETIRED] }), "t2746d-key-0006", CTX),
    );
    expect((err as { getResponse(): unknown }).getResponse()).toMatchObject({
      reason: "targeting_option_not_offered",
    });
  }, 30_000);

  // ── Tenancy ─────────────────────────────────────────────────────────────────

  it("another company's request and posting are the same 404 as unknown ones", async () => {
    const mine = await company().create(COMPANY, body({ openings: 9 }), "t2746d-key-0007", CTX);
    const svc = company();
    await expect(svc.getOne(OTHER, mine.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.cancel(OTHER, mine.id, CTX)).rejects.toBeInstanceOf(NotFoundException);
    expect((await svc.list(OTHER, { limit: 100 })).drive_requests.map((r) => r.id)).not.toContain(
      mine.id,
    );
    // A foreign posting on a create is the unknown-posting 404.
    await expect(
      svc.create(COMPANY, body({ job_posting_id: OTHER_POSTING }), "t2746d-key-0008", CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    // Untouched by the foreign cancel.
    expect((await stored({ id: mine.id }))[0]!.status).toBe("requested");
  }, 30_000);

  it("the company list is newest first and keyset-paged on the payer index", async () => {
    const svc = company();
    const all = await svc.list(COMPANY, { limit: 100 });
    expect(all.drive_requests.length).toBeGreaterThanOrEqual(3);
    const created = all.drive_requests.map((r) => r.created_at);
    expect([...created].sort().reverse()).toEqual(created);
    const { decodeDriveCursor } = await import("./campus-drive-cursor");
    const first = await svc.list(COMPANY, { limit: 1 });
    const second = await svc.list(COMPANY, {
      limit: 1,
      cursor: decodeDriveCursor("company", first.next_cursor!)!,
    });
    expect(second.drive_requests[0]!.id).toBe(all.drive_requests[1]!.id);
  }, 30_000);

  // ── Ordering, in SQL ────────────────────────────────────────────────────────

  it("decided_at is compared by Postgres: the same instant in another offset is a replay, an older one superseded", async () => {
    const made = await company().create(COMPANY, body({ openings: 11 }), "t2746d-key-0009", CTX);
    const at = new Date(Date.now() - 120_000);
    const iso = at.toISOString();
    // The same instant written +05:30.
    const ist = new Date(at.getTime() + 5.5 * 3600_000).toISOString().replace("Z", "+05:30");
    await campus().decide(made.id, decision({ decided_at: iso }), CALL);
    const decided = (await eventsNamed("campus_drive.decided")).length;
    await expect(
      campus().decide(made.id, decision({ decided_at: ist }), CALL),
    ).resolves.toMatchObject({
      status: "scheduled",
    });
    expect(await eventsNamed("campus_drive.decided")).toHaveLength(decided);
    const older = new Date(at.getTime() - 1).toISOString();
    const decline = CampusDriveDecisionBodySchema.parse({
      decision: "declined",
      decided_by_ref: STAFF,
      decided_at: older,
    });
    const err = await caught(() => campus().decide(made.id, decline, CALL));
    expect((err as ConflictException).getResponse()).toEqual({ code: "DECISION_SUPERSEDED" });
    // Completed straight from requested is refused by name.
    const fresh = await company().create(COMPANY, body({ openings: 13 }), "t2746d-key-0010", CTX);
    const notAllowed = await caught(() =>
      campus().decide(
        fresh.id,
        CampusDriveDecisionBodySchema.parse({
          decision: "completed",
          decided_by_ref: STAFF,
          decided_at: iso,
        }),
        CALL,
      ),
    );
    expect((notAllowed as ConflictException).getResponse()).toEqual({
      code: "DECISION_NOT_ALLOWED",
      status: "requested",
    });
  }, 30_000);

  it("Campus's feed pages in change order with microsecond cursors, and filters by changed_since", async () => {
    const feed = campus();
    const all: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await feed.list(
        CampusDriveRequestsQuerySchema.parse({ limit: "2", ...(cursor ? { cursor } : {}) }),
      );
      all.push(...page.drive_requests.map((r) => r.id));
      cursor = page.next_cursor;
    } while (cursor);
    // No duplicates, nothing skipped: the same set as one big page.
    const whole = await feedOf();
    expect(new Set(all).size).toBe(all.length);
    expect(all).toEqual(whole.drive_requests.map((r) => r.id));
    const last = whole.drive_requests.at(-1)!;
    const since = await feedOf({ changed_since: last.changed_at });
    expect(since.drive_requests.map((r) => r.id)).toContain(last.id);
  }, 30_000);

  it.each([["0000-01-01T00:00:00Z"], ["1970-01-01T00:00:00Z"]])(
    "a changed_since of %s is clamped to the 2026-01-01 floor before SQL: no 22008, every request listed",
    async (early) => {
      const whole = await feedOf();
      const clamped = await feedOf({ changed_since: early });
      expect(clamped.drive_requests.map((r) => r.id)).toEqual(
        whole.drive_requests.map((r) => r.id),
      );
    },
    30_000,
  );

  // ── Owner ruling R1: the switch gates NEW requests only ─────────────────────

  it("R1: removed from the pilot, then switched off — the company still reads and cancels, Campus still lists and decides, and every change reaches the feed", async () => {
    const pilot = { CAMPUS_DRIVE_REQUESTS_ROLLOUT: "pilot" };
    const made = await company(client.db, pilot, [COMPANY]).create(
      COMPANY,
      body({ openings: 61 }),
      "t2746d-key-0061",
      CTX,
    );
    // Removed from the pilot: no new request…
    const removed = company(client.db, pilot, []);
    await expect(
      removed.create(COMPANY, body({ openings: 62 }), "t2746d-key-0062", CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    // …but the one it made is still its own to read, and Campus still decides it.
    await expect(removed.getOne(COMPANY, made.id)).resolves.toMatchObject({ id: made.id });
    await expect(campus().decide(made.id, decision(), CALL)).resolves.toMatchObject({
      status: "scheduled",
    });
    const since = (await feedOf()).drive_requests.find((r) => r.id === made.id)!.changed_at;

    // Switched off everywhere: create is 404, cancel works, and the cancel reaches the feed.
    const off = company(client.db, { CAMPUS_DRIVE_REQUESTS_ROLLOUT: "off" });
    await expect(
      off.create(COMPANY, body({ openings: 63 }), "t2746d-key-0063", CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(off.cancel(COMPANY, made.id, CTX)).resolves.toMatchObject({
      status: "cancelled",
    });
    const after = await feedOf({ changed_since: since });
    expect(after.drive_requests.find((r) => r.id === made.id)).toMatchObject({
      status: "cancelled",
    });
    // The feed still carries every existing request.
    expect((await feedOf()).drive_requests.map((r) => r.id)).toContain(made.id);
  }, 30_000);

  it("R1: an erasure while the switch is off reaches the feed as contact: null", async () => {
    const [row] = await client.sql<{ id: string }[]>`
      INSERT INTO campus_drive_requests (payer_id, created_by, branch_ids, preferred_from,
             preferred_to, openings, contact_name_enc, contact_phone_enc, idempotency_key)
      VALUES (${COMPANY}::uuid, ${ERASED_LOGIN}::uuid, '[]'::jsonb, ${PREFERRED_FROM}::date,
              ${PREFERRED_TO}::date, 4, ${pii.encrypt(CONTACT_NAME)}, ${pii.encrypt(CONTACT_PHONE)},
              't2746d-key-0064')
      RETURNING id`;
    const since = (await feedOf()).drive_requests.find((r) => r.id === row!.id)!.changed_at;
    expect(
      await new CampusDriveContactErasureRepository(client.db).eraseEnteredBy(ERASED_LOGIN),
    ).toBe(1);
    const after = await feedOf({ changed_since: since });
    expect(after.drive_requests.find((r) => r.id === row!.id)).toMatchObject({ contact: null });
  }, 30_000);

  // ── Owner ruling R2: withdrawn from Campus ──────────────────────────────────

  it("R2 through the REAL admin writers: verification, GSTIN, suspension and archive each re-enter the feed with a newer changed_at, withdrawn; each restore brings the full item back the same way", async () => {
    const made = await company().create(WITHDRAWN, body({ openings: 71 }), "t2746d-key-0071", CTX);
    const companies = new AdminCompaniesRepository(client.db);
    const actions = new AdminActionsRepository(client.db);
    const inTx = <T>(work: (tx: Database) => Promise<T>): Promise<T> =>
      client.db.transaction((tx) => work(tx as unknown as Database));
    const itemOf = async (since?: string) =>
      (await feedOf(since === undefined ? {} : { changed_since: since })).drive_requests.find(
        (r) => r.id === made.id,
      );

    let last = (await itemOf())!;
    expect(last).toMatchObject({ company_withdrawn: false, roles_note: ROLES_NOTE });
    expect(last.contact).toEqual({ name: CONTACT_NAME, phone: CONTACT_PHONE });

    /**
     * After a writer: read from the last `changed_at`, as Campus polls, the request is there with a
     * STRICTLY newer `changed_at` (microsecond UTC text, so a string compare is a time compare), in
     * the withdrawn or the full shape.
     */
    const reenters = async (writer: string, withdrawn: boolean) => {
      const next = await itemOf(last.changed_at);
      expect(next, `${writer}: the request re-entered the feed`).toBeDefined();
      expect(next!.changed_at > last.changed_at, `${writer}: ${next!.changed_at}`).toBe(true);
      if (withdrawn) {
        expect(next, writer).toMatchObject({
          company_withdrawn: true,
          contact: null,
          roles_note: null,
          openings: 71,
          branch_ids: [BRANCH_A, BRANCH_B],
          preferred_from: PREFERRED_FROM,
          preferred_to: PREFERRED_TO,
        });
        expect(JSON.stringify(next), writer).not.toContain(CONTACT_NAME);
      } else {
        expect(next, writer).toMatchObject({ company_withdrawn: false, roles_note: ROLES_NOTE });
        expect(next!.contact, writer).toEqual({ name: CONTACT_NAME, phone: CONTACT_PHONE });
      }
      last = next!;
    };
    const refusedWhileWithdrawn = async (writer: string) => {
      const reschedule = decision({ decided_at: new Date(Date.now() - 1_000).toISOString() });
      const err = await caught(() => campus().decide(made.id, reschedule, CALL));
      expect((err as ConflictException).getResponse(), writer).toMatchObject({
        code: "COMPANY_WITHDRAWN",
      });
    };

    // The admin Companies surface withdraws the verification, then approves the company again.
    await inTx((tx) =>
      companies.upsertProfile("employer", WITHDRAWN, { verificationStatus: "pending" }, tx),
    );
    await reenters("verification withdrawn", true);
    await refusedWhileWithdrawn("verification withdrawn");
    expect((await stored({ id: made.id }))[0]!.status).toBe("requested");
    await inTx((tx) =>
      companies.upsertProfile("employer", WITHDRAWN, { verificationStatus: "verified" }, tx),
    );
    await reenters("verification restored", false);
    await expect(campus().decide(made.id, decision(), CALL)).resolves.toMatchObject({
      status: "scheduled",
    });
    last = (await itemOf())!;

    // The GSTIN removed, then put back.
    await inTx((tx) =>
      companies.upsertProfile(
        "employer",
        WITHDRAWN,
        { gstNumberEnc: null, gstNumberHash: null },
        tx,
      ),
    );
    await reenters("GSTIN removed", true);
    await refusedWhileWithdrawn("GSTIN removed");
    await inTx((tx) =>
      companies.upsertProfile(
        "employer",
        WITHDRAWN,
        { gstNumberEnc: pii.encrypt("27ABCDE1234F1Z5") },
        tx,
      ),
    );
    await reenters("GSTIN restored", false);

    // The account suspended (ADR-0037), then reinstated.
    expect(await inTx((tx) => actions.suspendPayer(WITHDRAWN, tx))).toMatchObject({
      status: "suspended",
    });
    await reenters("suspended", true);
    await refusedWhileWithdrawn("suspended");
    expect(await inTx((tx) => actions.reinstatePayer(WITHDRAWN, tx))).toMatchObject({
      status: "active",
    });
    await reenters("reinstated", false);

    // The company archived (#2564), then restored.
    expect(await inTx((tx) => companies.archiveLogin(WITHDRAWN, tx))).toMatchObject({
      id: WITHDRAWN,
    });
    await reenters("archived", true);
    await refusedWhileWithdrawn("archived");
    expect(await inTx((tx) => companies.restoreLogin(WITHDRAWN, tx))).toMatchObject({
      status: "active",
    });
    await reenters("restored", false);

    // A login stamps payers.updated_at and changes no standing: the request does not move.
    await new PayersRepository(client.db, pii).recordLogin(WITHDRAWN);
    expect((await itemOf())!.changed_at).toBe(last.changed_at);
  }, 30_000);

  // ── The race ────────────────────────────────────────────────────────────────

  /**
   * Holds `run` inside its transaction right after it took the request row lock, until released.
   * Returns a repository whose lock read parks, and the latch to open.
   */
  function parkedAfterLock(db: DbClient["db"]) {
    const repo = new CampusDriveRequestsRepository(db);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const holding = new Promise<void>((r) => (locked = r));
    const parked = { pid: 0 };
    const lockForDecision = repo.lockForDecision.bind(repo);
    repo.lockForDecision = async (tx, id, decidedAt) => {
      const row = await lockForDecision(tx, id, decidedAt);
      parked.pid = await backendPid(tx);
      locked();
      await gate;
      return row;
    };
    const lockOwn = repo.lockOwn.bind(repo);
    repo.lockOwn = async (tx, tenant, id) => {
      const row = await lockOwn(tx, tenant, id);
      parked.pid = await backendPid(tx);
      locked();
      await gate;
      return row;
    };
    return { repo, release, holding, parked };
  }

  /**
   * Waits until a statement on `campus_drive_requests` is blocked by the PARKED transaction's
   * backend (`pg_blocking_pids`), so a lock wait elsewhere in the database cannot pass for it.
   */
  async function waitForLockWaiter(blockerPid: number): Promise<void> {
    expect(blockerPid, "the parked transaction's backend pid").toBeGreaterThan(0);
    for (let i = 0; i < 100; i += 1) {
      const [row] = await client.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database()
           AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
           AND query ILIKE '%campus_drive_requests%'`;
      if ((row?.n ?? 0) >= 1) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no statement waited on the parked backend ${blockerPid}`);
  }

  it("decision first, cancel waits: the drive is scheduled, then cancelled from scheduled; no 40P01", async () => {
    const made = await company().create(COMPANY, body({ openings: 21 }), "t2746d-key-0021", CTX);
    const parked = parkedAfterLock(raceClient.db);
    const deciding = campus(parked.repo).decide(made.id, decision(), CALL);
    let cancelling: Promise<unknown> | undefined;
    try {
      await parked.holding;
      cancelling = company().cancel(COMPANY, made.id, CTX);
      await waitForLockWaiter(parked.parked.pid);
      parked.release();
      const [decided, cancelled] = await Promise.allSettled([deciding, cancelling]);
      for (const r of [decided, cancelled]) {
        if (r.status === "rejected") expect(sqlStateOf(r.reason)).not.toBe("40P01");
      }
      expect(decided).toMatchObject({ status: "fulfilled", value: { status: "scheduled" } });
      expect(cancelled).toMatchObject({ status: "fulfilled", value: { status: "cancelled" } });
      const cancels = (await eventsNamed("campus_drive.cancelled")).filter(
        (p) => p.campus_drive_request_id === made.id,
      );
      expect(cancels).toEqual([
        { campus_drive_request_id: made.id, payer_id: COMPANY, previous_status: "scheduled" },
      ]);
    } finally {
      parked.release();
      await Promise.allSettled([deciding, cancelling ?? Promise.resolve()]);
    }
  }, 30_000);

  it("cancel first, decision waits: cancelled stands, the decision is DECISION_NOT_ALLOWED and stores nothing; no 40P01", async () => {
    const made = await company().create(COMPANY, body({ openings: 22 }), "t2746d-key-0022", CTX);
    const parked = parkedAfterLock(raceClient.db);
    const cancelling = companyOver(parked.repo, raceClient.db).cancel(COMPANY, made.id, CTX);
    let deciding: Promise<unknown> | undefined;
    try {
      await parked.holding;
      deciding = campus().decide(made.id, decision(), CALL);
      await waitForLockWaiter(parked.parked.pid);
      parked.release();
      const [cancelled, decided] = await Promise.allSettled([cancelling, deciding]);
      expect(cancelled).toMatchObject({ status: "fulfilled", value: { status: "cancelled" } });
      expect(decided.status).toBe("rejected");
      const reason = (decided as PromiseRejectedResult).reason;
      expect(sqlStateOf(reason)).not.toBe("40P01");
      expect(reason).toBeInstanceOf(ConflictException);
      expect((reason as ConflictException).getResponse()).toEqual({
        code: "DECISION_NOT_ALLOWED",
        status: "cancelled",
      });
      const [row] = await stored({ id: made.id });
      expect(row).toMatchObject({ status: "cancelled", scheduled_on: null });
      const decidedEvents = (await eventsNamed("campus_drive.decided")).filter(
        (p) => p.campus_drive_request_id === made.id,
      );
      expect(decidedEvents).toEqual([]);
    } finally {
      parked.release();
      await Promise.allSettled([cancelling, deciding ?? Promise.resolve()]);
    }
  }, 30_000);

  // ── DPDP erasure ────────────────────────────────────────────────────────────

  it("cdr_contact_chk refuses a half-erasure: the contact is both ciphertexts or neither, dated", async () => {
    const made = await company().create(COMPANY, body({ openings: 31 }), "t2746d-key-0031", CTX);
    const err = await caught(
      () =>
        client.sql`UPDATE campus_drive_requests SET contact_name_enc = NULL WHERE id = ${made.id}::uuid`,
    );
    expect(sqlStateOf(err)).toBe("23514");
    const undated = await caught(
      () => client.sql`
        UPDATE campus_drive_requests SET contact_name_enc = NULL, contact_phone_enc = NULL
         WHERE id = ${made.id}::uuid`,
    );
    expect(sqlStateOf(undated)).toBe("23514");
  }, 30_000);

  /**
   * MUST CHANGE WHEN #2811 LANDS. This proves a delete that fails erases nothing, and today the
   * QA delete fails for every verified company because `employer_profiles_payer_id_fkey` is
   * NO ACTION. Once #2811 makes that delete succeed, this test needs another way to make the row
   * delete fail (for example a fixture row holding a RESTRICT foreign key), or it starts proving
   * the opposite.
   */
  it("a QA delete that FAILS (the employer_profiles FK holds a verified company) erases no contact", async () => {
    // A request OTHER owns that COMPANY's login typed: erased if the erasure ever committed alone.
    const [row] = await client.sql<{ id: string }[]>`
      INSERT INTO campus_drive_requests (payer_id, created_by, branch_ids, preferred_from,
             preferred_to, openings, contact_name_enc, contact_phone_enc, idempotency_key)
      VALUES (${OTHER}::uuid, ${COMPANY}::uuid, '[]'::jsonb, ${PREFERRED_FROM}::date,
              ${PREFERRED_TO}::date, 2, ${pii.encrypt(CONTACT_NAME)}, ${pii.encrypt(CONTACT_PHONE)},
              't2746d-key-0039')
      RETURNING id`;
    const deletion = new PayerAccountDeletionService(
      client.db,
      new PayersRepository(client.db, pii),
      { revokeAllForPayer: async () => 0 } as never,
      events,
      new CampusDriveContactErasureRepository(client.db),
    );
    // COMPANY has an employer_profiles row (it is verified), and that FK is NO ACTION.
    const err = await caught(() => deletion.execute(COMPANY, CTX));
    expect(sqlStateOf(err)).toBe("23503");

    const [payer] = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM payers WHERE id = ${COMPANY}::uuid`;
    expect(payer!.n).toBe(1);
    const [after] = await stored({ id: row!.id });
    expect(after!.contact_erased_at).toBeNull();
    expect(after!.contact_name_enc).toMatch(/^v1\./);
    expect(after!.contact_phone_enc).toMatch(/^v1\./);
    // COMPANY's own requests are intact too, contacts and all (the R1 erasure test's row aside:
    // a different login typed it).
    const own = (await stored({ payerId: COMPANY })).filter((r) => r.created_by === COMPANY);
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((r) => r.contact_erased_at === null && r.contact_name_enc !== null)).toBe(
      true,
    );
  }, 30_000);

  it("deleting a login erases the contacts it entered on requests that outlive it; Campus then lists contact: null", async () => {
    // A request COMPANY owns but LEAVER typed (as a team member under org tenancy `on`).
    const [row] = await client.sql<{ id: string; updated_at: string }[]>`
      INSERT INTO campus_drive_requests (payer_id, created_by, branch_ids, preferred_from,
             preferred_to, openings, contact_name_enc, contact_phone_enc, idempotency_key)
      VALUES (${COMPANY}::uuid, ${LEAVER}::uuid, '[]'::jsonb, ${PREFERRED_FROM}::date,
              ${PREFERRED_TO}::date, 3, ${pii.encrypt(CONTACT_NAME)}, ${pii.encrypt(CONTACT_PHONE)},
              't2746d-key-0041')
      RETURNING id, updated_at::text AS updated_at`;
    const deletion = new PayerAccountDeletionService(
      client.db,
      new PayersRepository(client.db, pii),
      { revokeAllForPayer: async () => 0 } as never,
      events,
      new CampusDriveContactErasureRepository(client.db),
    );
    const out = await deletion.execute(LEAVER, CTX);
    expect(out.deleted).toBe(true);

    const [after] = await stored({ id: row!.id });
    expect(after).toMatchObject({
      payer_id: COMPANY,
      contact_name_enc: null,
      contact_phone_enc: null,
      status: "requested",
    });
    expect(after!.contact_erased_at).not.toBeNull();
    expect(Date.parse(after!.updated_at)).toBeGreaterThan(Date.parse(row!.updated_at));

    const item = (await feedOf()).drive_requests.find((r) => r.id === row!.id);
    expect(item?.contact).toBeNull();
    await expect(company().getOne(COMPANY, row!.id)).resolves.toMatchObject({ contact: null });
    // Erasing again changes nothing.
    expect(await new CampusDriveContactErasureRepository(client.db).eraseEnteredBy(LEAVER)).toBe(0);
  }, 30_000);

  it("a company's own requests go with its payers row (ON DELETE CASCADE)", async () => {
    const made = await company().create(OTHER, body({ openings: 51 }), "t2746d-key-0051", CTX);
    await client.sql`DELETE FROM employer_profiles WHERE payer_id = ${OTHER}::uuid`;
    await client.sql`DELETE FROM job_postings WHERE payer_id = ${OTHER}::uuid`;
    await client.sql`DELETE FROM payers WHERE id = ${OTHER}::uuid`;
    expect(await stored({ id: made.id })).toEqual([]);
  }, 30_000);
});

/** The backend pid of the connection running `tx`. */
async function backendPid(tx: Database): Promise<number> {
  const rows = (await tx.execute(sql`SELECT pg_backend_pid()::int AS pid`)) as unknown as {
    pid: number;
  }[];
  return Number(rows[0]!.pid);
}

async function seed(client: DbClient): Promise<void> {
  const { sql } = client;
  const payer = (id: string, role: "employer" | "agent", name: string, isTest = false) => sql`
    INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status, is_test_account)
    VALUES (${id}::uuid, ${role}, ${`enc:t2746d-${id.slice(-4)}`}, ${`hash:t2746d-${id.slice(-4)}`},
            ${pii.encrypt(name)}, 'active', ${isTest})`;
  await payer(COMPANY, "employer", " Fixture Works t2746d ", true);
  await payer(OTHER, "employer", "Other Fixture Works t2746d");
  await payer(UNVERIFIED, "employer", "Unverified Works t2746d");
  await payer(AGENCY, "agent", "Fixture Agency t2746d");
  await payer(LEAVER, "employer", "Leaver Login t2746d");
  await payer(WITHDRAWN, "employer", "Withdrawn Works t2746d");
  for (const id of [COMPANY, OTHER, WITHDRAWN]) {
    await sql`
      INSERT INTO employer_profiles (payer_id, verification_status, gst_number_enc)
      VALUES (${id}::uuid, 'verified', ${pii.encrypt("27ABCDE1234F1Z5")})`;
  }
  await sql`
    INSERT INTO employer_profiles (payer_id, verification_status) VALUES (${UNVERIFIED}::uuid, 'pending')`;
  await sql`
    INSERT INTO rvm_targeting_options (kind, ref, label, active, sort_order) VALUES
      ('branch', ${String(BRANCH_A)}, 'Fixture branch A t2746d', true, 1),
      ('branch', ${String(BRANCH_B)}, 'Fixture branch B t2746d', true, 2),
      ('branch', ${String(BRANCH_RETIRED)}, 'Fixture retired t2746d', false, 3)`;
  for (const [id, owner] of [
    [COMPANY_POSTING, COMPANY],
    [OTHER_POSTING, OTHER],
  ] as const) {
    await sql`
      INSERT INTO job_postings (id, created_by, payer_id, org_label, role_title, vacancy_band)
      VALUES (${id}::uuid, ${owner}::uuid, ${owner}::uuid, 'Fixture t2746d', 'CNC Operator t2746d', '2-5')`;
  }
}

async function cleanup(client: DbClient): Promise<void> {
  const { sql } = client;
  await sql`DELETE FROM campus_drive_requests WHERE payer_id = ANY(${COMPANIES}::uuid[])`;
  await sql`DELETE FROM job_postings WHERE payer_id = ANY(${COMPANIES}::uuid[])`;
  await sql`DELETE FROM employer_profiles WHERE payer_id = ANY(${COMPANIES}::uuid[])`;
  await sql`
    DELETE FROM audit_logs
     WHERE action = 'campus_link.drive_request_decided' AND metadata->>'payer_id' = ANY(${COMPANIES})`;
  await sql`
    DELETE FROM rvm_targeting_options
     WHERE kind = 'branch' AND ref IN (${String(BRANCH_A)}, ${String(BRANCH_B)}, ${String(BRANCH_RETIRED)})`;
  await sql`DELETE FROM payer_members WHERE member_payer_id = ANY(${COMPANIES}::uuid[])`;
  await sql`DELETE FROM payer_orgs WHERE root_payer_id = ANY(${COMPANIES}::uuid[])`;
  await sql`DELETE FROM payers WHERE id = ANY(${COMPANIES}::uuid[])`;
  await sql`DELETE FROM events WHERE correlation_id = ${CORRELATION}::uuid`;
}
