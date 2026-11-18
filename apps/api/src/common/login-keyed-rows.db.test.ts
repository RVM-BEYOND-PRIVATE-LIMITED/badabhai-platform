import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger, UnauthorizedException } from "@nestjs/common";
import { inArray, sql as dsql } from "drizzle-orm";
import { loadServerConfig } from "@badabhai/config";
import { createDbClient, events as eventsTable, type Database, type DbClient } from "@badabhai/db";
import type { DisplayPrefsResponse, DisplayTheme } from "@badabhai/types";

import type { AuthenticatedWorker } from "../auth/worker-auth.guard";
import { CampusDriveContactErasureRepository } from "../campus-drives/campus-drive-contact-erasure.repository";
import { InstituteLinkRepository } from "../campus-link/institute-link.repository";
import { DisplayPrefsRepository } from "../display-prefs/display-prefs.repository";
import { DisplayPrefsService } from "../display-prefs/display-prefs.service";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { FeaturePilotSubjectsRepository } from "../feature-rollout/feature-pilot-subjects.repository";
import { FeaturePilotRepository } from "../feature-rollout/feature-pilot.repository";
import { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";
import { rolloutCaller } from "../feature-rollout/rollout-caller";
import { PayerAccountDeletionService } from "../payers/payer-account-deletion.service";
import type { AuthenticatedPayer } from "../payers/payer-auth.guard";
import { resolverOver } from "../payers/payer-tenant-scope.test-support";
import { PayersRepository } from "../payers/payers.repository";
import { WorkersRepository } from "../workers/workers.repository";
import type { PiiCryptoService } from "./pii-crypto.service";
import type { RequestContext } from "./request-context";

/**
 * #2837 (risks R87, R88) — A DELETED LOGIN LEAVES NO THEME OR PILOT ROW, against a real Postgres.
 *
 * `display_prefs` (0165) and `feature_pilot_subjects` (0164) key a row on a login's id with no
 * foreign key, so no cascade erases it: `eraseLoginKeyedRows` does, on every deletion's transaction.
 * What only Postgres can show:
 *   - the DPDP erasure (`WorkersRepository.hardDelete`), Campus's link-created worker delete and the
 *     payer login deletion leave none of the login's own rows; another login's rows, and the same
 *     uuid under another kind, survive; a failed erasure brings the rows back with the login's row;
 *   - a theme PATCH cannot leave a row behind an erasure (review L3). After it: the realm guard's
 *     401, nothing written. Racing it, in either order, on two connections: the erasure first, and
 *     the PATCH waits on its `FOR KEY SHARE` and is refused; the PATCH first, and the erasure waits on
 *     the login's row and then deletes the row the PATCH committed.
 *
 * Run it through a throwaway LOCAL database only:
 *   RUN_DB_TESTS=1 DATABASE_URL=postgres://…localhost… pnpm --filter @badabhai/api run test login-keyed-rows.db
 *
 * Runs in CI as one of the DB-backed gates in `ci.yml`, which asserts per-file that it EXECUTED.
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function assertLocalDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`login-keyed-rows.db refuses a non-local host (${host})`);
  }
}

const CTX = {
  correlationId: "00000000-0000-4000-8000-000000002837",
  requestId: "r-2837",
} as RequestContext;
const worker = (id: string): AuthenticatedWorker => ({ id, sid: "sid-t2837" });
const payer = (id: string): AuthenticatedPayer => ({ id, sid: "sid-t2837", role: "employer" });

/** Holds a transaction at one point until released; `held` resolves with its backend pid. */
function parking() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let parked!: (pid: number) => void;
  const held = new Promise<number>((resolve) => (parked = resolve));
  return {
    held,
    release,
    park: async (tx: Database): Promise<void> => {
      parked(await backendPid(tx));
      await gate;
    },
  };
}

/** The backend pid of the connection running `tx`. */
async function backendPid(tx: Database): Promise<number> {
  const rows = (await tx.execute(dsql`SELECT pg_backend_pid()::int AS pid`)) as unknown as {
    pid: number;
  }[];
  return Number(rows[0]!.pid);
}

/** `work` resolves first, or this rejects: a parked step that never ran must not hang the test. */
function before<T>(held: Promise<T>, work: Promise<unknown>, what: string): Promise<T> {
  return Promise.race([
    held,
    work.then(
      () => Promise.reject(new Error(`${what} finished without parking`)),
      (err: unknown) => Promise.reject(err),
    ),
  ]);
}

