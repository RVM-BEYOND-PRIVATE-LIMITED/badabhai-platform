import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, inArray, sql, type SQL } from "drizzle-orm";
import { createDbClient, payers, workers, workforceUuid, type DbClient } from "@badabhai/db";
import type { ServerConfig } from "@badabhai/config";
import type { RequestContext } from "../../common/request-context";
import { EventsRepository } from "../../events/events.repository";
import { EventsService } from "../../events/events.service";
import { AdminNumbersRepository } from "./admin-numbers.repository";
import { AdminNumbersService } from "./admin-numbers.service";
import {
  countableWorker,
  excludeLinkedRvmIdentities,
  excludeSampleWorkers,
  excludeTestPayers,
  excludeTestWorkers,
} from "./exclusions";
import { markSyntheticTestPayers } from "./mark-synthetic-test-payers";

/**
 * #2755 part A against a real Postgres.
 *
 * The unit suites prove the service SAYS the right thing. Only a database proves:
 *  - the mark / unmark round trip on `payers.is_test_account` (migration 0162): the column and its
 *    events commit together; a re-mark and a second unmark move no row and write no event; an
 *    unknown company is a 404; a failing emit rolls the column back;
 *  - `excludeTestPayers` leaves a marked company out of a real query, keeps an order whose company
 *    row is gone (a frozen week must not change on deletion), and cannot be captured by the
 *    subquery when the outer reference is `payers.id` itself;
 *  - each worker rule, alone and together, on real rows: a test account, a seeded sample id, a
 *    Campus-created row that never signed in (out) — and a linked student who DID sign in and a
 *    legacy `pending` row with no origin (in);
 *  - the synthetic-sign-in backfill's real page read and real mark, touching only its own rows.
 *
 * Fixtures carry no real PII: synthetic ids, and the "ciphertext" is an opaque test token.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api exec vitest run admin-numbers.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function assertLocalDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`admin-numbers.db refuses to write to a non-local host (${host})`);
  }
}

const TAG = randomUUID().slice(0, 8);
const CTX: RequestContext = { correlationId: randomUUID(), requestId: `numbers-db-${TAG}` };
const ADMIN = { id: randomUUID(), role: "ops_admin" as const, sid: "s" };

const REAL_CO = randomUUID();
const TEST_CO = randomUUID();
const SYNTH_CO = randomUUID();
const LOOKALIKE_CO = randomUUID();
const ROLLBACK_CO = randomUUID();
const GONE_CO = randomUUID(); // an order's company with no payers row
const PAYERS = [REAL_CO, TEST_CO, SYNTH_CO, LOOKALIKE_CO, ROLLBACK_CO];

const W_REAL = randomUUID();
const W_TEST = randomUUID();
// A seeded sample id far above any seed's real index, so a local seed cannot collide with it.
const W_SAMPLE = workforceUuid("worker", 0x7f0000000000 + Math.floor(Math.random() * 0xffffff));
const W_LINKED_PENDING = randomUUID();
const W_LINKED_ACTIVE = randomUUID();
const W_LEGACY_PENDING = randomUUID();
const WORKERS = [W_REAL, W_TEST, W_SAMPLE, W_LINKED_PENDING, W_LINKED_ACTIVE, W_LEGACY_PENDING];

/** The fake "ciphertext" of an email: `tok:<TAG>:<email>`. Only this run's tokens decrypt to one. */
const tokenOf = (email: string) => `tok:${TAG}:${email}`;

