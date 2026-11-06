import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  applyCostLedgerBackfill,
  createDbClient,
  events,
  planCostLedgerBackfill,
  profileCompletionLedger,
  workers,
  type DbClient,
} from "@badabhai/db";
import { ProfileCompletionLedgerRepository } from "../profiles/profile-completion-ledger.repository";

/**
 * B2 (#2555) — the completed-profile ledger, against a REAL Postgres.
 *
 * WHAT ONLY THE DATABASE CAN PROVE HERE:
 *
 *   1. `resolveTestFlag` reads the live row, and re-tags a deleted account from its
 *      `worker.test_login` event — a three-state rule (live flag / test-login / real)
 *      over two tables, where the wrong branch silently mis-buckets spend forever.
 *   2. The ledger insert and the completion event commit TOGETHER — the same-tx
 *      property the processor promises. A stubbed `withTransaction` can only prove
 *      the right function was CALLED; only Postgres proves a failure rolls both back.
 *   3. The backfill is IDEMPOTENT and REPORTS its re-tags: plan → apply → plan must
 *      converge to zero writes, and a deleted test account must surface in the
 *      `retaggedDeletedTest` count (the acceptance criterion's re-tag half).
 *
 * The dashboard half of the acceptance criterion (real spend/count unchanged across
 * a create → finish → delete cycle) lives in `admin-dashboard.db.test.ts`, which
 * reads the finished figures through `service.summary()`.
 *
 * ── HOW TO RUN ───────────────────────────────────────────────────────────────────
 *   pnpm db:migrate
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api run test admin-cost-ledger.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const WORKER_LIVE_TEST = uuid(0xc001);
const WORKER_LIVE_REAL = uuid(0xc002);
const WORKER_DELETED_TEST = uuid(0xc003);
const WORKER_DELETED_REAL = uuid(0xc004);
const PROFILE_LIVE_TEST = uuid(0xc011);
const PROFILE_LIVE_REAL = uuid(0xc012);
const PROFILE_DELETED_TEST = uuid(0xc013);
const PROFILE_DELETED_REAL = uuid(0xc014);
const PROFILE_ATOMIC_OK = uuid(0xc015);
const PROFILE_ATOMIC_ROLLBACK = uuid(0xc016);
const CORRELATION = uuid(0xc0ff);

describe.skipIf(!RUN)("admin cost ledger (B2 #2555) against a real database", () => {
  let client!: DbClient;
  let repo!: ProfileCompletionLedgerRepository;

  async function cleanup(): Promise<void> {
    for (const id of [
      PROFILE_LIVE_TEST,
      PROFILE_LIVE_REAL,
      PROFILE_DELETED_TEST,
      PROFILE_DELETED_REAL,
      PROFILE_ATOMIC_OK,
      PROFILE_ATOMIC_ROLLBACK,
    ]) {
      await client.db
        .delete(profileCompletionLedger)
        .where(eq(profileCompletionLedger.profileId, id));
    }
    for (const id of [
      WORKER_LIVE_TEST,
      WORKER_LIVE_REAL,
      WORKER_DELETED_TEST,
      WORKER_DELETED_REAL,
    ]) {
      await client.db.delete(workers).where(eq(workers.id, id));
    }
    await client.db.delete(events).where(eq(events.correlationId, CORRELATION));
  }

  beforeAll(async () => {
    if (!RUN) return;
    client = createDbClient(DATABASE_URL, { max: 1 });
    repo = new ProfileCompletionLedgerRepository(client.db as never);
    await cleanup();

    await client.db.insert(workers).values([
      {
        id: WORKER_LIVE_TEST,
        phoneE164: "b2-live-test",
        phoneHash: uuid(0xcc01),
        status: "active",
        isTestAccount: true,
      },
      {
        id: WORKER_LIVE_REAL,
        phoneE164: "b2-live-real",
        phoneHash: uuid(0xcc02),
        status: "active",
        isTestAccount: false,
      },
      {
        id: WORKER_DELETED_TEST,
        phoneE164: "b2-del-test",
        phoneHash: uuid(0xcc03),
        status: "active",
        isTestAccount: true,
      },
      {
        id: WORKER_DELETED_REAL,
        phoneE164: "b2-del-real",
        phoneHash: uuid(0xcc04),
        status: "active",
        isTestAccount: false,
      },
    ]);
    // The deleted test account test-logged-in (the re-tag signal); the deleted real
    // one only ever OTP'd (no test_login row anywhere).
    await client.db.insert(events).values([
      {
        eventName: "worker.test_login",
        eventVersion: 1,
        occurredAt: new Date("2026-09-01T00:00:00.000Z"),
        actorType: "worker",
        actorId: WORKER_DELETED_TEST,
        subjectType: "worker",
        subjectId: WORKER_DELETED_TEST,
        correlationId: CORRELATION,
        payload: { worker_id: WORKER_DELETED_TEST, phone_hash: uuid(0xcc03), is_new_worker: true },
      },
      {
        eventName: "worker.otp_verified",
        eventVersion: 1,
        occurredAt: new Date("2026-09-01T00:00:00.000Z"),
        actorType: "worker",
        actorId: WORKER_DELETED_REAL,
        subjectType: "worker",
        subjectId: WORKER_DELETED_REAL,
        correlationId: CORRELATION,
        payload: { worker_id: WORKER_DELETED_REAL, phone_hash: uuid(0xcc04), is_new_worker: true },
      },
    ]);
    // Erase both — the spine rows above survive; the worker rows do not.
    await client.db
      .delete(workers)
      .where(inArray(workers.id, [WORKER_DELETED_TEST, WORKER_DELETED_REAL]));
  });

  afterAll(async () => {
    if (!client) return;
    await cleanup();
    await client.sql.end({ timeout: 5 });
  });

  it("resolveTestFlag reads the live row, and re-tags the deleted from test_login", async () => {
    await repo.withTransaction(async (tx) => {
      // Live rows: the flag as stored.
      await expect(repo.resolveTestFlag(WORKER_LIVE_TEST, tx)).resolves.toBe(true);
      await expect(repo.resolveTestFlag(WORKER_LIVE_REAL, tx)).resolves.toBe(false);
      // Deleted rows: the test-login event is the whole signal — no decryption.
      await expect(repo.resolveTestFlag(WORKER_DELETED_TEST, tx)).resolves.toBe(true);
      await expect(repo.resolveTestFlag(WORKER_DELETED_REAL, tx)).resolves.toBe(false);
    });
  });

  it("insert is idempotent per profile — a redelivery converges, never doubles", async () => {
    const row = {
      profileId: PROFILE_LIVE_TEST,
      chatSessionId: null,
      aiJobId: null,
      workerId: WORKER_LIVE_TEST,
      completedAt: new Date("2026-09-10T00:00:00.000Z"),
      isTestAccount: true,
      source: "extraction" as const,
    };
    await repo.withTransaction(async (tx) => {
      await repo.insert(row, tx);
      await repo.insert(row, tx);
    });
    const rows = await client.db
      .select()
      .from(profileCompletionLedger)
      .where(eq(profileCompletionLedger.profileId, PROFILE_LIVE_TEST));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ isTestAccount: true, source: "extraction" });
    // No PII beyond opaque ids: the row carries ids, a timestamp, a boolean and a
    // closed source — assert the shape, not just the absence of one field.
    expect(Object.keys(rows[0]!).sort()).toEqual(
      [
        "profileId",
        "chatSessionId",
        "aiJobId",
        "workerId",
        "completedAt",
        "isTestAccount",
        "source",
      ].sort(),
    );
  });

  it("ledger row and completion event commit together — and roll back together", async () => {
    const eventValues = (profileId: string) => ({
      eventName: "profile.extraction_completed",
      eventVersion: 1,
      occurredAt: new Date("2026-09-10T00:00:00.000Z"),
      actorType: "ai_service",
      subjectType: "profile",
      subjectId: profileId,
      correlationId: CORRELATION,
      payload: { worker_id: WORKER_LIVE_REAL, profile_id: profileId, profile_status: "extracted" },
    });

    // The happy path: both land.
    await repo.withTransaction(async (tx) => {
      await repo.insert(
        {
          profileId: PROFILE_ATOMIC_OK,
          chatSessionId: null,
          aiJobId: null,
          workerId: WORKER_LIVE_REAL,
          completedAt: new Date("2026-09-10T00:00:00.000Z"),
          isTestAccount: false,
          source: "extraction",
        },
        tx,
      );
      await tx.insert(events).values(eventValues(PROFILE_ATOMIC_OK));
    });

    // The failure path: the event insert throws mid-transaction, so the ledger row
    // must not survive it either — half a completion is the state this tx exists to
    // prevent.
    await expect(
      repo.withTransaction(async (tx) => {
        await repo.insert(
          {
            profileId: PROFILE_ATOMIC_ROLLBACK,
            chatSessionId: null,
            aiJobId: null,
            workerId: WORKER_LIVE_REAL,
            completedAt: new Date("2026-09-10T00:00:00.000Z"),
            isTestAccount: false,
            source: "extraction",
          },
          tx,
        );
        await tx.insert(events).values(eventValues(PROFILE_ATOMIC_ROLLBACK));
        throw new Error("boom — the event write next door just failed");
      }),
    ).rejects.toThrow("boom");

    const ledgerRows = await client.db
      .select({ profileId: profileCompletionLedger.profileId })
      .from(profileCompletionLedger)
      .where(
        inArray(profileCompletionLedger.profileId, [PROFILE_ATOMIC_OK, PROFILE_ATOMIC_ROLLBACK]),
      );
    expect(ledgerRows.map((r) => r.profileId)).toEqual([PROFILE_ATOMIC_OK]);
    const eventRows = await client.db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.correlationId, CORRELATION));
    // Only the two fixture events (test_login + otp_verified) plus the committed one.
    expect(eventRows).toHaveLength(3);
  });

  it("backfill plans every finished completion, re-tags the deleted, and converges", async () => {
    const completion = (
      profileId: string,
      workerId: string,
      status: string,
      occurredAt: string,
    ) => ({
      eventName: "profile.extraction_completed",
      eventVersion: 1,
      occurredAt: new Date(occurredAt),
      actorType: "ai_service",
      subjectType: "profile",
      subjectId: profileId,
      correlationId: CORRELATION,
      payload: {
        worker_id: workerId,
        profile_id: profileId,
        ai_job_id: profileId,
        profile_status: status,
      },
    });
    // Four finished completions: live test, live real, deleted test, deleted real —
    // plus a draft that must never produce a row.
    await client.db
      .insert(events)
      .values([
        completion(PROFILE_LIVE_TEST, WORKER_LIVE_TEST, "extracted", "2026-09-10T00:00:00.000Z"),
        completion(PROFILE_LIVE_REAL, WORKER_LIVE_REAL, "confirmed", "2026-09-10T00:00:00.000Z"),
        completion(
          PROFILE_DELETED_TEST,
          WORKER_DELETED_TEST,
          "extracted",
          "2026-09-10T00:00:00.000Z",
        ),
        completion(
          PROFILE_DELETED_REAL,
          WORKER_DELETED_REAL,
          "extracted",
          "2026-09-10T00:00:00.000Z",
        ),
        completion(uuid(0xc099), WORKER_LIVE_REAL, "draft", "2026-09-10T00:00:00.000Z"),
      ]);

    const plan = await planCostLedgerBackfill(client.db);
    // Scope to this file's fixtures: the planner reads the whole shared spine, and
    // other suites' rows must not move this file's assertions (the delta convention).
    const MINE = new Set([
      PROFILE_LIVE_TEST,
      PROFILE_LIVE_REAL,
      PROFILE_DELETED_TEST,
      PROFILE_DELETED_REAL,
    ]);
    const mine = plan.rows.filter((r) => MINE.has(r.profileId));
    // Four finished, one draft ignored. PROFILE_LIVE_TEST already has a row (the
    // idempotency test above wrote it), so three rows are planned.
    expect(mine).toHaveLength(3);
    const byProfile = new Map(mine.map((r) => [r.profileId, r]));
    expect(byProfile.get(PROFILE_LIVE_REAL)).toMatchObject({
      isTestAccount: false,
      workerId: WORKER_LIVE_REAL,
    });
    expect(byProfile.get(PROFILE_DELETED_TEST)).toMatchObject({
      isTestAccount: true,
      workerId: WORKER_DELETED_TEST,
    });
    expect(byProfile.get(PROFILE_DELETED_REAL)).toMatchObject({
      isTestAccount: false,
      workerId: WORKER_DELETED_REAL,
    });
    // The re-tag report names its count: the deleted test account surfaces here.
    // Global floors, not exacts — another suite's rows share the spine.
    expect(plan.retaggedDeletedTest).toBeGreaterThanOrEqual(1);
    expect(plan.retaggedDeletedReal).toBeGreaterThanOrEqual(1);

    const inserted = await applyCostLedgerBackfill(client.db, { ...plan, rows: mine });
    expect(inserted).toBe(3);

    // Converges: a second plan finds nothing of ours to write.
    const again = await planCostLedgerBackfill(client.db);
    expect(again.rows.filter((r) => MINE.has(r.profileId))).toHaveLength(0);

    // The ledger now attributes the deleted test account to `test` without any join.
    const flagged = await client.db
      .select({ profileId: profileCompletionLedger.profileId })
      .from(profileCompletionLedger)
      .where(eq(profileCompletionLedger.isTestAccount, true));
    expect(flagged.map((r) => r.profileId)).toEqual(
      expect.arrayContaining([PROFILE_DELETED_TEST, PROFILE_LIVE_TEST]),
    );
  });
});
