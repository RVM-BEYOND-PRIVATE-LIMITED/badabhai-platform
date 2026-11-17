import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDbClient,
  sampleWorkerIdLikePatterns,
  workforceUuid,
  type DbClient,
} from "@badabhai/db";
import type { AuthenticatedAdmin } from "../admin-auth.guard";
import { AdminIdentityRepository } from "../admin-identity.repository";
import { AdminIdentityService } from "../admin-identity.service";
import type { AdminIdentityCapService } from "../admin-identity-cap.service";
import type { CandidateSearchRepository } from "../../candidates/candidate-search.repository";
import type { PiiCryptoService } from "../../common/pii-crypto.service";
import type { RequestContext } from "../../common/request-context";
import { EventsRepository } from "../../events/events.repository";
import { EventsService } from "../../events/events.service";
import { AdminLaunchTestRecordSchema } from "./admin-launch-tests.dto";
import { AdminLaunchTestsRepository } from "./admin-launch-tests.repository";
import { AdminLaunchTestsService } from "./admin-launch-tests.service";

/**
 * #2755 part D against a real Postgres: launch test A's two tables and launch test B's query.
 *
 * The unit suites prove the service SAYS the right thing. Only a database proves:
 *  - the CHECKs (the result set, paid_at iff paid, the link's length and its time, the phone pair),
 *    the two unique indexes (one row per factory phone, one per paid order), the FKs, the SET NULLs
 *    and CASCADEs, and RLS forced with no policy and no grant — on both tables;
 *  - the create on real rows: the Campus refusal against a real `institute_companies` row, the
 *    auto-link of the ordinary account holding the phone, part A's worker rules read in SQL, one
 *    transaction for the row, its shares and its events, and the idempotent replay;
 *  - the edit's paid-order check against real `payment_orders` rows (a Razorpay order, a mock-
 *    provider row, an unpaid order, another account's order, an order already linked);
 *  - the factory name through the REAL identity service: `admin.identity_viewed` committed with the
 *    `launch_test_factories` surface before the decrypt, and the phone never read;
 *  - launch test B: the route's answer EQUALS a hand-written SQL over seeded hires, unlocks and
 *    outcomes (order, the microsecond cut-off, the exclusions, the agency and deleted-posting rows).
 *
 * Fixtures carry no real PII: synthetic ids; the "ciphertext" and "hashes" are opaque test tokens.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api exec vitest run admin-launch-tests.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function assertLocalDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`admin-launch-tests.db refuses to write to a non-local host (${host})`);
  }
}

const TAG = randomUUID().slice(0, 8);
const id = () => randomUUID();
const CTX: RequestContext = { correlationId: randomUUID(), requestId: `launch-db-${TAG}` };
const ADMIN: AuthenticatedAdmin = { id: id(), role: "ops_admin", sid: "s" };
const OPS = id();

// Companies.
const CO_A = id(); // ordinary, holds PHONE_ORDINARY
const CO_B = id(); // ordinary
const CO_T = id(); // a test company
const CO_CAMPUS = id(); // Campus created it; holds PHONE_CAMPUS
const PAYERS = [CO_A, CO_B, CO_T, CO_CAMPUS];
const PHONE_ORDINARY = "+919800000001";
const PHONE_CAMPUS = "+919800000002";
const PHONE_NEW = "+919800000003";

// Workers. A seeded sample id far above any seed's real index.
const SAMPLE = workforceUuid("worker", 0x7e0000000000 + Math.floor(Math.random() * 0xffffff));
const WK = {
  real1: id(),
  real2: id(),
  real3: id(),
  test: id(),
  linked: id(),
  sample: SAMPLE,
  // Test B: hired workers.
  h1: id(),
  h2: id(),
  h3: id(),
  h4: id(),
  h5: id(),
  h6: id(),
  h7: id(),
  h8: id(),
  h9: id(),
  // Test B: contacts.
  c1: id(),
  c2: id(),
  c3: id(),
  c4: id(),
  c5: id(),
  c6: id(),
  c7: id(),
  c8: id(),
  c9: id(),
} as const;
const WORKERS = Object.values(WK);

// Test B postings.
const POST_A1 = id();
const POST_A2 = id();
const POST_B = id();
const POST_GONE = id(); // no job_postings row
const JOB_A = id(); // an agency `jobs` row

/** Hire ids chosen so the tie on one instant is broken by id, visibly. */
const H = {
  a1: `00000000-0000-4000-8000-${TAG}0001`,
  a2tie: `00000000-0000-4000-8000-${TAG}0002`,
  b: id(),
  a1b: id(),
  gone: id(),
  agency: id(),
  reported: id(),
  rejected: id(),
  testCo: id(),
  testWorker: id(),
  sample: id(),
};
const U = Object.fromEntries(
  ["u1", "u2", "u3", "u4", "u5", "u6", "u7", "u8", "u9", "u10", "u11", "u12"].map((k) => [k, id()]),
) as Record<string, string>;

/** Microsecond instants in 2001, so these hires come before any other in the database. */
const at = (s: string) => `2001-01-${s}`;