describe.skipIf(!RUN)(
  "#2755 part A against Postgres (payers.is_test_account, the exclusions)",
  () => {
    let client!: DbClient;
    let repo!: AdminNumbersRepository;
    let service!: AdminNumbersService;

    beforeAll(async () => {
      assertLocalDatabase(DATABASE_URL);
      client = createDbClient(DATABASE_URL, { max: 4 });
      repo = new AdminNumbersRepository(client.db);
      const events = new EventsService(new EventsRepository(client.db), {
        NODE_ENV: "test",
      } as never);
      service = new AdminNumbersService(repo, events, {} as ServerConfig);
      await seed(client);
    }, 60_000);

    afterAll(async () => {
      if (!client) return;
      const { sql: q } = client;
      await q`DELETE FROM events WHERE correlation_id = ${CTX.correlationId}::uuid`;
      await q`DELETE FROM payment_orders WHERE provider_order_id LIKE ${`numbers-db-${TAG}-%`}`;
      await q`DELETE FROM worker_origins WHERE worker_id = ANY(${WORKERS}::uuid[])`;
      await q`DELETE FROM workers WHERE id = ANY(${WORKERS}::uuid[])`;
      await q`DELETE FROM payers WHERE id = ANY(${PAYERS}::uuid[])`;
      await q.end({ timeout: 5 });
    });

    async function column(payerId: string): Promise<boolean | undefined> {
      const rows = await client.sql<{ t: boolean }[]>`
      SELECT is_test_account AS t FROM payers WHERE id = ${payerId}::uuid`;
      return rows[0]?.t;
    }

    async function eventNames(payerId: string): Promise<string[]> {
      const rows = await client.sql<{ n: string }[]>`
      SELECT event_name AS n FROM events
      WHERE correlation_id = ${CTX.correlationId}::uuid AND subject_id = ${payerId}::uuid
      ORDER BY occurred_at, event_name`;
      return rows.map((r) => r.n);
    }

    it("the mark / unmark round trip: the column and its events, once per real change", async () => {
      expect(await column(TEST_CO)).toBe(false);

      const marked = await service.markByAdmin(
        ADMIN,
        TEST_CO,
        { reason: "staff" },
        `k-${TAG}-1`,
        CTX,
      );
      expect(marked).toEqual({ payer_id: TEST_CO, is_test_account: true, changed: true });
      expect(await column(TEST_CO)).toBe(true);
      expect((await eventNames(TEST_CO)).sort()).toEqual(
        ["admin.action_performed", "admin.payer_test_account_marked"].sort(),
      );
      const [payload] = await client.sql<{ p: Record<string, unknown> }[]>`
      SELECT payload AS p FROM events
      WHERE correlation_id = ${CTX.correlationId}::uuid AND event_name = 'admin.payer_test_account_marked'
        AND subject_id = ${TEST_CO}::uuid`;
      expect(payload!.p).toEqual({ payer_id: TEST_CO, reason: "staff", admin_id: ADMIN.id });

      // A re-mark (another key, another reason) moves nothing and writes nothing.
      const again = await service.markByAdmin(
        ADMIN,
        TEST_CO,
        { reason: "rehearsal" },
        `k-${TAG}-2`,
        CTX,
      );
      expect(again.changed).toBe(false);
      expect(await eventNames(TEST_CO)).toHaveLength(2);

      // Unmark: the column clears, two more events; a second unmark is a no-op.
      const unmarked = await service.unmarkByAdmin(ADMIN, TEST_CO, CTX);
      expect(unmarked).toEqual({ payer_id: TEST_CO, is_test_account: false, changed: true });
      expect(await column(TEST_CO)).toBe(false);
      expect(await eventNames(TEST_CO)).toHaveLength(4);
      expect((await service.unmarkByAdmin(ADMIN, TEST_CO, CTX)).changed).toBe(false);
      expect(await eventNames(TEST_CO)).toHaveLength(4);

      // Marked again for the exclusion checks below.
      await service.markByAdmin(ADMIN, TEST_CO, { reason: "pilot_test" }, `k-${TAG}-3`, CTX);
      expect(await column(TEST_CO)).toBe(true);
    });

    it("an unknown company is a 404 and writes nothing", async () => {
      const ghost = randomUUID();
      await expect(
        service.markByAdmin(ADMIN, ghost, { reason: "staff" }, `k-${TAG}-ghost`, CTX),
      ).rejects.toThrow(NotFoundException);
      await expect(service.unmarkByAdmin(ADMIN, ghost, CTX)).rejects.toThrow(NotFoundException);
      expect(await eventNames(ghost)).toEqual([]);
    });

    it("a failing emit rolls the column back (one transaction)", async () => {
      // An invalid reason passes the type cast but not the registry, so the emit throws inside
      // the transaction after the row moved.
      await expect(
        service.mark(ROLLBACK_CO, "nope" as never, { kind: "backfill" }, `k-${TAG}-rb`, CTX),
      ).rejects.toThrow();
      expect(await column(ROLLBACK_CO)).toBe(false);
      expect(await eventNames(ROLLBACK_CO)).toEqual([]);
    });

    it("excludeTestPayers: a marked company is out, a real one in, a deleted company's order kept", async () => {
      // Over payers itself: the outer reference is `payers.id`, the subquery's alias is `tp` — a
      // captured reference would make the predicate true or false for EVERY row.
      const kept = await client.db
        .select({ id: payers.id })
        .from(payers)
        .where(and(inArray(payers.id, PAYERS), excludeTestPayers(payers.id)));
      expect(kept.map((r) => r.id).sort()).toEqual(PAYERS.filter((p) => p !== TEST_CO).sort());

      // Over payment_orders (no FK to payers): the test company's order is out, the order of a
      // company whose row is gone stays in.
      const rows = await client.sql<{ payer_id: string }[]>`
      SELECT payer_id FROM payment_orders
      WHERE provider_order_id LIKE ${`numbers-db-${TAG}-%`}`;
      expect(rows).toHaveLength(3);
      const real = await client.db.execute<{ payer_id: string }>(sql`
      SELECT "payment_orders"."payer_id" FROM "payment_orders"
      WHERE "payment_orders"."provider_order_id" LIKE ${`numbers-db-${TAG}-%`}
        AND ${excludeTestPayers(sql.raw(`"payment_orders"."payer_id"`))}`);
      expect((real as unknown as { payer_id: string }[]).map((r) => r.payer_id).sort()).toEqual(
        [REAL_CO, GONE_CO].sort(),
      );
    });

    it("the worker rules on real rows, one at a time and together", async () => {
      const ids = async (rule: SQL) =>
        (
          await client.db
            .select({ id: workers.id })
            .from(workers)
            .where(and(inArray(workers.id, WORKERS), rule))
        )
          .map((r) => r.id)
          .sort();
      const all = [...WORKERS].sort();
      const without = (...out: string[]) => all.filter((w) => !out.includes(w));

      expect(await ids(excludeTestWorkers)).toEqual(without(W_TEST));
      expect(await ids(excludeSampleWorkers)).toEqual(without(W_SAMPLE));
      expect(await ids(excludeLinkedRvmIdentities)).toEqual(without(W_LINKED_PENDING));
      // Together: the real worker, the linked student who signed in, and the legacy pending row.
      expect(await ids(countableWorker)).toEqual(
        [W_REAL, W_LINKED_ACTIVE, W_LEGACY_PENDING].sort(),
      );
    });

    it("the synthetic-sign-in backfill: the real page read and the real mark, its own rows only", async () => {
      const decrypt = (token: string) =>
        token.startsWith(`tok:${TAG}:`) ? token.slice(`tok:${TAG}:`.length) : "other@example.com";
      const lines: string[] = [];
      const runKey = `numbers-db-run-${TAG}`;
      const deps = {
        listUnmarked: (afterId: string | null, limit: number) =>
          repo.listUnmarkedPayersWithEmail(afterId, limit),
        decrypt,
        mark: async (payerId: string) =>
          (await service.mark(payerId, "synthetic_sign_in", { kind: "backfill" }, runKey, CTX))
            .changed
            ? ("changed" as const)
            : ("unchanged" as const),
        log: (line: string) => lines.push(line),
      };

      const dry = await markSyntheticTestPayers(deps, { apply: false, batchSize: 50 });
      expect(dry.ids).toEqual([SYNTH_CO]);
      expect(await column(SYNTH_CO)).toBe(false);
      expect(await eventNames(SYNTH_CO)).toEqual([]);

      const applied = await markSyntheticTestPayers(deps, { apply: true, batchSize: 50 });
      expect(applied.ids).toEqual([SYNTH_CO]);
      expect(await column(SYNTH_CO)).toBe(true);
      expect(await column(LOOKALIKE_CO)).toBe(false);
      expect(await column(REAL_CO)).toBe(false);
      expect(await eventNames(SYNTH_CO)).toEqual(["admin.payer_test_account_marked"]);
      const [payload] = await client.sql<{ p: Record<string, unknown>; a: string }[]>`
      SELECT payload AS p, actor_type AS a FROM events
      WHERE correlation_id = ${CTX.correlationId}::uuid AND subject_id = ${SYNTH_CO}::uuid`;
      expect(payload).toMatchObject({
        p: { payer_id: SYNTH_CO, reason: "synthetic_sign_in", admin_id: null },
        a: "system",
      });
      expect(lines.join("\n")).not.toMatch(/@/);

      // Already marked: a later run does not read it again.
      const later = await markSyntheticTestPayers(deps, { apply: true, batchSize: 50 });
      expect(later.ids).toEqual([]);
    });

    async function seed(c: DbClient): Promise<void> {
      const { sql: q } = c;
      const emails: Record<string, string> = {
        [REAL_CO]: "owner@acme.example",
        [TEST_CO]: "staff@acme.example",
        [SYNTH_CO]: `qa-${TAG}@e2e.badabhai.invalid`,
        [LOOKALIKE_CO]: `qa-${TAG}@badabhai.invalid`,
        [ROLLBACK_CO]: "rollback@acme.example",
      };
      for (const [i, id] of PAYERS.entries()) {
        await q`
        INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status)
        VALUES (${id}::uuid, 'employer', ${tokenOf(emails[id]!)}, ${`hash:numbers-${TAG}-${i}`},
                ${`enc:numbers-org-${TAG}-${i}`}, 'active')`;
      }
      for (const [i, payerId] of [REAL_CO, TEST_CO, GONE_CO].entries()) {
        await q`
        INSERT INTO payment_orders (payer_id, pack_code, amount_inr, credits_granted, provider_order_id, status)
        VALUES (${payerId}::uuid, 'pack_starter', 999, 20, ${`numbers-db-${TAG}-${i}`}, 'paid')`;
      }
      const worker = async (id: string, i: number, status: string, isTest = false) => {
        await q`
        INSERT INTO workers (id, phone_e164, phone_hash, status, is_test_account)
        VALUES (${id}::uuid, ${`enc:numbers-${TAG}-${i}`}, ${`hash:numbers-w-${TAG}-${i}`}, ${status},
                ${isTest})`;
      };
      await worker(W_REAL, 0, "active");
      await worker(W_TEST, 1, "active", true);
      await worker(W_SAMPLE, 2, "active");
      await worker(W_LINKED_PENDING, 3, "pending");
      await worker(W_LINKED_ACTIVE, 4, "active");
      await worker(W_LEGACY_PENDING, 5, "pending");
      for (const w of [W_LINKED_PENDING, W_LINKED_ACTIVE]) {
        await q`INSERT INTO worker_origins (worker_id, kind, ref) VALUES (${w}::uuid, 'institute', 'rvm')`;
      }
    }
  },
);
