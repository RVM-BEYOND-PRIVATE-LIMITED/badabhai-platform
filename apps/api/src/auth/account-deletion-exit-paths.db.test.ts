import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { auditLogs, createDbClient, events, workers, type DbClient } from "@badabhai/db";

import type { PiiCryptoService } from "../common/pii-crypto.service";
import type { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import type { ConsentRepository } from "../consent/consent.repository";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import type { StorageService } from "../storage/storage.service";
import { WorkersRepository } from "../workers/workers.repository";
import { AccountDeletionSweepProcessor } from "./account-deletion-sweep.processor";
import { AccountDeletionService } from "./account-deletion.service";
import { AuthController } from "./auth.controller";
import type { AuthService } from "./auth.service";
import { ErasureAuditRepository } from "./erasure-audit.repository";
import type { OtpRequestIdempotency } from "./otp-request-idempotency.service";
import type { OtpService } from "./otp.service";
import type { ErasableRefreshCapture, SessionService } from "./session.service";

/**
 * #2753 item 13 — ONE `worker.account_deleted` ON EVERY EXIT PATH, against a real Postgres.
 *
 * The exit paths that run `AccountDeletionService.execute`, each driven through its own entry
 * point, with `ACCOUNT_DELETION_EVENT_IN_TX` off (today: delete, then emit) and on (fix A-14: the
 * event on the delete's transaction):
 *   - the grace sweep (`AccountDeletionSweepProcessor.process`, ADR-0031);
 *   - the QA immediate seam (`AuthController.accountDeleteImmediate`);
 *   - two runs racing on one worker, which the sweep's claim does not prevent (it touches
 *     `updated_at` and locks nothing);
 *   - a re-run after the erasure (the row is gone: a no-op).
 * The campus-link path (`InstituteLinkService.unlinkStudent`, `campus_request`) is the fourth
 * deleter and is proved in `campus-link/institute-tag-rules.db.test.ts`. There is no admin path
 * that erases a worker; `workers/worker-exit-paths.static.test.ts` fails if one appears.
 *
 * The events table is the store under test, so it is real; so are the workers row and the erasure
 * audit. Sessions, storage and Redis are doubles: they touch no row this file counts.
 *
 * Run it through a throwaway LOCAL database only:
 *   RUN_DB_TESTS=1 DATABASE_URL=postgres://…localhost… pnpm --filter @badabhai/api run test account-deletion-exit-paths.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function assertLocalDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`account-deletion-exit-paths.db refuses a non-local host (${host})`);
  }
}

const NO_CAPTURE: ErasableRefreshCapture = { entries: [], candidates: 0, dropped: 0 };

function config(eventInTx: boolean): ServerConfig {
  return {
    RESUMES_BUCKET: "worker-resumes",
    CONVERSATIONS_BUCKET: "worker-conversations",
    VOICE_NOTES_BUCKET: "",
    WORKER_PHOTOS_BUCKET: "",
    WORKER_FEEDBACK_ATTACHMENTS_BUCKET: "",
    WORKER_PORTFOLIO_BUCKET: "",
    RESUME_UPLOADS_BUCKET: "",
    ACCOUNT_DELETION_COOLDOWN_SECONDS: 604800,
    ACCOUNT_DELETION_GRACE_DAYS: 7,
    ACCOUNT_DELETION_SWEEP_INTERVAL_HOURS: 1,
    ACCOUNT_DELETION_EVENT_IN_TX: eventInTx,
    TEST_IMMEDIATE_DELETE_ENABLED: true,
    TEST_IMMEDIATE_DELETE_WORKER_IDS: [] as readonly string[],
  } as unknown as ServerConfig;
}

/**
 * Holds every caller of `revokeAll` until `parties` callers have arrived. `revokeAll` runs after
 * `execute`'s `findById`, so two runs that both reach it have both seen the row: the race is
 * forced, not hoped for.
 */
function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const open = new Promise<void>((resolve) => (release = resolve));
  return async () => {
    arrived += 1;
    if (arrived >= parties) release();
    await open;
  };
}

