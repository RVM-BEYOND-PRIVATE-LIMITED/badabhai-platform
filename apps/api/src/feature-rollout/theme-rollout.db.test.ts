import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { sql as dsql } from "drizzle-orm";
import { loadServerConfig } from "@badabhai/config";
import { createDbClient, type Database, type DbClient } from "@badabhai/db";
import type { AuthenticatedAdmin } from "../admin/admin-auth.guard";
import type { AuthenticatedWorker } from "../auth/worker-auth.guard";
import { sqlStateOf } from "../common/db-error";
import { resolverOver } from "../payers/payer-tenant-scope.test-support";
import { FeaturePilotSubjectsRepository } from "./feature-pilot-subjects.repository";
import { FeaturePilotRepository } from "./feature-pilot.repository";
import { FeatureRolloutService } from "./feature-rollout.service";
import { rolloutCaller, type RolloutCaller } from "./rollout-caller";

/**
 * #2820 — THE THEME SWITCH, against a real Postgres (migration 0164 applied).
 *
 * The real `FeatureRolloutService` over the real repositories. What only Postgres can show:
 *
 *   - `pilot` opens exactly the listed logins: a company in `feature_pilot_payers` (a team member
 *     inherits it under org tenancy `on`), a worker and an admin in `feature_pilot_subjects`, each
 *     by the PK probe on (feature, kind, id). `off` and `on` read no list;
 *   - the key is all three columns: a row for another feature, or for the other kind, opens
 *     nothing;
 *   - the table's own rules: no company kind, `added_by` the id charset only, a `reason` of 1..500,
 *     one row per key, and no foreign key (a row for an id with no `workers` row is accepted);
 *   - a MISSING TABLE fails closed: with `feature_pilot_subjects` dropped inside a transaction
 *     that is rolled back, the read raises 42P01 (on `err.cause`, drizzle 0.45) and the service
 *     answers false for a worker and an admin, logging the SQLSTATE and the id only.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   RUN_DB_TESTS=1 DATABASE_URL=<a migrated LOCAL database> \
 *     pnpm --filter @badabhai/api run test theme-rollout.db
 *
 * Runs in CI as one of the DB-backed gates in `ci.yml`, which asserts per-file that it EXECUTED.
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

/** This suite drops a table (in a rolled-back transaction) and writes fixtures: local only. */
function assertLocalDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(
      `theme-rollout.db runs DDL and writes fixtures; refusing non-local host ${host}`,
    );
  }
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** A listed company with a team: COMPANY anchors it, MEMBER recruits for it. */
const COMPANY = uuid(0x2820a0001);
const MEMBER = uuid(0x2820a0002);
/** A company on no list. */
const OTHER_COMPANY = uuid(0x2820a0003);
/** Worker and admin ids: no `workers` / `admin_users` rows, because the list has no FK. */
const PILOT_WORKER = uuid(0x2820a0010);
const OTHER_WORKER = uuid(0x2820a0011);
const PILOT_ADMIN = uuid(0x2820a0020);
const OTHER_ADMIN = uuid(0x2820a0021);
/** Listed for another feature, and listed as the other kind. */
const JOB_AUDIENCE_WORKER = uuid(0x2820a0030);
const ADMIN_ONLY_ID = uuid(0x2820a0031);
const SUBJECTS = [PILOT_WORKER, PILOT_ADMIN, JOB_AUDIENCE_WORKER, ADMIN_ONLY_ID, OTHER_WORKER];

const worker = (id: string): AuthenticatedWorker => ({ id, sid: "sid-t2820" });
const admin = (id: string): AuthenticatedAdmin => ({ id, role: "ops_admin", sid: "sid-t2820" });

