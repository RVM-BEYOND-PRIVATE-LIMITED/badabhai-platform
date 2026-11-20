import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDbClient, type DbClient } from "@badabhai/db";
import {
  SyntheticScopeClosedError,
  inSyntheticRun,
  runRolledBack,
  scopedDatabase,
  syntheticStudentFor,
} from "./synthetic-scope";

/**
 * #2967 — the synthetic run's scope against real Postgres: inside a run every query through the
 * `DATABASE` proxy joins ONE transaction that is always rolled back; outside a run the proxy is the
 * pool; work that outlives a run cannot write.
 *
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api exec vitest run synthetic-scope.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

describe.skipIf(!RUN)("#2967 synthetic scope against Postgres", () => {
  let client: DbClient;
  const TAG = `synthetic-scope-${randomUUID().slice(0, 8)}`;
  const count = async (key: string) => {
    const [row] = await client.sql<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM audit_logs WHERE action = ${key}`;
    return Number(row?.n ?? 0);
  };
  const insertVia = (db: ReturnType<typeof scopedDatabase>, key: string) =>
    db.execute(sql`INSERT INTO audit_logs (actor_type, action, entity_type, entity_id)
      VALUES ('system', ${key}, 'synthetic_scope_test', gen_random_uuid())`);

  beforeAll(() => {
    client = createDbClient(DATABASE_URL, { max: 3 });
  });

  afterAll(async () => {
    if (!client) return;
    await client.sql`DELETE FROM audit_logs WHERE action LIKE ${`${TAG}%`}`;
    await client.sql.end({ timeout: 5 });
  });

  it("outside a run the proxy is the pool: a write commits", async () => {
    const db = scopedDatabase(client.db);
    await insertVia(db, `${TAG}-outside`);
    expect(await count(`${TAG}-outside`)).toBe(1);
    expect(inSyntheticRun()).toBe(false);
  });

  it("inside a run every proxy query joins one transaction, and all of it is rolled back", async () => {
    const db = scopedDatabase(client.db);
    const seenInside = await runRolledBack(client.db, new Map(), async () => {
      expect(inSyntheticRun()).toBe(true);
      await insertVia(db, `${TAG}-inside`);
      // A service's own transaction becomes a savepoint inside the run.
      await db.transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO audit_logs (actor_type, action, entity_type, entity_id)
          VALUES ('system', ${`${TAG}-nested`}, 'synthetic_scope_test', gen_random_uuid())`);
      });
      const [row] = (await db.execute(sql`
        SELECT count(*)::int AS n FROM audit_logs WHERE action IN (${`${TAG}-inside`}, ${`${TAG}-nested`})
      `)) as unknown as Array<{ n: number }>;
      // Another session sees nothing while the run is open.
      expect(await count(`${TAG}-inside`)).toBe(0);
      return row?.n;
    });
    expect(seenInside).toBe(2);
    expect(await count(`${TAG}-inside`)).toBe(0);
    expect(await count(`${TAG}-nested`)).toBe(0);
  });

  it("a failing nested transaction rolls back to its savepoint; the run goes on", async () => {
    const db = scopedDatabase(client.db);
    const after = await runRolledBack(client.db, new Map(), async () => {
      await expect(
        db.transaction(async (tx) => {
          await tx.execute(sql`INSERT INTO audit_logs (actor_type, action, entity_type, entity_id)
            VALUES ('system', ${`${TAG}-savepoint`}, 'synthetic_scope_test', gen_random_uuid())`);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      const [row] = (await db.execute(sql`
        SELECT count(*)::int AS n FROM audit_logs WHERE action = ${`${TAG}-savepoint`}
      `)) as unknown as Array<{ n: number }>;
      return row?.n;
    });
    expect(after).toBe(0);
  });

  it("what the run's fn throws is rethrown, and nothing is kept", async () => {
    const db = scopedDatabase(client.db);
    await expect(
      runRolledBack(client.db, new Map(), async () => {
        await insertVia(db, `${TAG}-thrown`);
        throw new Error("step failed");
      }),
    ).rejects.toThrow("step failed");
    expect(await count(`${TAG}-thrown`)).toBe(0);
  });

  it("work that outlives the run cannot query: it throws instead of writing to the pool", async () => {
    const db = scopedDatabase(client.db);
    let late: Promise<unknown> | undefined;
    await runRolledBack(client.db, new Map(), async () => {
      late = new Promise((resolve) => setTimeout(resolve, 50)).then(() =>
        insertVia(db, `${TAG}-late`),
      );
    });
    await expect(late).rejects.toBeInstanceOf(SyntheticScopeClosedError);
    expect(await count(`${TAG}-late`)).toBe(0);
  });

  it("answers the run's own student only inside the run, and refuses a run inside a run", async () => {
    const ref = randomUUID();
    const student = {
      name: "S",
      phone: "9000000001",
      course: "C",
      branch: "B",
      status: "current_student" as const,
      test_score: null,
    };
    expect(syntheticStudentFor(ref)).toBeUndefined();
    await runRolledBack(client.db, new Map([[ref, student]]), async () => {
      expect(syntheticStudentFor(ref.toUpperCase())).toEqual(student);
      expect(syntheticStudentFor(randomUUID())).toBeUndefined();
      await expect(runRolledBack(client.db, new Map(), async () => 1)).rejects.toThrow(
        "already inside a run",
      );
    });
    expect(syntheticStudentFor(ref)).toBeUndefined();
  });
});