describe.skipIf(!RUN)("#2753 item 13 — one deletion event on every exit path (Postgres)", () => {
  let client!: DbClient;
  let workersRepo!: WorkersRepository;
  let eventsService!: EventsService;
  let erasureAudit!: ErasureAuditRepository;
  /** Only the workers this file created are due to the sweep it drives. */
  const mine = new Set<string>();

  /** A workers repository whose sweep work list is this file's rows only (the predicate is real). */
  class ScopedWorkersRepository extends WorkersRepository {
    override async findDueDeletions(now: Date, limit: number): Promise<string[]> {
      return (await super.findDueDeletions(now, 10_000))
        .filter((id) => mine.has(id))
        .slice(0, limit);
    }
  }

  function service(eventInTx: boolean, beforeRevoke?: () => Promise<void>): AccountDeletionService {
    const sessions = {
      captureErasableRefreshTokens: async () => NO_CAPTURE,
      revokeAll: async () => {
        await beforeRevoke?.();
        return 0;
      },
      markRefreshTokensErased: async () => 0,
    };
    const storage = { deletePdf: async () => undefined, deleteByPrefix: async () => 0 };
    const queue = { client: Promise.resolve({ set: async () => "OK", del: async () => 0 }) };
    return new AccountDeletionService(
      config(eventInTx),
      workersRepo,
      sessions as unknown as SessionService,
      storage as unknown as StorageService,
      eventsService,
      erasureAudit,
      queue as unknown as Queue,
    );
  }

  async function insertWorker(opts: { dueForDeletion?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    mine.add(id);
    await client.db.insert(workers).values({
      id,
      phoneE164: "v1.exit-paths-db-test",
      phoneHash: `exit-paths-db-test-${id}`,
      status: "active" as const,
      deletionScheduledAt: opts.dueForDeletion ? new Date(Date.now() - 60_000) : null,
    });
    return id;
  }

  const rowExists = async (id: string) =>
    (await client.db.select({ id: workers.id }).from(workers).where(eq(workers.id, id))).length > 0;
  const deletionEvents = (id: string) =>
    client.db
      .select({ id: events.id, key: events.idempotencyKey })
      .from(events)
      .where(and(eq(events.subjectId, id), eq(events.eventName, "worker.account_deleted")));

  beforeAll(async () => {
    assertLocalDatabase(DATABASE_URL);
    client = createDbClient(DATABASE_URL, { max: 4 });
    workersRepo = new ScopedWorkersRepository(client.db);
    eventsService = new EventsService(new EventsRepository(client.db), {
      NODE_ENV: "test",
    } as never);
    erasureAudit = new ErasureAuditRepository(client.db);
  });

  afterAll(async () => {
    if (!client) return;
    try {
      const ids = [...mine];
      if (ids.length > 0) {
        await client.db.delete(events).where(inArray(events.subjectId, ids));
        await client.db.delete(auditLogs).where(inArray(auditLogs.entityId, ids));
        await client.db.delete(workers).where(inArray(workers.id, ids));
      }
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  });

  describe.each([false, true])("ACCOUNT_DELETION_EVENT_IN_TX=%s", (eventInTx) => {
    let svc!: AccountDeletionService;
    beforeEach(() => {
      svc = service(eventInTx);
    });

    it("the grace sweep erases a due worker and writes exactly one", async () => {
      const id = await insertWorker({ dueForDeletion: true });
      const sweep = new AccountDeletionSweepProcessor(
        workersRepo,
        svc,
        {} as Queue,
        config(eventInTx),
      );

      await expect(sweep.process()).resolves.toEqual({ due: 1, erased: 1 });

      expect(await rowExists(id)).toBe(false);
      expect(await deletionEvents(id)).toEqual([
        { id: expect.any(String), key: `worker.account_deleted:${id}` },
      ]);
      // The next tick finds nothing due and writes nothing more.
      await expect(sweep.process()).resolves.toEqual({ due: 0, erased: 0 });
      expect(await deletionEvents(id)).toHaveLength(1);
    });

    it("the QA immediate seam erases the caller and writes exactly one", async () => {
      const id = await insertWorker();
      const controller = new AuthController(
        {} as AuthService,
        {} as SessionService,
        workersRepo,
        {} as IpRateLimit,
        {} as OtpService,
        {} as PiiCryptoService,
        svc,
        {} as ConsentRepository,
        {} as OtpRequestIdempotency,
        config(eventInTx),
      );

      await expect(controller.accountDeleteImmediate({ id, sid: "sid-1" })).resolves.toEqual({
        ok: true,
      });

      expect(await rowExists(id)).toBe(false);
      expect(await deletionEvents(id)).toHaveLength(1);
    });

    it("two runs that both saw the row still write exactly one", async () => {
      const id = await insertWorker();
      const wait = barrier(2);
      const racing = service(eventInTx, wait);

      await Promise.all([racing.execute(id), racing.execute(id)]);

      expect(await rowExists(id)).toBe(false);
      expect(await deletionEvents(id)).toHaveLength(1);
    });

    it("a re-run after the erasure is a no-op and writes nothing more", async () => {
      const id = await insertWorker();
      await svc.execute(id);
      await svc.execute(id);

      expect(await deletionEvents(id)).toHaveLength(1);
    });
  });
});