describe.skipIf(!RUN)("#2820 — THEME_ROLLOUT and its pilot lists (Postgres)", () => {
  let client: DbClient;

  function service(db: Database, rollout: string): FeatureRolloutService {
    return new FeatureRolloutService(
      loadServerConfig({ NODE_ENV: "test", THEME_ROLLOUT: rollout }),
      new FeaturePilotRepository(db),
      new FeaturePilotSubjectsRepository(db),
    );
  }

  /** A company caller through the REAL tenancy resolver, as #2819's payer routes build it. */
  async function company(payerId: string, tenancy: "off" | "on" = "off"): Promise<RolloutCaller> {
    const config = loadServerConfig({ NODE_ENV: "test", PAYER_ORG_TENANCY_MODE: tenancy });
    const resolver = resolverOver(config, [{ anchor: COMPANY, members: [MEMBER] }]);
    return rolloutCaller.payer(await resolver.resolve(payerId));
  }

  async function cleanup(): Promise<void> {
    await client.sql`DELETE FROM feature_pilot_subjects WHERE subject_id = ANY(${SUBJECTS}::uuid[])`;
    // Their pilot rows cascade.
    await client.sql`DELETE FROM payers WHERE id IN (${COMPANY}::uuid, ${OTHER_COMPANY}::uuid)`;
  }

  beforeAll(async () => {
    assertLocalDatabase(DATABASE_URL);
    client = createDbClient(DATABASE_URL, { max: 2 });
    await cleanup();
    await client.sql`
      INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status) VALUES
        (${COMPANY}::uuid, 'employer', 'enc:t2820-company', 'hash:t2820-company',
         'enc:org-t2820-company', 'active'),
        (${OTHER_COMPANY}::uuid, 'employer', 'enc:t2820-other', 'hash:t2820-other',
         'enc:org-t2820-other', 'active')`;
    await client.sql`
      INSERT INTO feature_pilot_payers (feature, payer_id, added_by, reason)
      VALUES ('theme', ${COMPANY}::uuid, 'test', '#2820 DB test: the pilot company')`;
    await client.sql`
      INSERT INTO feature_pilot_subjects (feature, subject_kind, subject_id, added_by, reason)
      VALUES ('theme', 'worker', ${PILOT_WORKER}::uuid, 'test', '#2820 DB test: pilot worker'),
             ('theme', 'admin', ${PILOT_ADMIN}::uuid, 'test', '#2820 DB test: pilot admin'),
             ('job_audience', 'worker', ${JOB_AUDIENCE_WORKER}::uuid, 'test',
              '#2820 DB test: another feature'),
             ('theme', 'admin', ${ADMIN_ONLY_ID}::uuid, 'test', '#2820 DB test: admin kind only')`;
  }, 30_000);

  afterAll(async () => {
    if (!client) return;
    try {
      await cleanup();
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  }, 30_000);

  it("pilot: exactly the listed company, worker and admin", async () => {
    const svc = service(client.db, "pilot");
    expect(await svc.isThemeOpenFor(await company(COMPANY))).toBe(true);
    expect(await svc.isThemeOpenFor(rolloutCaller.worker(worker(PILOT_WORKER)))).toBe(true);
    expect(await svc.isThemeOpenFor(rolloutCaller.admin(admin(PILOT_ADMIN)))).toBe(true);

    expect(await svc.isThemeOpenFor(await company(OTHER_COMPANY))).toBe(false);
    expect(await svc.isThemeOpenFor(rolloutCaller.worker(worker(OTHER_WORKER)))).toBe(false);
    expect(await svc.isThemeOpenFor(rolloutCaller.admin(admin(OTHER_ADMIN)))).toBe(false);
  }, 30_000);

  it("pilot: a team member inherits the company's place under org tenancy on, and not under off", async () => {
    const svc = service(client.db, "pilot");
    expect(await svc.isThemeOpenFor(await company(MEMBER, "on"))).toBe(true);
    expect(await svc.isThemeOpenFor(await company(MEMBER, "off"))).toBe(false);
  }, 30_000);

  it("pilot: the key is (feature, kind, id) — another feature's row or the other kind opens nothing", async () => {
    const svc = service(client.db, "pilot");
    expect(await svc.isThemeOpenFor(rolloutCaller.worker(worker(JOB_AUDIENCE_WORKER)))).toBe(false);
    expect(await svc.isThemeOpenFor(rolloutCaller.worker(worker(ADMIN_ONLY_ID)))).toBe(false);
    expect(await svc.isThemeOpenFor(rolloutCaller.admin(admin(ADMIN_ONLY_ID)))).toBe(true);
    const repo = new FeaturePilotSubjectsRepository(client.db);
    expect(await repo.isListed("job_audience", "worker", JOB_AUDIENCE_WORKER)).toBe(true);
    expect(await repo.isListed("job_audience", "worker", PILOT_WORKER)).toBe(false);
  }, 30_000);

  it.each([
    ["off", false],
    ["on", true],
  ] as const)(
    "%s: every login gets %s, listed or not",
    async (mode, expected) => {
      const svc = service(client.db, mode);
      for (const caller of [
        await company(COMPANY),
        await company(OTHER_COMPANY),
        rolloutCaller.worker(worker(PILOT_WORKER)),
        rolloutCaller.worker(worker(OTHER_WORKER)),
        rolloutCaller.admin(admin(PILOT_ADMIN)),
        rolloutCaller.admin(admin(OTHER_ADMIN)),
      ]) {
        expect(await svc.isThemeOpenFor(caller), caller.kind).toBe(expected);
      }
    },
    30_000,
  );

  describe("the table's own rules", () => {
    const insert = (kind: string, addedBy: string, reason: string, id = OTHER_WORKER) =>
      client.sql`
        INSERT INTO feature_pilot_subjects (feature, subject_kind, subject_id, added_by, reason)
        VALUES ('theme', ${kind}, ${id}::uuid, ${addedBy}, ${reason})`;

    const sqlstate = async (write: Promise<unknown>): Promise<string | undefined> => {
      try {
        await write;
        return "ok";
      } catch (err) {
        return sqlStateOf(err);
      }
    };

    it.each([
      ["a company is not a subject kind", "payer", "test", "a reason"],
      ["added_by is the id charset only, never a name", "worker", "Fixture Admin", "a reason"],
      ["a reason is required", "worker", "test", ""],
      ["a reason is at most 500 characters", "worker", "test", "x".repeat(501)],
    ])(
      "%s (23514)",
      async (_rule, kind, addedBy, reason) => {
        expect(await sqlstate(insert(kind, addedBy, reason))).toBe("23514");
      },
      30_000,
    );

    it("one row per (feature, kind, id) (23505), and no FK: an id with no workers row is accepted", async () => {
      expect(await sqlstate(insert("worker", "owner_sql", "#2820 DB test: no FK"))).toBe("ok");
      expect(await sqlstate(insert("worker", "owner_sql", "#2820 DB test: twice"))).toBe("23505");
      const [found] = await client.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM workers WHERE id = ${OTHER_WORKER}::uuid`;
      expect(found?.n).toBe(0);
      await client.sql`DELETE FROM feature_pilot_subjects WHERE subject_id = ${OTHER_WORKER}::uuid`;
    }, 30_000);
  });

  it("a MISSING TABLE fails closed: 42P01, false for a worker and an admin, sqlstate and id only in the log", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const ROLLBACK = new Error("t2820: roll the drop back");
    const answers: boolean[] = [];
    let raw: string | undefined;
    try {
      await client.db.transaction(async (tx) => {
        await tx.execute(dsql`DROP TABLE feature_pilot_subjects`);
        const db = tx as unknown as Database;
        // A failed statement aborts the transaction (25P02 for the next one), so each probe runs
        // under a savepoint and every one of them meets a fresh 42P01.
        const probe = async <T>(run: () => Promise<T>): Promise<T> => {
          await tx.execute(dsql`SAVEPOINT t2820`);
          try {
            return await run();
          } finally {
            await tx.execute(dsql`ROLLBACK TO SAVEPOINT t2820`);
          }
        };
        // The bare read, as the repository issues it (drizzle 0.45 puts the SQLSTATE on
        // `err.cause`; sqlStateOf reads both).
        raw = await probe(async () => {
          try {
            await new FeaturePilotSubjectsRepository(db).isListed("theme", "worker", PILOT_WORKER);
            return "no error";
          } catch (err) {
            return sqlStateOf(err);
          }
        });
        for (const caller of [
          rolloutCaller.worker(worker(PILOT_WORKER)),
          rolloutCaller.admin(admin(PILOT_ADMIN)),
        ]) {
          answers.push(await probe(() => service(db, "pilot").isThemeOpenFor(caller)));
        }
        throw ROLLBACK;
      });
    } catch (err) {
      if (err !== ROLLBACK) throw err;
    }
    expect(raw).toBe("42P01");
    expect(answers).toEqual([false, false]);
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines).toEqual([
      `feature rollout: pilot list read failed (feature=theme worker=${PILOT_WORKER} sqlstate=42P01); treated as off`,
      `feature rollout: pilot list read failed (feature=theme admin=${PILOT_ADMIN} sqlstate=42P01); treated as off`,
    ]);
    warn.mockRestore();

    // Rolled back: the table and its rows are back.
    expect(
      await service(client.db, "pilot").isThemeOpenFor(rolloutCaller.worker(worker(PILOT_WORKER))),
    ).toBe(true);
  }, 30_000);
});