describe.skipIf(!RUN)("#2837 — a deleted login leaves no theme or pilot row (Postgres)", () => {
  let client!: DbClient;
  let realEvents!: EventsService;
  const workerIds = new Set<string>();
  const payerIds = new Set<string>();

  async function insertWorker(status: "active" | "pending" = "active"): Promise<string> {
    const id = randomUUID();
    workerIds.add(id);
    await client.sql`
      INSERT INTO workers (id, phone_e164, phone_hash, status)
      VALUES (${id}::uuid, 'v1.t2837-login-rows', ${`t2837-login-rows-${id}`}, ${status})`;
    return id;
  }

  async function insertPayer(): Promise<string> {
    const id = randomUUID();
    payerIds.add(id);
    await client.sql`
      INSERT INTO payers (id, role, org_name_enc, status)
      VALUES (${id}::uuid, 'employer', 'v1.t2837-login-rows', 'active')`;
    return id;
  }

  /** A theme row under `kind`, and (for a worker or an admin) a theme pilot place. */
  async function seed(id: string, kinds: readonly ("worker" | "payer_user" | "admin")[]) {
    for (const kind of kinds) {
      await client.sql`
        INSERT INTO display_prefs (subject_kind, subject_id, theme)
        VALUES (${kind}, ${id}::uuid, 'dark')`;
      if (kind !== "payer_user") {
        await client.sql`
          INSERT INTO feature_pilot_subjects (feature, subject_kind, subject_id, added_by, reason)
          VALUES ('theme', ${kind}, ${id}::uuid, 'owner_sql', 't2837 fixture')`;
      }
    }
  }

  const prefsKinds = async (id: string) =>
    (
      await client.sql<{ subject_kind: string }[]>`
        SELECT subject_kind FROM display_prefs WHERE subject_id = ${id}::uuid ORDER BY 1`
    ).map((r) => r.subject_kind);
  const pilotKinds = async (id: string) =>
    (
      await client.sql<{ subject_kind: string }[]>`
        SELECT subject_kind FROM feature_pilot_subjects WHERE subject_id = ${id}::uuid ORDER BY 1`
    ).map((r) => r.subject_kind);
  const themeEvents = async (id: string) =>
    client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM events
       WHERE event_name = 'display_prefs.changed' AND payload->>'subject_id' = ${id}`.then(
      (rows) => rows[0]?.n ?? 0,
    );
  const workerExists = async (id: string) =>
    (await client.sql`SELECT 1 FROM workers WHERE id = ${id}::uuid`).length > 0;

  /** The real theme service over the real tables and the real switch (`THEME_ROLLOUT=on`). */
  function themeService(events: EventsService = realEvents): DisplayPrefsService {
    const config = loadServerConfig({ NODE_ENV: "test", THEME_ROLLOUT: "on" });
    return new DisplayPrefsService(
      new DisplayPrefsRepository(client.db),
      new FeatureRolloutService(
        config,
        new FeaturePilotRepository(client.db),
        new FeaturePilotSubjectsRepository(client.db),
      ),
      resolverOver(config),
      events,
    );
  }

  /** The real events service, held inside the PATCH's transaction (after its row write). */
  function parkedEvents(park: (tx: Database) => Promise<void>): EventsService {
    return {
      emit: async (params: Parameters<EventsService["emit"]>[0]) => {
        await park(params.tx as Database);
        return realEvents.emit(params);
      },
    } as unknown as EventsService;
  }

  /** The payer login deletion (QA seam), optionally parked inside its transaction. */
  function payerDeletion(park?: (tx: Database) => Promise<void>): PayerAccountDeletionService {
    const erasure = new CampusDriveContactErasureRepository(client.db);
    if (park) {
      const eraseEnteredBy = erasure.eraseEnteredBy.bind(erasure);
      erasure.eraseEnteredBy = async (payerId, executor) => {
        await park(executor!);
        return eraseEnteredBy(payerId, executor);
      };
    }
    return new PayerAccountDeletionService(
      client.db,
      new PayersRepository(client.db, {} as PiiCryptoService),
      { revokeAllForPayer: async () => 0 } as never,
      realEvents,
      erasure,
    );
  }

  /**
   * Waits until a statement matching `statement` is blocked by the PARKED backend
   * (`pg_blocking_pids`), so a lock wait elsewhere in the database cannot pass for it.
   */
  async function waitForLockWaiter(blockerPid: number, statement: string): Promise<void> {
    expect(blockerPid, "the parked transaction's backend pid").toBeGreaterThan(0);
    for (let i = 0; i < 200; i += 1) {
      const [row] = await client.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database()
           AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
           AND query ILIKE ${statement}`;
      if ((row?.n ?? 0) >= 1) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`no statement waited on the parked backend ${blockerPid}`);
  }

  beforeAll(async () => {
    assertLocalDatabase(DATABASE_URL);
    client = createDbClient(DATABASE_URL, { max: 6 });
    realEvents = new EventsService(new EventsRepository(client.db), {
      NODE_ENV: "test",
    } as never);
  }, 30_000);

  beforeEach(() => {
    vi.restoreAllMocks();
    // The theme service's change line and the payer seam's QA marker; asserted where it matters.
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });

  afterAll(async () => {
    if (!client) return;
    try {
      const ids = [...workerIds, ...payerIds];
      if (ids.length > 0) {
        await client.sql`DELETE FROM display_prefs WHERE subject_id = ANY(${ids}::uuid[])`;
        await client.sql`DELETE FROM feature_pilot_subjects WHERE subject_id = ANY(${ids}::uuid[])`;
        await client.db.delete(eventsTable).where(inArray(eventsTable.subjectId, ids));
        await client.sql`DELETE FROM workers WHERE id = ANY(${[...workerIds]}::uuid[])`;
        await client.sql`DELETE FROM payers WHERE id = ANY(${[...payerIds]}::uuid[])`;
      }
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  }, 30_000);

  describe("the worker erasure (WorkersRepository.hardDelete)", () => {
    it("erases his own theme and pilot rows; another worker's, and his uuid under another kind, survive", async () => {
      const repo = new WorkersRepository(client.db);
      const erased = await insertWorker();
      const other = await insertWorker();
      await seed(erased, ["worker", "payer_user", "admin"]);
      await seed(other, ["worker"]);

      expect(await repo.hardDelete(erased)).toBe(true);

      expect(await workerExists(erased)).toBe(false);
      expect(await prefsKinds(erased)).toEqual(["admin", "payer_user"]);
      expect(await pilotKinds(erased)).toEqual(["admin"]);
      expect(await prefsKinds(other)).toEqual(["worker"]);
      expect(await pilotKinds(other)).toEqual(["worker"]);
    }, 30_000);

    it("a failure inside the erasure's transaction brings his rows back with the worker row", async () => {
      const id = await insertWorker();
      await seed(id, ["worker"]);

      await expect(
        new WorkersRepository(client.db).hardDelete(id, {
          inTx: async () => {
            throw new Error("t2837: the event write failed");
          },
        }),
      ).rejects.toThrow("t2837: the event write failed");

      expect(await workerExists(id)).toBe(true);
      expect(await prefsKinds(id)).toEqual(["worker"]);
      expect(await pilotKinds(id)).toEqual(["worker"]);
    }, 30_000);

    it("a re-run after an out-of-band DELETE FROM workers clears the rows it left behind", async () => {
      const id = await insertWorker();
      await seed(id, ["worker"]);
      await client.sql`DELETE FROM workers WHERE id = ${id}::uuid`;
      // R87 as it was: no cascade reaches either table.
      expect(await prefsKinds(id)).toEqual(["worker"]);

      expect(await new WorkersRepository(client.db).hardDelete(id)).toBe(false);

      expect(await prefsKinds(id)).toEqual([]);
      expect(await pilotKinds(id)).toEqual([]);
    }, 30_000);
  });

  describe("Campus's link-created worker delete (deleteLinkCreatedPendingWorker)", () => {
    const deleteLinkCreated = (id: string) => {
      const repo = new InstituteLinkRepository(client.db);
      return repo.withTransaction((tx) => repo.deleteLinkCreatedPendingWorker(tx, id, "rvm"));
    };

    it("erases his rows when it deletes the row, and leaves them on a row it keeps", async () => {
      const created = await insertWorker("pending");
      await client.sql`
        INSERT INTO worker_origins (worker_id, kind, ref) VALUES (${created}::uuid, 'institute', 'rvm')`;
      // No institute origin: not the link's row, so the predicate keeps it.
      const kept = await insertWorker("pending");
      await seed(created, ["worker"]);
      await seed(kept, ["worker"]);

      expect(await deleteLinkCreated(created)).toBe(true);
      expect(await deleteLinkCreated(kept)).toBe(false);

      expect(await workerExists(created)).toBe(false);
      expect(await prefsKinds(created)).toEqual([]);
      expect(await pilotKinds(created)).toEqual([]);
      expect(await workerExists(kept)).toBe(true);
      expect(await prefsKinds(kept)).toEqual(["worker"]);
      expect(await pilotKinds(kept)).toEqual(["worker"]);
    }, 30_000);
  });

  describe("the payer login deletion (PayerAccountDeletionService.execute)", () => {
    it("erases the login's own theme row; another login's, and its uuid as a worker, survive", async () => {
      const erased = await insertPayer();
      const other = await insertPayer();
      await seed(erased, ["payer_user", "worker"]);
      await seed(other, ["payer_user"]);

      await expect(payerDeletion().execute(erased, CTX)).resolves.toMatchObject({ deleted: true });

      expect(await prefsKinds(erased)).toEqual(["worker"]);
      expect(await pilotKinds(erased)).toEqual(["worker"]);
      expect(await prefsKinds(other)).toEqual(["payer_user"]);
    }, 30_000);
  });

  describe("a theme PATCH racing the erasure (review L3)", () => {
    const REALMS = [
      {
        realm: "worker",
        guard401: "Invalid or expired session",
        create: () => insertWorker(),
        patch: (svc: DisplayPrefsService, id: string, theme: DisplayTheme) =>
          svc.writeForWorker(worker(id), rolloutCaller.worker(worker(id)), theme, CTX),
        erase: (id: string, park?: (tx: Database) => Promise<void>) =>
          new WorkersRepository(client.db).hardDelete(id, park ? { inTx: park } : {}),
        rowDelete: '%delete from "workers"%',
      },
      {
        realm: "payer_user",
        guard401: "Invalid or expired payer session",
        create: () => insertPayer(),
        patch: (svc: DisplayPrefsService, id: string, theme: DisplayTheme) =>
          svc.writeForPayer(payer(id), theme, CTX),
        erase: (id: string, park?: (tx: Database) => Promise<void>) =>
          payerDeletion(park).execute(id, CTX),
        rowDelete: '%delete from "payers"%',
      },
    ] as const;

    describe.each(REALMS)("$realm", ({ realm, guard401, create, patch, erase, rowDelete }) => {
      it("AFTER the erasure: the realm guard's 401, no row and no event", async () => {
        const id = await create();
        await erase(id);
        const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

        const err = await patch(themeService(), id, "dark").catch((e: unknown) => e);

        expect(err).toBeInstanceOf(UnauthorizedException);
        expect((err as Error).message).toBe(guard401);
        expect(await prefsKinds(id)).toEqual([]);
        expect(await themeEvents(id)).toBe(0);
        expect(warn.mock.calls.map((c) => String(c[0]))).toContain(
          `display prefs: write refused, login gone (kind=${realm} id=${id})`,
        );
      }, 30_000);

      it("erasure FIRST: the PATCH waits on the login's row, then is refused when it commits", async () => {
        const id = await create();
        const parked = parking();
        const erasing = erase(id, parked.park);
        let patching: Promise<unknown> | undefined;
        try {
          const pid = await before(parked.held, erasing, "the erasure");
          patching = patch(themeService(), id, "dark").catch((e: unknown) => e);
          await waitForLockWaiter(pid, "%for key share%");
        } finally {
          parked.release();
        }
        await erasing;

        expect(await patching).toBeInstanceOf(UnauthorizedException);
        expect(await prefsKinds(id)).toEqual([]);
        expect(await themeEvents(id)).toBe(0);
      }, 30_000);

      it("PATCH FIRST: the erasure waits on the PATCH's lock, then deletes the row it committed", async () => {
        const id = await create();
        const parked = parking();
        const patching: Promise<DisplayPrefsResponse> = patch(
          themeService(parkedEvents(parked.park)),
          id,
          "dark",
        );
        let erasing: Promise<unknown> | undefined;
        try {
          const pid = await before(parked.held, patching, "the PATCH");
          erasing = erase(id);
          await waitForLockWaiter(pid, rowDelete);
        } finally {
          parked.release();
        }

        // The change landed, and was recorded, before the erasure: then the erasure took its row.
        expect(await patching).toEqual({ theme: "dark", theme_open: true });
        await erasing;
        expect(await themeEvents(id)).toBe(1);
        expect(await prefsKinds(id)).toEqual([]);
      }, 30_000);
    });
  });
});