const pii = {
  hashPhone: (p: string) => `hash:${TAG}:${p}`,
  encrypt: (p: string) => `tok:${TAG}:${p}`,
  decrypt: (t: string) => (t.startsWith(`tok:${TAG}:`) ? t.slice(`tok:${TAG}:`.length) : "?"),
};

describe.skipIf(!RUN)("#2755 part D against Postgres (launch tests A and B)", () => {
  let client!: DbClient;
  let repo!: AdminLaunchTestsRepository;
  let service!: AdminLaunchTestsService;
  let identity!: AdminIdentityService;
  const inPool = new Set<string>([WK.real1, WK.real2, WK.real3, WK.test, WK.linked, WK.sample]);
  const orderIds: string[] = [];

  beforeAll(async () => {
    assertLocalDatabase(DATABASE_URL);
    client = createDbClient(DATABASE_URL, { max: 4 });
    repo = new AdminLaunchTestsRepository(client.db);
    const events = new EventsService(new EventsRepository(client.db), {
      NODE_ENV: "test",
    } as never);
    identity = new AdminIdentityService(
      new AdminIdentityRepository(client.db),
      { consume: async () => ({ ok: true }) } as unknown as AdminIdentityCapService,
      pii as unknown as PiiCryptoService,
      events,
    );
    const search = {
      // The search pool's statement is covered by its own DB gate; here it says "in" for the
      // workers seeded to be eligible, so part A's rules are what decide.
      findCardRow: async (workerId: string) => (inPool.has(workerId) ? { workerId } : null),
    } as unknown as CandidateSearchRepository;
    service = new AdminLaunchTestsService(
      repo,
      identity,
      search,
      pii as unknown as PiiCryptoService,
      events,
    );
    await seed(client);
  }, 60_000);

  afterAll(async () => {
    if (!client) return;
    const { sql } = client;
    await sql`DELETE FROM events WHERE correlation_id = ${CTX.correlationId}::uuid`;
    await sql`DELETE FROM launch_test_cohort WHERE sent_by_admin_id = ${ADMIN.id}::uuid`;
    await sql`DELETE FROM unlock_outcomes WHERE unlock_id = ANY(${Object.values(U)}::uuid[])`;
    await sql`DELETE FROM unlocks WHERE id = ANY(${Object.values(U)}::uuid[])`;
    await sql`DELETE FROM hires WHERE id = ANY(${Object.values(H)}::uuid[])`;
    await sql`DELETE FROM payment_orders WHERE provider_order_id LIKE ${`launch-db-${TAG}-%`}`;
    await sql`DELETE FROM job_postings WHERE id = ANY(${[POST_A1, POST_A2, POST_B]}::uuid[])`;
    await sql`DELETE FROM jobs WHERE id = ${JOB_A}::uuid`;
    await sql`DELETE FROM worker_origins WHERE worker_id = ANY(${WORKERS}::uuid[])`;
    await sql`DELETE FROM workers WHERE id = ANY(${WORKERS}::uuid[])`;
    await sql`DELETE FROM institute_companies WHERE payer_id = ANY(${PAYERS}::uuid[])`;
    await sql`DELETE FROM payers WHERE id = ANY(${PAYERS}::uuid[])`;
    await sql.end({ timeout: 5 });
  });

  const record = (over: Record<string, unknown> = {}) =>
    AdminLaunchTestRecordSchema.parse({
      factory_name: `Factory ${TAG}`,
      city_group: "ncr",
      trade_group: "cnc_operator",
      sent_at: "2026-12-01T10:00:00.000Z",
      worker_ids: [WK.real1, WK.real2],
      ...over,
    });

  /** The SQLSTATE of one statement, or "ok". */
  async function stateOf(statement: () => Promise<unknown>): Promise<string> {
    try {
      await statement();
      return "ok";
    } catch (err) {
      const e = err as { code?: string; cause?: { code?: string } };
      return e.code ?? e.cause?.code ?? "unknown";
    }
  }

  /** A raw factory row (no service): the CHECKs and the indexes. */
  async function rawCohort(over: Record<string, unknown> = {}): Promise<string> {
    const row = {
      id: id(),
      name: `tok:${TAG}:raw`,
      phoneEnc: null as string | null,
      phoneHash: null as string | null,
      result: "pending",
      paidAt: null as string | null,
      linkRef: null as string | null,
      linkAt: null as string | null,
      payer: null as string | null,
      order: null as string | null,
      ...over,
    };
    await client.sql`
      INSERT INTO launch_test_cohort
        (id, factory_name_enc, factory_phone_enc, factory_phone_hash, city_group, trade_group,
         payer_id, sent_by_admin_id, sent_at, payment_link_ref, link_created_at, result, paid_at,
         payment_order_id, updated_by_admin_id)
      VALUES (${row.id}::uuid, ${row.name}, ${row.phoneEnc}, ${row.phoneHash}, 'ncr', 'other',
              ${row.payer}::uuid, ${ADMIN.id}::uuid, now(), ${row.linkRef},
              ${row.linkAt}::timestamptz, ${row.result}, ${row.paidAt}::timestamptz,
              ${row.order}::uuid, ${ADMIN.id}::uuid)`;
    return row.id;
  }

  async function paidOrder(payerId: string, over: { provider?: string; status?: string } = {}) {
    const orderId = id();
    await client.sql`
      INSERT INTO payment_orders (id, payer_id, pack_code, amount_inr, credits_granted, provider,
                                  provider_order_id, status)
      VALUES (${orderId}::uuid, ${payerId}::uuid, 'pack_starter', 999, 20,
              ${over.provider ?? "razorpay"}, ${`launch-db-${TAG}-${orderIds.length}`},
              ${over.status ?? "paid"})`;
    orderIds.push(orderId);
    return orderId;
  }

  async function eventsFor(cohortId: string): Promise<{ n: string; p: Record<string, unknown> }[]> {
    return client.sql<{ n: string; p: Record<string, unknown> }[]>`
      SELECT event_name AS n, payload AS p FROM events
      WHERE correlation_id = ${CTX.correlationId}::uuid
        AND (payload->>'cohort_id' = ${cohortId} OR payload->>'target_id' = ${cohortId})
      ORDER BY occurred_at, event_name`;
  }

  // -----------------------------------------------------------------------------------------
  // The tables
  // -----------------------------------------------------------------------------------------

  describe("the tables", () => {
    it("the result CHECK, and paid_at set exactly when paid (23514 otherwise)", async () => {
      expect(await stateOf(() => rawCohort({ result: "refunded" }))).toBe("23514");
      expect(await stateOf(() => rawCohort({ result: "paid" }))).toBe("23514");
      expect(await stateOf(() => rawCohort({ paidAt: "2026-12-03T00:00:00Z" }))).toBe("23514");
      expect(
        await stateOf(() => rawCohort({ result: "declined", paidAt: "2026-12-03T00:00:00Z" })),
      ).toBe("23514");
      expect(
        await stateOf(() => rawCohort({ result: "paid", paidAt: "2026-12-03T00:00:00Z" })),
      ).toBe("ok");
      for (const result of ["pending", "declined", "no_response"]) {
        expect(await stateOf(() => rawCohort({ result })), result).toBe("ok");
      }
    });

    it("the link: 1..300 characters, and its time needs it", async () => {
      expect(await stateOf(() => rawCohort({ linkRef: "" }))).toBe("23514");
      expect(await stateOf(() => rawCohort({ linkRef: "x".repeat(301) }))).toBe("23514");
      expect(await stateOf(() => rawCohort({ linkRef: "x".repeat(300) }))).toBe("ok");
      expect(await stateOf(() => rawCohort({ linkAt: "2026-12-01T00:00:00Z" }))).toBe("23514");
      expect(
        await stateOf(() => rawCohort({ linkRef: "plink_1", linkAt: "2026-12-01T00:00:00Z" })),
      ).toBe("ok");
    });

    it("the phone's ciphertext and hash together, and one row per factory phone", async () => {
      expect(await stateOf(() => rawCohort({ phoneEnc: `tok:${TAG}:p` }))).toBe("23514");
      expect(await stateOf(() => rawCohort({ phoneHash: `hash:${TAG}:only` }))).toBe("23514");
      const both = { phoneEnc: `tok:${TAG}:p`, phoneHash: `hash:${TAG}:dup` };
      expect(await stateOf(() => rawCohort(both))).toBe("ok");
      expect(await stateOf(() => rawCohort(both))).toBe("23505");
      // NULLs are distinct: any number of factories without a phone.
      expect(await stateOf(() => rawCohort())).toBe("ok");
      expect(await stateOf(() => rawCohort())).toBe("ok");
    });

    it("one factory per paid order; the payer and order FKs hold", async () => {
      const order = await paidOrder(CO_B);
      const paid = { result: "paid", paidAt: "2026-12-03T00:00:00Z", payer: CO_B, order };
      expect(await stateOf(() => rawCohort(paid))).toBe("ok");
      expect(await stateOf(() => rawCohort(paid))).toBe("23505");
      expect(await stateOf(() => rawCohort({ payer: id() }))).toBe("23503");
      expect(await stateOf(() => rawCohort({ order: id() }))).toBe("23503");
    });

    it("a share is one per factory and worker; its worker must exist", async () => {
      const cohort = await rawCohort();
      const share = (workerId: string) =>
        client.sql`INSERT INTO launch_test_shares (cohort_id, worker_id) VALUES (${cohort}::uuid, ${workerId}::uuid)`;
      expect(await stateOf(() => share(WK.real3))).toBe("ok");
      expect(await stateOf(() => share(WK.real3))).toBe("23505");
      expect(await stateOf(() => share(id()))).toBe("23503");
    });

    it("SET NULL on the account and the order; CASCADE with the factory and the worker", async () => {
      const goneCo = id();
      await client.sql`
        INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status)
        VALUES (${goneCo}::uuid, 'employer', ${`enc:lt-${TAG}-gone`}, ${`hash:lt-${TAG}-gone`},
                ${`enc:lt-org-${TAG}-gone`}, 'active')`;
      const order = await paidOrder(goneCo);
      const cohort = await rawCohort({
        result: "paid",
        paidAt: "2026-12-03T00:00:00Z",
        payer: goneCo,
        order,
      });
      const gone = id();
      await client.sql`
        INSERT INTO workers (id, phone_e164, phone_hash, status)
        VALUES (${gone}::uuid, ${`enc:lt-${TAG}-gone`}, ${`hash:lt-w-${TAG}-gone`}, 'active')`;
      await client.sql`
        INSERT INTO launch_test_shares (cohort_id, worker_id)
        VALUES (${cohort}::uuid, ${gone}::uuid), (${cohort}::uuid, ${WK.real3}::uuid)`;

      await client.sql`DELETE FROM payment_orders WHERE id = ${order}::uuid`;
      await client.sql`DELETE FROM payers WHERE id = ${goneCo}::uuid`;
      const [row] = await client.sql<{ payer_id: string | null; order_id: string | null }[]>`
        SELECT payer_id, payment_order_id AS order_id FROM launch_test_cohort WHERE id = ${cohort}::uuid`;
      expect(row).toEqual({ payer_id: null, order_id: null });

      // DPDP erasure: the worker's share goes with him, the other stays.
      await client.sql`DELETE FROM workers WHERE id = ${gone}::uuid`;
      const shares = await client.sql<{ w: string }[]>`
        SELECT worker_id AS w FROM launch_test_shares WHERE cohort_id = ${cohort}::uuid`;
      expect(shares.map((s) => s.w)).toEqual([WK.real3]);

      await client.sql`DELETE FROM launch_test_cohort WHERE id = ${cohort}::uuid`;
      const left =
        await client.sql`SELECT 1 FROM launch_test_shares WHERE cohort_id = ${cohort}::uuid`;
      expect(left).toHaveLength(0);
    });

    it.each(["launch_test_cohort", "launch_test_shares"])(
      "%s: RLS ENABLED and FORCED, no policy, no grant to PUBLIC or a client role",
      async (table) => {
        const [rls] = await client.sql<{ enabled: boolean; forced: boolean }[]>`
          SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
            FROM pg_class WHERE oid = ${`public.${table}`}::regclass`;
        expect(rls).toEqual({ enabled: true, forced: true });
        const [policies] = await client.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_policies WHERE tablename = ${table}`;
        expect(policies!.n).toBe(0);
        const [grants] = await client.sql<{ n: number }[]>`
          SELECT count(*)::int AS n
            FROM pg_class c, aclexplode(c.relacl) a
           WHERE c.oid = ${`public.${table}`}::regclass
             AND (a.grantee = 0
                  OR a.grantee IN (SELECT oid FROM pg_roles
                                    WHERE rolname IN ('anon', 'authenticated', 'service_role')))`;
        expect(grants!.n).toBe(0);
      },
    );
  });

  // -----------------------------------------------------------------------------------------
  // Test A through the service
  // -----------------------------------------------------------------------------------------

  describe("launch test A through the service", () => {
    it("records a factory: the row, its shares and its events in one go; the ordinary account linked", async () => {
      const out = await service.recordFactory(
        ADMIN,
        record({ factory_phone: PHONE_ORDINARY }),
        `lt-${TAG}-a`,
        CTX,
      );
      expect(out.created).toBe(true);
      expect(out.factory).toMatchObject({
        has_phone: true,
        payer_id: CO_A,
        result: "pending",
        share_count: 2,
        sent_by_admin_id: ADMIN.id,
      });
      expect([...out.factory.worker_ids].sort()).toEqual([WK.real1, WK.real2].sort());
      expect(out.factory).not.toHaveProperty("factory_name");
      const [row] = await client.sql<
        { name: string; phone: string; hash: string; same_time: boolean }[]
      >`
        SELECT c.factory_name_enc AS name, c.factory_phone_enc AS phone, c.factory_phone_hash AS hash,
               bool_and(s.shared_at = c.sent_at) AS same_time
          FROM launch_test_cohort c JOIN launch_test_shares s ON s.cohort_id = c.id
         WHERE c.id = ${out.factory.id}::uuid
         GROUP BY c.id`;
      expect(row).toMatchObject({
        name: `tok:${TAG}:Factory ${TAG}`,
        phone: `tok:${TAG}:${PHONE_ORDINARY}`,
        hash: `hash:${TAG}:${PHONE_ORDINARY}`,
      });
      // Every share carries the time the profiles were sent.
      expect(row!.same_time).toBe(true);
      const events = await eventsFor(out.factory.id);
      expect(events.map((e) => e.n).sort()).toEqual(
        ["admin.action_performed", "admin.launch_test_factory_recorded"].sort(),
      );
      expect(events.find((e) => e.n === "admin.launch_test_factory_recorded")!.p).toEqual({
        cohort_id: out.factory.id,
        admin_id: ADMIN.id,
        share_count: 2,
        has_phone: true,
        payer_id: CO_A,
      });

      // The same key again: the stored row, nothing new written or emitted.
      const again = await service.recordFactory(
        ADMIN,
        record({ factory_phone: PHONE_ORDINARY }),
        `lt-${TAG}-a`,
        CTX,
      );
      expect(again).toMatchObject({ created: false, factory: { id: out.factory.id } });
      expect(await eventsFor(out.factory.id)).toHaveLength(2);
      // A NEW key for the same phone: one row per factory.
      await expect(
        service.recordFactory(
          ADMIN,
          record({ factory_phone: PHONE_ORDINARY }),
          `lt-${TAG}-a2`,
          CTX,
        ),
      ).rejects.toMatchObject({ response: { reason: "factory_already_recorded" } });
    });

    it("a factory whose phone a Campus company holds is refused, and nothing is written", async () => {
      await expect(
        service.recordFactory(ADMIN, record({ factory_phone: PHONE_CAMPUS }), `lt-${TAG}-c`, CTX),
      ).rejects.toMatchObject({ status: 409, response: { reason: "campus_company" } });
      const rows = await client.sql`
        SELECT 1 FROM launch_test_cohort WHERE factory_phone_hash = ${`hash:${TAG}:${PHONE_CAMPUS}`}`;
      expect(rows).toHaveLength(0);
    });

    it("part A's worker rules, read in SQL, refuse the whole set with each offender named", async () => {
      await expect(
        service.recordFactory(
          ADMIN,
          record({ worker_ids: [WK.real3, WK.test, WK.linked, WK.sample, id()] }),
          `lt-${TAG}-w`,
          CTX,
        ),
      ).rejects.toMatchObject({
        status: 400,
        response: {
          reason: "workers_not_eligible",
          workers: [
            { worker_id: WK.test, reason: "test_worker" },
            { worker_id: WK.linked, reason: "linked_rvm_identity" },
            { worker_id: WK.sample, reason: "sample_worker" },
            { reason: "not_found" },
          ],
        },
      });
    });

    it("the edit's paid-order check against real orders, then the link", async () => {
      const created = await service.recordFactory(
        ADMIN,
        record({ factory_phone: PHONE_NEW, worker_ids: [WK.real3] }),
        `lt-${TAG}-e`,
        CTX,
      );
      const cohort = created.factory.id;
      expect(created.factory.payer_id).toBeNull();
      const paidAt = new Date("2026-12-05T10:00:00.000Z");
      const linkTo = async (orderId: string, key: string) =>
        service.updateFactory(ADMIN, cohort, { payment_order_id: orderId }, key, CTX);

      // Account and result first.
      const paid = await service.updateFactory(
        ADMIN,
        cohort,
        { payer_id: CO_B, result: "paid", paid_at: paidAt },
        `lt-${TAG}-e1`,
        CTX,
      );
      expect(paid).toMatchObject({ changed: true, factory: { payer_id: CO_B, result: "paid" } });

      for (const [order, reason] of [
        [await paidOrder(CO_B, { provider: "mock" }), "payment_order_not_real"],
        [await paidOrder(CO_B, { status: "created" }), "payment_order_not_paid"],
        [await paidOrder(CO_A), "payment_order_other_payer"],
        [id(), "payment_order_not_found"],
      ] as const) {
        await expect(linkTo(order, `lt-${TAG}-bad-${reason}`)).rejects.toMatchObject({
          status: 409,
          response: { reason },
        });
      }
      const real = await paidOrder(CO_B);
      const linked = await linkTo(real, `lt-${TAG}-e2`);
      expect(linked).toMatchObject({ changed: true, factory: { payment_order_id: real } });
      // Linking it again is no change; another factory cannot take it.
      expect((await linkTo(real, `lt-${TAG}-e3`)).changed).toBe(false);
      const other = await rawCohort({
        result: "paid",
        paidAt: "2026-12-05T00:00:00Z",
        payer: CO_B,
      });
      await expect(
        service.updateFactory(ADMIN, other, { payment_order_id: real }, `lt-${TAG}-e4`, CTX),
      ).rejects.toMatchObject({ response: { reason: "payment_order_already_linked" } });

      const updates = (await eventsFor(cohort)).filter(
        (e) => e.n === "admin.launch_test_factory_updated",
      );
      expect(updates.map((e) => e.p.changed)).toEqual([["result", "payer"], ["payment_order"]]);
      expect(JSON.stringify(await eventsFor(cohort))).not.toContain("Factory");
    });

    it("the list: names only through the identity service, audited before the decrypt; never a phone", async () => {
      const page = await service.listCohort(ADMIN, { limit: 50 }, CTX);
      const mine = page.rows.filter((r) => r.sent_by_admin_id === ADMIN.id);
      expect(mine.length).toBeGreaterThan(0);
      const named = mine.find((r) => r.has_phone && r.payer_id === CO_A)!;
      expect(named.factory_name).toBe(`Factory ${TAG}`);
      expect(JSON.stringify(page)).not.toContain(PHONE_ORDINARY);
      const [audit] = await client.sql<{ p: Record<string, unknown> }[]>`
        SELECT payload AS p FROM events
         WHERE correlation_id = ${CTX.correlationId}::uuid AND event_name = 'admin.identity_viewed'
         ORDER BY occurred_at DESC LIMIT 1`;
      expect(audit!.p).toMatchObject({
        admin_id: ADMIN.id,
        surface: "launch_test_factories",
        subject_id: null,
      });
      // The projection the identity layer reads: the name token and the id, nothing else.
      const rows = await new AdminIdentityRepository(client.db).launchTestFactoryNames([named.id]);
      expect(rows).toEqual([{ id: named.id, nameCipher: `tok:${TAG}:Factory ${TAG}` }]);

      // A role without read_identity (analyst: the route itself refuses it; the service is called
      // directly here) gets the list faceless: the field is absent, not null.
      const faceless = await service.listCohort({ ...ADMIN, role: "analyst" }, { limit: 50 }, CTX);
      expect(faceless.rows.every((r) => !("factory_name" in r))).toBe(true);
    });
  });

  // -----------------------------------------------------------------------------------------
  // Test B
  // -----------------------------------------------------------------------------------------

  describe("launch test B: contacts per hire", () => {
    it("the route's answer EQUALS a hand-written SQL over the same rows", async () => {
      const report = await service.contactsPerHire();
      const patterns = [...sampleWorkerIdLikePatterns()];
      const rows = await client.sql<
        {
          hire_id: string;
          counted: boolean;
          unlock_id: string | null;
          outcome: string | null;
          answered_by: string | null;
        }[]
      >`
        WITH first AS (
          SELECT h.id, h.tenant_payer_id, h.posting_id,
                 LEAST(h.company_marked_at, h.company_answered_at, h.desk_confirmed_at) AS confirmed_at,
                 (h.posting_kind = 'company_posting' AND jp.id IS NOT NULL) AS counted
            FROM hires h
            JOIN payers p ON p.id = h.tenant_payer_id
            JOIN workers w ON w.id = h.worker_id
            LEFT JOIN job_postings jp ON jp.id = h.posting_id
           WHERE h.status = 'confirmed'
             AND NOT p.is_test_account
             AND NOT w.is_test_account
             AND NOT (w.id::text LIKE ANY(${patterns}::text[]))
           ORDER BY confirmed_at, h.id
           LIMIT 50
        )
        SELECT f.id AS hire_id, f.counted, c.id AS unlock_id, o.outcome, o.answered_by
          FROM first f
          LEFT JOIN LATERAL (
            SELECT u.id, u.granted_at
              FROM unlocks u
              LEFT JOIN workers uw ON uw.id = u.worker_id
             WHERE f.counted
               AND u.payer_id = f.tenant_payer_id
               AND u.job_posting_id = f.posting_id
               AND u.status IN ('granted', 'revealed', 'expired')
               AND u.granted_at IS NOT NULL
               AND u.granted_at <= f.confirmed_at
               AND (uw.id IS NULL
                    OR (NOT uw.is_test_account AND NOT (uw.id::text LIKE ANY(${patterns}::text[]))))
          ) c ON TRUE
          LEFT JOIN unlock_outcomes o ON o.unlock_id = c.id
         ORDER BY f.confirmed_at, f.id, c.granted_at, c.id`;

      // Fold the hand-written rows into the route's shape.
      const expected: {
        hire_id: string;
        contacts: string[] | null;
        outcomes: (string | null)[];
      }[] = [];
      for (const r of rows) {
        let last = expected[expected.length - 1];
        if (last === undefined || last.hire_id !== r.hire_id) {
          last = { hire_id: r.hire_id, contacts: r.counted ? [] : null, outcomes: [] };
          expected.push(last);
        }
        if (r.unlock_id !== null) {
          last.contacts!.push(r.unlock_id);
          last.outcomes.push(r.outcome === null ? null : `${r.outcome}/${r.answered_by}`);
        }
      }
      const actual = report.hires.map((h) => ({
        hire_id: h.hire_id,
        contacts: h.contacts === null ? null : h.contacts.map((c) => c.unlock_id),
        outcomes:
          h.contacts === null
            ? []
            : h.contacts.map((c) =>
                c.outcome === null ? null : `${c.outcome.outcome}/${c.outcome.answered_by}`,
              ),
      }));
      expect(actual).toEqual(expected);
      const counted = expected.filter((e) => e.contacts !== null);
      const opened = counted.reduce((n, e) => n + e.contacts!.length, 0);
      expect(report.totals).toEqual({
        hires_listed: expected.length,
        hires_counted: counted.length,
        contacts_opened: opened,
        contacts_per_hire: { numerator: opened, denominator: counted.length },
      });
      expect(report.limit).toBe(50);
    });

    it("the seeded hires: their order, the microsecond cut-off, the exclusions and the reasons", async () => {
      const report = await service.contactsPerHire();
      const mine = report.hires.filter((h) => Object.values(H).includes(h.hire_id));
      // The 2001 hires come first in the whole table, in this order.
      expect(report.hires.slice(0, mine.length)).toEqual(mine);
      expect(mine.map((h) => h.hire_id)).toEqual([H.a1, H.a2tie, H.b, H.a1b, H.gone, H.agency]);

      const byId = new Map(mine.map((h) => [h.hire_id, h]));
      // At the very microsecond of the confirmation: in. One microsecond later: out.
      expect(byId.get(H.a1)!.contacts!.map((c) => c.unlock_id)).toEqual([U.u1, U.u7, U.u12, U.u2]);
      expect(byId.get(H.a1)).toMatchObject({
        payer_id: CO_A,
        posting_kind: "company_posting",
        job_posting_id: POST_A1,
        worker_id: WK.h1,
        confirmed_at: "2001-01-10T10:00:00.000002Z",
        contacts_reason: null,
      });
      expect(byId.get(H.a1)!.contacts![0]!.outcome).toMatchObject({
        outcome: "hired",
        answered_by: "company",
      });
      // The erased worker's contact counts, with no worker id.
      expect(byId.get(H.a1)!.contacts![1]).toMatchObject({ unlock_id: U.u7, worker_id: null });
      expect(byId.get(H.a1b)!.contacts!.map((c) => c.unlock_id)).toEqual([
        U.u1,
        U.u7,
        U.u12,
        U.u2,
        U.u3,
      ]);
      expect(byId.get(H.a2tie)!.contacts).toEqual([
        expect.objectContaining({
          unlock_id: U.u5,
          outcome: expect.objectContaining({ outcome: "not_reached", answered_by: "desk" }),
        }),
      ]);
      expect(byId.get(H.b)!.contacts!.map((c) => c.unlock_id)).toEqual([U.u9]);
      expect(byId.get(H.gone)).toMatchObject({
        contacts: null,
        contacts_reason: "posting_deleted",
      });
      expect(byId.get(H.agency)).toMatchObject({
        posting_kind: "agency_job",
        job_posting_id: null,
        contacts: null,
        contacts_reason: "agency_job",
      });
      // Never listed: reported, rejected, a test company's, a test worker's, a sample worker's.
      const listed = new Set(report.hires.map((h) => h.hire_id));
      for (const out of [H.reported, H.rejected, H.testCo, H.testWorker, H.sample]) {
        expect(listed.has(out), out).toBe(false);
      }
    });
  });

  // -----------------------------------------------------------------------------------------
  // Fixtures
  // -----------------------------------------------------------------------------------------

  async function seed(c: DbClient): Promise<void> {
    const { sql } = c;
    const payer = async (pid: string, i: number, phone: string | null, isTest = false) => {
      await sql`
        INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status, phone_enc,
                            phone_hash, is_test_account)
        VALUES (${pid}::uuid, 'employer', ${`enc:lt-${TAG}-${i}`}, ${`hash:lt-${TAG}-${i}`},
                ${`enc:lt-org-${TAG}-${i}`}, 'active',
                ${phone === null ? null : `enc:lt-${TAG}-p${i}`},
                ${phone === null ? null : pii.hashPhone(phone)}, ${isTest})`;
    };
    await payer(CO_A, 0, PHONE_ORDINARY);
    await payer(CO_B, 1, null);
    await payer(CO_T, 2, null, true);
    await payer(CO_CAMPUS, 3, PHONE_CAMPUS);
    await sql`INSERT INTO institute_companies (payer_id, institute_code) VALUES (${CO_CAMPUS}::uuid, 'rvm')`;

    for (const [i, [k, wid]] of Object.entries(WK).entries()) {
      const status = k === "linked" ? "pending" : "active";
      await sql`
        INSERT INTO workers (id, phone_e164, phone_hash, status, is_test_account)
        VALUES (${wid}::uuid, ${`enc:lt-${TAG}-${i}`}, ${`hash:lt-w-${TAG}-${i}`}, ${status},
                ${k === "test"})`;
    }
    await sql`INSERT INTO worker_origins (worker_id, kind, ref) VALUES (${WK.linked}::uuid, 'institute', 'rvm')`;

    for (const [pid, owner] of [
      [POST_A1, CO_A],
      [POST_A2, CO_A],
      [POST_B, CO_B],
    ] as const) {
      await sql`
        INSERT INTO job_postings (id, created_by, payer_id, org_label, role_title, vacancy_band,
                                  status, match_skill_ids, reach_skill_ids, published_at)
        VALUES (${pid}::uuid, ${OPS}::uuid, ${owner}::uuid, 'Launch Fixture',
                ${`Launch posting ${TAG}`}, '1', 'open', '["mskill_vmc_operator"]'::jsonb,
                '["mskill_vmc_operator"]'::jsonb, now())`;
    }
    await sql`
      INSERT INTO jobs (id, trade_key, title, city, status, payer_id, min_experience_years, pay_min, pay_max)
      VALUES (${JOB_A}::uuid, 'cnc_vmc', ${`Launch job ${TAG}`}, 'pune', 'open', ${CO_A}::uuid,
              1, 18000, 30000)`;

    // Hires. Stamps are 2001 instants at microsecond precision.
    const hire = async (
      hid: string,
      tenant: string,
      worker: string,
      kind: "company_posting" | "agency_job",
      posting: string,
      status: "confirmed" | "reported" | "rejected",
      stamps: { mark?: string; answer?: string; worker?: string; desk?: string },
    ) => {
      await sql`
        INSERT INTO hires (id, tenant_payer_id, worker_id, posting_kind, posting_id, status,
                           company_marked_at, company_answered_at, worker_answered_at,
                           desk_confirmed_at, hired_on)
        VALUES (${hid}::uuid, ${tenant}::uuid, ${worker}::uuid, ${kind}, ${posting}::uuid, ${status},
                ${stamps.mark ?? null}::timestamptz, ${stamps.answer ?? null}::timestamptz,
                ${stamps.worker ?? null}::timestamptz, ${stamps.desk ?? null}::timestamptz,
                ${status === "reported" ? null : "2001-01-10"}::date)`;
    };
    // a1 and a2tie confirm at the SAME microsecond: the id breaks the tie (a1 < a2tie).
    await hire(H.a1, CO_A, WK.h1, "company_posting", POST_A1, "confirmed", {
      mark: `${at("10")}T10:00:00.000002Z`,
      answer: `${at("15")}T10:00:00Z`,
    });
    await hire(H.a2tie, CO_A, WK.h2, "company_posting", POST_A2, "confirmed", {
      answer: `${at("10")}T10:00:00.000002Z`,
    });
    await hire(H.b, CO_B, WK.h3, "company_posting", POST_B, "confirmed", {
      desk: `${at("11")}T10:00:00Z`,
    });
    await hire(H.a1b, CO_A, WK.h4, "company_posting", POST_A1, "confirmed", {
      desk: `${at("12")}T10:00:00Z`,
      worker: `${at("02")}T10:00:00Z`,
    });
    await hire(H.gone, CO_B, WK.h5, "company_posting", POST_GONE, "confirmed", {
      mark: `${at("13")}T10:00:00Z`,
    });
    await hire(H.agency, CO_A, WK.h6, "agency_job", JOB_A, "confirmed", {
      answer: `${at("14")}T10:00:00Z`,
    });
    await hire(H.reported, CO_A, WK.h7, "company_posting", POST_A1, "reported", {
      worker: `${at("01")}T10:00:00Z`,
    });
    await hire(H.rejected, CO_A, WK.h8, "company_posting", POST_A2, "rejected", {
      mark: `${at("01")}T10:00:00Z`,
    });
    await hire(H.testCo, CO_T, WK.h9, "company_posting", POST_B, "confirmed", {
      mark: `${at("02")}T10:00:00Z`,
    });
    await hire(H.testWorker, CO_A, WK.test, "company_posting", POST_A1, "confirmed", {
      mark: `${at("02")}T10:00:00Z`,
    });
    await hire(H.sample, CO_A, WK.sample, "company_posting", POST_A1, "confirmed", {
      mark: `${at("02")}T10:00:00Z`,
    });

    // Unlocks: one per (company, worker).
    const unlock = async (
      uid: string,
      payerId: string,
      worker: string | null,
      posting: string | null,
      status: string,
      granted: string | null,
    ) => {
      await sql`
        INSERT INTO unlocks (id, payer_id, worker_id, job_posting_id, status, granted_at)
        VALUES (${uid}::uuid, ${payerId}::uuid, ${worker}::uuid, ${posting}::uuid, ${status},
                ${granted}::timestamptz)`;
    };
    await unlock(U.u1!, CO_A, WK.c1, POST_A1, "granted", `${at("05")}T10:00:00Z`);
    await unlock(U.u2!, CO_A, WK.c2, POST_A1, "revealed", `${at("10")}T10:00:00.000002Z`);
    await unlock(U.u3!, CO_A, WK.c3, POST_A1, "granted", `${at("10")}T10:00:00.000003Z`);
    await unlock(U.u4!, CO_A, WK.c4, POST_A1, "denied", null);
    await unlock(U.u5!, CO_A, WK.c5, POST_A2, "expired", `${at("09")}T10:00:00Z`);
    await unlock(U.u6!, CO_A, WK.c6, POST_A1, "granted", `${at("13")}T10:00:00Z`);
    await unlock(U.u7!, CO_A, null, POST_A1, "granted", `${at("06")}T10:00:00Z`);
    await unlock(U.u8!, CO_A, WK.test, POST_A1, "granted", `${at("06")}T10:00:00Z`);
    await unlock(U.u9!, CO_B, WK.c7, POST_B, "granted", `${at("08")}T10:00:00Z`);
    await unlock(U.u10!, CO_A, WK.c8, null, "granted", `${at("05")}T10:00:00Z`);
    await unlock(U.u11!, CO_B, WK.c9, POST_A1, "granted", `${at("05")}T10:00:00Z`);
    await unlock(U.u12!, CO_A, WK.h1, POST_A1, "granted", `${at("07")}T10:00:00Z`);

    const outcome = async (uid: string, tenant: string, worker: string, o: string, by: string) => {
      await sql`
        INSERT INTO unlock_outcomes (unlock_id, tenant_payer_id, worker_id, outcome, answered_by,
                                     answered_at)
        VALUES (${uid}::uuid, ${tenant}::uuid, ${worker}::uuid, ${o}, ${by},
                ${`${at("20")}T10:00:00Z`}::timestamptz)`;
    };
    await outcome(U.u1!, CO_A, WK.c1, "hired", "company");
    await outcome(U.u5!, CO_A, WK.c5, "not_reached", "desk");
    await outcome(U.u9!, CO_B, WK.c7, "still_talking", "company");
  }
});
