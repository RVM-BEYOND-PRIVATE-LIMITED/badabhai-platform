import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger, NotFoundException } from "@nestjs/common";
import { sql as dsql } from "drizzle-orm";
import { loadServerConfig } from "@badabhai/config";
import { createDbClient, type Database, type DbClient } from "@badabhai/db";
import type { DisplayTheme } from "@badabhai/types";

import type { AuthenticatedAdmin } from "../admin/admin-auth.guard";
import type { AuthenticatedWorker } from "../auth/worker-auth.guard";
import { sqlStateOf } from "../common/db-error";
import type { RequestContext } from "../common/request-context";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { FeaturePilotSubjectsRepository } from "../feature-rollout/feature-pilot-subjects.repository";
import { FeaturePilotRepository } from "../feature-rollout/feature-pilot.repository";
import { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";
import { rolloutCaller } from "../feature-rollout/rollout-caller";
import type { AuthenticatedPayer } from "../payers/payer-auth.guard";
import { resolverOver } from "../payers/payer-tenant-scope.test-support";
import { DisplayPrefsRepository } from "./display-prefs.repository";
import { DisplayPrefsService } from "./display-prefs.service";

/**
 * #2819 — DISPLAY PREFERENCES against a real Postgres (migrations through 0165 applied).
 *
 * The real `DisplayPrefsService` over the real repository, the real `EventsService` (so every
 * `display_prefs.changed` is validated against the registry and written to `events`) and the real
 * `FeatureRolloutService` over the real pilot lists. What only Postgres can show:
 *
 *   - per realm, a real change writes ONE row and ONE event in one transaction, a repeat writes
 *     neither, and the token's id is the only row touched;
 *   - an emit failure rolls the row back (the H3 seam), and two concurrent FIRST choices for one
 *     login both land, in order: one insert, one update whose event's `from` is the other's `to`;
 *   - the table's own rules: the two CHECKs, one row per (kind, id), the same id under two kinds,
 *     the `light` default, no foreign key, and RLS enabled AND forced;
 *   - a MISSING TABLE (42P01) or COLUMN (42703), dropped inside a rolled-back transaction: GET
 *     answers light / false, PATCH 404s, and nothing is emitted.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   RUN_DB_TESTS=1 DATABASE_URL=<a migrated LOCAL database> \
 *     pnpm --filter @badabhai/api run test display-prefs.db
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

/**
 * Each login below gets its own `workers` / `payers` / `admin_users` row: a PATCH locks it first
 * (#2837), and the table still has no FK. The guards are not run. `RULES_ID` has no login row.
 */
const WORKER = uuid(0x2819b0001);
const OTHER_WORKER = uuid(0x2819b0002);
const PAYER = uuid(0x2819b0010);
const ADMIN = uuid(0x2819b0020);
/** Ids only the table-rule cases write. */
const RULES_ID = uuid(0x2819b0030);
const RACE_WORKER = uuid(0x2819b0040);
const IDS = [WORKER, OTHER_WORKER, PAYER, ADMIN, RULES_ID, RACE_WORKER];

const ctx = {
  correlationId: "00000000-0000-4000-8000-000000002819",
  requestId: "r-2819",
} as RequestContext;
const worker = (id: string): AuthenticatedWorker => ({ id, sid: "sid-t2819" });
const admin = (id: string): AuthenticatedAdmin => ({ id, role: "support", sid: "sid-t2819" });
const payer = (id: string): AuthenticatedPayer => ({ id, sid: "sid-t2819", role: "agent" });

describe.skipIf(!RUN)("#2819 — display_prefs and its routes' service (Postgres)", () => {
  let client: DbClient;

  function service(
    db: Database,
    mode: "off" | "on" = "on",
    events?: EventsService,
  ): DisplayPrefsService {
    const config = loadServerConfig({ NODE_ENV: "test", THEME_ROLLOUT: mode });
    return new DisplayPrefsService(
      new DisplayPrefsRepository(db),
      new FeatureRolloutService(
        config,
        new FeaturePilotRepository(db),
        new FeaturePilotSubjectsRepository(db),
      ),
      resolverOver(config),
      events ?? new EventsService(new EventsRepository(db), { NODE_ENV: "test" } as never),
    );
  }

  const rowsOf = (kind: string, id: string) =>
    client.sql<{ theme: string }[]>`
      SELECT theme FROM display_prefs WHERE subject_kind = ${kind} AND subject_id = ${id}::uuid`;
  const eventsOf = (id: string) =>
    client.sql<{ payload: Record<string, string>; actor_type: string; subject_type: string }[]>`
      SELECT payload, actor_type, subject_type FROM events
       WHERE event_name = 'display_prefs.changed' AND payload->>'subject_id' = ${id}
       ORDER BY created_at, occurred_at`;

  async function cleanup(): Promise<void> {
    await client.sql`DELETE FROM display_prefs WHERE subject_id = ANY(${IDS}::uuid[])`;
    await client.sql`
      DELETE FROM events
       WHERE event_name = 'display_prefs.changed' AND payload->>'subject_id' = ANY(${IDS}::text[])`;
  }

  /** The logins' own rows, which a PATCH locks before it writes (#2837). PII-free fixtures. */
  const WORKER_LOGINS = [WORKER, OTHER_WORKER, RACE_WORKER];
  async function insertLogins(): Promise<void> {
    for (const id of WORKER_LOGINS) {
      await client.sql`
        INSERT INTO workers (id, phone_e164, phone_hash, status)
        VALUES (${id}::uuid, 'v1.t2819-display-prefs-db', ${`t2819-display-prefs-db-${id}`}, 'active')
        ON CONFLICT (id) DO NOTHING`;
    }
    await client.sql`
      INSERT INTO payers (id, role, org_name_enc, status)
      VALUES (${PAYER}::uuid, 'agent', 'v1.t2819-display-prefs-db', 'active')
      ON CONFLICT (id) DO NOTHING`;
    await client.sql`
      INSERT INTO admin_users (id, email_enc, email_hash, role, status)
      VALUES (${ADMIN}::uuid, 'v1.t2819-display-prefs-db', ${`t2819-display-prefs-db-${ADMIN}`},
              'support', 'active')
      ON CONFLICT (id) DO NOTHING`;
  }
  async function deleteLogins(): Promise<void> {
    await client.sql`DELETE FROM workers WHERE id = ANY(${WORKER_LOGINS}::uuid[])`;
    await client.sql`DELETE FROM payers WHERE id = ${PAYER}::uuid`;
    await client.sql`DELETE FROM admin_users WHERE id = ${ADMIN}::uuid`;
  }

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 3 });
    await cleanup();
    await insertLogins();
  }, 30_000);

  beforeEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  }, 30_000);

  afterAll(async () => {
    if (!client) return;
    try {
      await cleanup();
      await deleteLogins();
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  }, 30_000);

  const REALMS = [
    {
      kind: "worker",
      id: WORKER,
      actor: "worker",
      subject: "worker",
      read: (s: DisplayPrefsService) =>
        s.readForWorker(worker(WORKER), rolloutCaller.worker(worker(WORKER))),
      write: (s: DisplayPrefsService, t: DisplayTheme) =>
        s.writeForWorker(worker(WORKER), rolloutCaller.worker(worker(WORKER)), t, ctx),
    },
    {
      kind: "payer_user",
      id: PAYER,
      actor: "payer",
      subject: "payer",
      read: (s: DisplayPrefsService) => s.readForPayer(payer(PAYER)),
      write: (s: DisplayPrefsService, t: DisplayTheme) => s.writeForPayer(payer(PAYER), t, ctx),
    },
    {
      kind: "admin",
      id: ADMIN,
      actor: "admin",
      subject: "admin_session",
      read: (s: DisplayPrefsService) =>
        s.readForAdmin(admin(ADMIN), rolloutCaller.admin(admin(ADMIN))),
      write: (s: DisplayPrefsService, t: DisplayTheme) =>
        s.writeForAdmin(admin(ADMIN), rolloutCaller.admin(admin(ADMIN)), t, ctx),
    },
  ] as const;

  describe.each(REALMS)("$kind", ({ kind, id, actor, subject, read, write }) => {
    it("a real change: ONE row and ONE validated event; a repeat writes neither; GET serves it", async () => {
      const svc = service(client.db);
      expect(await read(svc)).toEqual({ theme: "light", theme_open: true });
      expect(await write(svc, "dark")).toEqual({ theme: "dark", theme_open: true });
      expect(await write(svc, "dark")).toEqual({ theme: "dark", theme_open: true });
      expect(await read(svc)).toEqual({ theme: "dark", theme_open: true });

      expect(await rowsOf(kind, id)).toEqual([{ theme: "dark" }]);
      const events = await eventsOf(id);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        payload: { subject_kind: kind, subject_id: id, from: "light", to: "dark" },
        actor_type: actor,
        subject_type: subject,
      });

      // light with the row at dark IS a change; light again is not.
      await write(svc, "light");
      await write(svc, "light");
      expect(await rowsOf(kind, id)).toEqual([{ theme: "light" }]);
      expect((await eventsOf(id)).map((e) => `${e.payload.from}->${e.payload.to}`)).toEqual([
        "light->dark",
        "dark->light",
      ]);
    }, 30_000);

    it("switch off: GET is light / false over a stored dark, PATCH 404s and the row waits", async () => {
      await write(service(client.db), "dark");
      const off = service(client.db, "off");
      expect(await read(off)).toEqual({ theme: "light", theme_open: false });
      await expect(write(off, "system")).rejects.toBeInstanceOf(NotFoundException);
      expect(await rowsOf(kind, id)).toEqual([{ theme: "dark" }]);
      expect(await eventsOf(id)).toHaveLength(1);
      // Opened again, the stored choice is back.
      expect(await read(service(client.db))).toEqual({ theme: "dark", theme_open: true });
    }, 30_000);
  });

  it("the TOKEN decides the row: one worker's change never touches another's", async () => {
    const svc = service(client.db);
    await svc.writeForWorker(
      worker(OTHER_WORKER),
      rolloutCaller.worker(worker(OTHER_WORKER)),
      "system",
      ctx,
    );
    await svc.writeForWorker(worker(WORKER), rolloutCaller.worker(worker(WORKER)), "dark", ctx);
    expect(await rowsOf("worker", OTHER_WORKER)).toEqual([{ theme: "system" }]);
    expect(await rowsOf("worker", WORKER)).toEqual([{ theme: "dark" }]);
  }, 30_000);

  it("an emit failure rolls the row back: the row and its event stand or fall together", async () => {
    const failing = { emit: vi.fn(async () => Promise.reject(new Error("t2819: events down"))) };
    const svc = service(client.db, "on", failing as unknown as EventsService);
    await expect(
      svc.writeForWorker(worker(WORKER), rolloutCaller.worker(worker(WORKER)), "dark", ctx),
    ).rejects.toThrow("t2819: events down");
    expect(await rowsOf("worker", WORKER)).toEqual([]);
  }, 30_000);

  it("two concurrent FIRST choices for one login: one insert, one update, events chained", async () => {
    const a = service(client.db);
    const b = service(client.db);
    const results = await Promise.all([
      a.writeForWorker(worker(RACE_WORKER), rolloutCaller.worker(worker(RACE_WORKER)), "dark", ctx),
      b.writeForWorker(
        worker(RACE_WORKER),
        rolloutCaller.worker(worker(RACE_WORKER)),
        "system",
        ctx,
      ),
    ]);
    expect(results.map((r) => r.theme).sort()).toEqual(["dark", "system"]);
    // Not by row order: `created_at` is each transaction's START, and the loser started first.
    const events = (await eventsOf(RACE_WORKER)).map((e) => e.payload);
    expect(events).toHaveLength(2);
    const first = events.find((e) => e.from === "light");
    const second = events.find((e) => e !== first);
    expect(first, JSON.stringify(events)).toBeDefined();
    expect(second!.from).toBe(first!.to);
    expect(await rowsOf("worker", RACE_WORKER)).toEqual([{ theme: second!.to }]);
  }, 30_000);

  describe("the table's own rules", () => {
    const sqlstate = async (write: Promise<unknown>): Promise<string | undefined> => {
      try {
        await write;
        return "ok";
      } catch (err) {
        return sqlStateOf(err);
      }
    };
    const insert = (kind: string, theme: string | null) =>
      theme === null
        ? client.sql`INSERT INTO display_prefs (subject_kind, subject_id) VALUES (${kind}, ${RULES_ID}::uuid)`
        : client.sql`
            INSERT INTO display_prefs (subject_kind, subject_id, theme)
            VALUES (${kind}, ${RULES_ID}::uuid, ${theme})`;

    it.each([
      ["a theme outside the set", "worker", "ink"],
      ["a capitalised theme", "worker", "Dark"],
      ["a tenant is not a subject kind", "payer", "dark"],
      ["an unknown kind", "company", "dark"],
    ])(
      "%s (23514)",
      async (_rule, kind, theme) => {
        expect(await sqlstate(insert(kind, theme))).toBe("23514");
      },
      30_000,
    );

    it("defaults to light, one row per (kind, id) (23505), the same id under two kinds, no FK", async () => {
      expect(await sqlstate(insert("worker", null))).toBe("ok");
      expect(await rowsOf("worker", RULES_ID)).toEqual([{ theme: "light" }]);
      expect(await sqlstate(insert("worker", "dark"))).toBe("23505");
      expect(await sqlstate(insert("admin", "dark"))).toBe("ok");
      const [orphan] = await client.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM workers WHERE id = ${RULES_ID}::uuid`;
      expect(orphan?.n).toBe(0);
    }, 30_000);

    it("RLS is ENABLED and FORCED, with no policy", async () => {
      const [rls] = await client.sql<{ enabled: boolean; forced: boolean }[]>`
        SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
          FROM pg_class WHERE oid = 'public.display_prefs'::regclass`;
      expect(rls).toEqual({ enabled: true, forced: true });
      const [policies] = await client.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'display_prefs'`;
      expect(policies?.n).toBe(0);
    }, 30_000);
  });

  it.each([
    ["the table is missing (42P01)", "42P01", dsql`DROP TABLE display_prefs`],
    ["a column is missing (42703)", "42703", dsql`ALTER TABLE display_prefs DROP COLUMN theme`],
  ])(
    "%s: GET light / false, PATCH 404, nothing emitted, ids and SQLSTATE only in the log",
    async (_name, code, breakIt) => {
      const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      const ROLLBACK = new Error("t2819: roll the break back");
      const outcome: { read?: unknown; write?: unknown; raw?: string } = {};
      try {
        await client.db.transaction(async (tx) => {
          await tx.execute(breakIt);
          const db = tx as unknown as Database;
          // A failed statement aborts the transaction, so each probe runs under a savepoint.
          const probe = async <T>(run: () => Promise<T>): Promise<T> => {
            await tx.execute(dsql`SAVEPOINT t2819`);
            try {
              return await run();
            } finally {
              await tx.execute(dsql`ROLLBACK TO SAVEPOINT t2819`);
            }
          };
          outcome.raw = await probe(async () => {
            try {
              await new DisplayPrefsRepository(db).findTheme("worker", WORKER);
              return "no error";
            } catch (err) {
              return sqlStateOf(err);
            }
          });
          const svc = service(db);
          outcome.read = await probe(() =>
            svc.readForWorker(worker(WORKER), rolloutCaller.worker(worker(WORKER))),
          );
          outcome.write = await probe(() =>
            svc
              .writeForWorker(worker(WORKER), rolloutCaller.worker(worker(WORKER)), "dark", ctx)
              .catch((e: unknown) => e),
          );
          throw ROLLBACK;
        });
      } catch (err) {
        if (err !== ROLLBACK) throw err;
      }
      expect(outcome.raw).toBe(code);
      expect(outcome.read).toEqual({ theme: "light", theme_open: false });
      expect(outcome.write).toBeInstanceOf(NotFoundException);
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
        `display prefs: read failed closed (kind=worker id=${WORKER} sqlstate=${code})`,
        `display prefs: write failed closed (kind=worker id=${WORKER} sqlstate=${code})`,
      ]);
      // Rolled back: the table is whole again, and nothing was emitted.
      expect(await eventsOf(WORKER)).toEqual([]);
      expect(
        await service(client.db).readForWorker(
          worker(WORKER),
          rolloutCaller.worker(worker(WORKER)),
        ),
      ).toEqual({
        theme: "light",
        theme_open: true,
      });
    },
    30_000,
  );
});
