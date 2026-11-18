import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "@badabhai/db";
import type { ServerConfig } from "@badabhai/config";
import type { RequestContext } from "../common/request-context";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { WorkersRepository } from "../workers/workers.repository";
import { PayOnJoiningHiresRepository } from "./pay-on-joining-hires.repository";
import { PayOnJoiningHiresService } from "./pay-on-joining-hires.service";
import { paymentStateOf } from "./pay-on-joining.state";

/**
 * #2753 item 11 — `pay_on_joining_hires` (migration 0171) against a real Postgres.
 *
 * The unit suites prove the service SAYS the right thing. Only a database proves:
 *  - a real create then patch: the percent copied from the setting, the floor share, the share
 *    recomputed with the STORED percent after the setting moved, and the row, its `audit_logs` row
 *    and `pay_on_joining.recorded` committed together (a failing emit leaves no row behind);
 *  - the CHECKs refuse a negative fee, a percent outside 0..100, a share that is not the floor, a
 *    30-day check without its outcome and an oversized or empty note;
 *  - the unique hire key, NULLS NOT DISTINCT: a hire with no posting is still recorded once;
 *  - the `paid` filter's SQL agrees with `paymentStateOf` on every state;
 *  - erasure: `WorkersRepository.hardDelete` removes the worker's hires (the FK cascade), and the
 *    partner's SET NULL keeps the factory's record;
 *  - RLS is enabled and FORCED, with no policy and no grant to any PostgREST role.
 *
 * Fixtures carry no real PII: synthetic ids, the account names are opaque test tokens.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api exec vitest run pay-on-joining-hires.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function assertLocalDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`pay-on-joining-hires.db refuses to write to a non-local host (${host})`);
  }
}

const TAG = randomUUID().slice(0, 8);
const CTX: RequestContext = { correlationId: randomUUID(), requestId: `poj-db-${TAG}` };
const ADMIN = { id: randomUUID(), role: "ops_admin" as const, sid: "s" };
const FACTORY = randomUUID();
const FACTORY_2 = randomUUID();
const PARTNER = randomUUID();
const PARTNER_GONE = randomUUID();
const OPS = randomUUID();
const POSTING = randomUUID();
const WORKER = randomUUID();
const WORKER_2 = randomUUID();
const WORKER_ERASED = randomUUID();
const WORKER_STATES = randomUUID();
const WORKERS = [WORKER, WORKER_2, WORKER_ERASED, WORKER_STATES];
const PAYERS = [FACTORY, FACTORY_2, PARTNER, PARTNER_GONE];
const NOTE = `Confirmed by the plant manager on a visit ${TAG}`;

describe.skipIf(!RUN)(
  "pay_on_joining_hires against Postgres (#2753 item 11, migration 0171)",
  () => {
    let client!: DbClient;
    let repo!: PayOnJoiningHiresRepository;
    let events!: EventsService;
    const config = { POJ_PARTNER_SHARE_PERCENT: 70 } as unknown as ServerConfig;
    let service!: PayOnJoiningHiresService;

    beforeAll(async () => {
      assertLocalDatabase(DATABASE_URL);
      client = createDbClient(DATABASE_URL, { max: 4 });
      repo = new PayOnJoiningHiresRepository(client.db);
      events = new EventsService(new EventsRepository(client.db), { NODE_ENV: "test" } as never);
      service = new PayOnJoiningHiresService(repo, events, config);
      await seed(client);
    }, 60_000);

    afterAll(async () => {
      if (!client) return;
      const { sql } = client;
      const hires = await sql<{ id: string }[]>`
      SELECT id FROM pay_on_joining_hires WHERE factory_payer_id = ANY(${PAYERS}::uuid[])`;
      const ids = hires.map((h) => h.id);
      await sql`DELETE FROM pay_on_joining_hires WHERE factory_payer_id = ANY(${PAYERS}::uuid[])`;
      if (ids.length > 0) {
        await sql`DELETE FROM audit_logs WHERE entity_type = 'pay_on_joining_hire' AND entity_id = ANY(${ids}::uuid[])`;
      }
      await sql`DELETE FROM events WHERE correlation_id = ${CTX.correlationId}::uuid`;
      await sql`DELETE FROM workers WHERE id = ANY(${WORKERS}::uuid[])`;
      await sql`DELETE FROM job_postings WHERE id = ${POSTING}::uuid`;
      await sql`DELETE FROM payers WHERE id = ANY(${PAYERS}::uuid[])`;
      await sql.end({ timeout: 5 });
    });

    /** A raw insert's SQLSTATE, or "ok". */
    async function sqlstate(run: Promise<unknown>): Promise<string> {
      try {
        await run;
        return "ok";
      } catch (err) {
        return String((err as { code?: string }).code ?? "unknown");
      }
    }

    /** A raw row, with every column the CHECKs read overridable. */
    function rawInsert(over: Record<string, unknown> = {}) {
      const v = {
        factory: FACTORY_2,
        worker: WORKER_2,
        posting: null as string | null,
        fee: 500_000,
        percent: 70,
        share: 350_000,
        stayOn: null as string | null,
        stayed: null as boolean | null,
        note: null as string | null,
        ...over,
      };
      return client.sql`
      INSERT INTO pay_on_joining_hires
        (factory_payer_id, worker_id, job_posting_id, joined_on, fee_paise, partner_share_percent,
         partner_share_paise, stay_checked_on, stayed_30_days, note, created_by_admin_id,
         updated_by_admin_id)
      VALUES (${v.factory}::uuid, ${v.worker}::uuid, ${v.posting}::uuid, '2026-12-01',
              ${v.fee}, ${v.percent}, ${v.share}, ${v.stayOn}::date, ${v.stayed}, ${v.note},
              ${ADMIN.id}::uuid, ${ADMIN.id}::uuid)`;
    }

    it("a real create then patch: the copied percent, the floor share, the stored-percent recompute", async () => {
      const created = await service.create(
        ADMIN,
        {
          factory_payer_id: FACTORY,
          worker_id: WORKER,
          job_posting_id: POSTING,
          partner_payer_id: PARTNER,
          joined_on: "2026-12-01",
          fee_paise: 500_000,
          note: NOTE,
        },
        CTX,
      );
      const id = created.hire.id;
      const [row] = await client.sql<
        { fee: string; percent: number; share: string; note: string; created_by: string }[]
      >`
      SELECT fee_paise::text AS fee, partner_share_percent AS percent,
             partner_share_paise::text AS share, note, created_by_admin_id AS created_by
        FROM pay_on_joining_hires WHERE id = ${id}::uuid`;
      expect(row).toEqual({
        fee: "500000",
        percent: 70,
        share: "350000",
        note: NOTE,
        created_by: ADMIN.id,
      });

      // The setting moves to 50; the recorded hire keeps 70 when its fee changes.
      (config as { POJ_PARTNER_SHARE_PERCENT: number }).POJ_PARTNER_SHARE_PERCENT = 50;
      try {
        const patched = await service.update(
          ADMIN,
          id,
          {
            fee_paise: 1_000_001,
            factory_paid_on: "2027-01-05",
            stay_checked_on: "2026-12-31",
            stayed_30_days: true,
          },
          CTX,
        );
        expect(patched.changed).toBe(true);
        expect(patched.hire).toMatchObject({
          fee_paise: 1_000_001,
          partner_share_percent: 70,
          partner_share_paise: 700_000, // floor(1000001 * 70 / 100)
          payment_state: "partner_due",
        });
      } finally {
        (config as { POJ_PARTNER_SHARE_PERCENT: number }).POJ_PARTNER_SHARE_PERCENT = 70;
      }
      const [after] = await client.sql<{ percent: number; share: string; updated: boolean }[]>`
      SELECT partner_share_percent AS percent, partner_share_paise::text AS share,
             updated_at > created_at AS updated
        FROM pay_on_joining_hires WHERE id = ${id}::uuid`;
      expect(after).toEqual({ percent: 70, share: "700000", updated: true });

      // One audit row per write, keys only.
      const audit = await client.sql<{ action: string; metadata: Record<string, unknown> }[]>`
      SELECT action, metadata FROM audit_logs
       WHERE entity_type = 'pay_on_joining_hire' AND entity_id = ${id}::uuid
       ORDER BY created_at`;
      expect(audit.map((a) => a.action)).toEqual([
        "pay_on_joining_hire_created",
        "pay_on_joining_hire_updated",
      ]);
      expect(audit[1]!.metadata).toEqual({
        changed_fields: ["stay_checked_on", "stayed_30_days", "fee_paise", "factory_paid_on"],
      });

      // The events: one recorded + one admin action per write, ids and paise, never the note.
      const spine = await client.sql<
        { event_name: string; subject_id: string; payload: Record<string, unknown> }[]
      >`
      SELECT event_name, subject_id, payload FROM events
       WHERE correlation_id = ${CTX.correlationId}::uuid
         AND (payload->>'hire_id' = ${id} OR payload->>'target_id' = ${id})
       ORDER BY occurred_at, event_name`;
      expect(spine.map((e) => e.event_name).sort()).toEqual(
        [
          "admin.action_performed",
          "admin.action_performed",
          "pay_on_joining.recorded",
          "pay_on_joining.recorded",
        ].sort(),
      );
      const recorded = spine.filter((e) => e.event_name === "pay_on_joining.recorded");
      expect(recorded.map((e) => e.payload.change).sort()).toEqual(["created", "updated"]);
      expect(recorded.find((e) => e.payload.change === "updated")!.payload).toMatchObject({
        fee_paise: 1_000_001,
        partner_share_paise: 700_000,
        partner_share_percent: 70,
        payment_state: "partner_due",
        stayed_30_days: true,
      });
      for (const e of spine) {
        expect(e.subject_id).toBe(FACTORY);
        expect(JSON.stringify(e.payload)).not.toContain("plant manager");
      }
      for (const a of audit) expect(JSON.stringify(a.metadata)).not.toContain("plant manager");

      // A second record of the same hire is a 409.
      await expect(
        service.create(
          ADMIN,
          {
            factory_payer_id: FACTORY,
            worker_id: WORKER,
            job_posting_id: POSTING,
            joined_on: "2026-12-02",
            fee_paise: 1,
          },
          CTX,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    }, 30_000);

    it("the row, its audit and its event commit together: a failing emit leaves nothing", async () => {
      const failing = new PayOnJoiningHiresService(
        repo,
        { emit: async () => Promise.reject(new Error("spine refused")) } as never,
        config,
      );
      await expect(
        failing.create(
          ADMIN,
          {
            factory_payer_id: FACTORY,
            worker_id: WORKER_2,
            joined_on: "2026-12-01",
            fee_paise: 100,
          },
          CTX,
        ),
      ).rejects.toThrow("spine refused");
      const [left] = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pay_on_joining_hires
       WHERE factory_payer_id = ${FACTORY}::uuid AND worker_id = ${WORKER_2}::uuid`;
      expect(left?.n).toBe(0);
    });

    it("an id that names nothing is a 400 naming the field", async () => {
      await expect(
        service.create(
          ADMIN,
          {
            factory_payer_id: randomUUID(),
            worker_id: WORKER_2,
            joined_on: "2026-12-01",
            fee_paise: 100,
          },
          CTX,
        ),
      ).rejects.toThrow("factory_payer_id names no record");
      await expect(
        service.create(
          ADMIN,
          {
            factory_payer_id: FACTORY,
            worker_id: randomUUID(),
            joined_on: "2026-12-01",
            fee_paise: 100,
          },
          CTX,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("the CHECKs refuse bad money, a broken 30-day pair and a bad note", async () => {
      expect(await sqlstate(rawInsert({ fee: -1, share: 0 }))).toBe("23514");
      expect(await sqlstate(rawInsert({ percent: 101, share: 505_000 }))).toBe("23514");
      expect(await sqlstate(rawInsert({ percent: -1, share: 0 }))).toBe("23514");
      expect(await sqlstate(rawInsert({ share: -1 }))).toBe("23514");
      // Not the floor: rounded up, or simply some other figure.
      expect(await sqlstate(rawInsert({ fee: 500_099, share: 350_070 }))).toBe("23514");
      expect(await sqlstate(rawInsert({ share: 350_001 }))).toBe("23514");
      // The 30-day check: a date without its outcome, or the other way round.
      expect(await sqlstate(rawInsert({ stayOn: "2026-12-31" }))).toBe("23514");
      expect(await sqlstate(rawInsert({ stayed: false }))).toBe("23514");
      expect(await sqlstate(rawInsert({ note: "" }))).toBe("23514");
      expect(await sqlstate(rawInsert({ note: "x".repeat(501) }))).toBe("23514");
      // The floor at its edge, and the large-fee arithmetic, are accepted exactly.
      expect(
        await sqlstate(rawInsert({ fee: 500_099, share: 350_069, note: "x".repeat(500) })),
      ).toBe("ok");
      await client.sql`DELETE FROM pay_on_joining_hires WHERE factory_payer_id = ${FACTORY_2}::uuid`;
      const big = 9_007_199_254_740_988;
      expect(await sqlstate(rawInsert({ fee: big, share: 6_305_039_478_318_691 }))).toBe("ok");
      await client.sql`DELETE FROM pay_on_joining_hires WHERE factory_payer_id = ${FACTORY_2}::uuid`;
      expect(await sqlstate(rawInsert({ fee: big, share: 6_305_039_478_318_692 }))).toBe("23514");
    });

    it("one row per hire, NULLS NOT DISTINCT: a hire with no posting is still recorded once", async () => {
      expect(await sqlstate(rawInsert({ posting: null }))).toBe("ok");
      expect(await sqlstate(rawInsert({ posting: null }))).toBe("23505");
      // The same worker at the same factory against a posting is a different hire.
      expect(await sqlstate(rawInsert({ posting: POSTING }))).toBe("ok");
      expect(await sqlstate(rawInsert({ posting: POSTING }))).toBe("23505");
      await client.sql`DELETE FROM pay_on_joining_hires WHERE factory_payer_id = ${FACTORY_2}::uuid`;
    });

    it("the `paid` filter's SQL agrees with paymentStateOf on every state", async () => {
      const make = (over: Record<string, unknown>) =>
        service.create(
          ADMIN,
          {
            factory_payer_id: FACTORY_2,
            worker_id: WORKER_STATES,
            joined_on: "2026-12-01",
            fee_paise: 500_000,
            ...over,
          } as never,
          CTX,
        );
      const p1 = randomUUID();
      await client.sql`
      INSERT INTO job_postings (id, created_by, payer_id, org_label, role_title, vacancy_band, status,
                                match_skill_ids, reach_skill_ids, published_at)
      VALUES (${p1}::uuid, ${OPS}::uuid, ${FACTORY_2}::uuid, ${`Factory two ${TAG}`}, ${`Operator ${TAG}`},
              '1', 'open', '[]'::jsonb, '[]'::jsonb, now())`;
      const p2 = randomUUID();
      await client.sql`
      INSERT INTO job_postings (id, created_by, payer_id, org_label, role_title, vacancy_band, status,
                                match_skill_ids, reach_skill_ids, published_at)
      VALUES (${p2}::uuid, ${OPS}::uuid, ${FACTORY_2}::uuid, ${`Factory two ${TAG}`}, ${`Fitter ${TAG}`},
              '1', 'open', '[]'::jsonb, '[]'::jsonb, now())`;
      try {
        // awaiting_factory; partner_due; settled (partner paid); settled (no partner).
        const made = [
          await make({ partner_payer_id: PARTNER }),
          await make({
            job_posting_id: p1,
            partner_payer_id: PARTNER,
            factory_paid_on: "2027-01-05",
          }),
          await make({
            job_posting_id: p2,
            partner_payer_id: PARTNER,
            factory_paid_on: "2027-01-05",
            partner_paid_on: "2027-01-06",
          }),
        ];
        expect(made.map((m) => m.hire.payment_state)).toEqual([
          "awaiting_factory",
          "partner_due",
          "settled",
        ]);
        const listed = new Map<string, string>();
        for (const paid of ["awaiting_factory", "partner_due", "settled"] as const) {
          const page = await service.list({ factory_payer_id: FACTORY_2, paid, limit: 100 });
          for (const item of page.items) {
            expect(
              paymentStateOf({
                factoryPaidOn: item.factory_paid_on,
                partnerPayerId: item.partner_payer_id,
                partnerSharePaise: item.partner_share_paise,
                partnerPaidOn: item.partner_paid_on,
              }),
              item.id,
            ).toBe(paid);
            expect(item.payment_state).toBe(paid);
            listed.set(item.id, paid);
          }
        }
        for (const m of made) expect(listed.get(m.hire.id)).toBe(m.hire.payment_state);

        // The partner filter, and keyset paging one row at a time reaches every row exactly once.
        const byPartner = await service.list({
          partner_payer_id: PARTNER,
          factory_payer_id: FACTORY_2,
          limit: 100,
        });
        expect(byPartner.items).toHaveLength(3);
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let i = 0; i < 10; i += 1) {
          const page = await service.list({ factory_payer_id: FACTORY_2, limit: 1, cursor });
          seen.push(...page.items.map((x) => x.id));
          if (page.nextCursor === null) break;
          cursor = page.nextCursor;
        }
        expect(seen.sort()).toEqual(made.map((m) => m.hire.id).sort());
      } finally {
        await client.sql`DELETE FROM pay_on_joining_hires WHERE factory_payer_id = ${FACTORY_2}::uuid`;
        await client.sql`DELETE FROM job_postings WHERE id = ANY(${[p1, p2]}::uuid[])`;
      }
    }, 30_000);

    it("erasure: hardDelete removes the worker's hires; a gone partner leaves the factory's record", async () => {
      const kept = await service.create(
        ADMIN,
        {
          factory_payer_id: FACTORY,
          worker_id: WORKER_ERASED,
          partner_payer_id: PARTNER_GONE,
          joined_on: "2026-12-01",
          fee_paise: 590_000,
        },
        CTX,
      );
      // The partner login goes (SET NULL): the hire stays with its factory, money untouched.
      await client.sql`DELETE FROM payers WHERE id = ${PARTNER_GONE}::uuid`;
      const [orphan] = await client.sql<{ partner: string | null; share: string }[]>`
      SELECT partner_payer_id AS partner, partner_share_paise::text AS share
        FROM pay_on_joining_hires WHERE id = ${kept.hire.id}::uuid`;
      expect(orphan).toEqual({ partner: null, share: "413000" });

      // The worker is erased (DPDP): his hires go with him.
      await expect(new WorkersRepository(client.db).hardDelete(WORKER_ERASED)).resolves.toBe(true);
      const [left] = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pay_on_joining_hires WHERE worker_id = ${WORKER_ERASED}::uuid`;
      expect(left?.n).toBe(0);
    });

    it("RLS is ENABLED and FORCED, with no policy and no grant to any PostgREST role", async () => {
      const [rls] = await client.sql<{ enabled: boolean; forced: boolean }[]>`
      SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
        FROM pg_class WHERE oid = 'public.pay_on_joining_hires'::regclass`;
      expect(rls).toEqual({ enabled: true, forced: true });
      const [policies] = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'pay_on_joining_hires'`;
      expect(policies?.n).toBe(0);
      const roles = await client.sql<{ rolname: string }[]>`
      SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')`;
      // The migration's REVOKEs name all three, so a migrated database has them.
      expect(roles.map((r) => r.rolname).sort()).toEqual(["anon", "authenticated", "service_role"]);
      for (const { rolname } of roles) {
        for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
          const [has] = await client.sql<{ has: boolean }[]>`
          SELECT has_table_privilege(${rolname}::name, 'public.pay_on_joining_hires'::text, ${priv}::text) AS has`;
          expect(has?.has, `${rolname} ${priv}`).toBe(false);
        }
      }
      const [publicGrant] = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.role_table_grants
       WHERE table_name = 'pay_on_joining_hires' AND grantee = 'PUBLIC'`;
      expect(publicGrant?.n).toBe(0);
    });

    async function seed(c: DbClient): Promise<void> {
      const { sql } = c;
      for (const [i, [id, role]] of (
        [
          [FACTORY, "employer"],
          [FACTORY_2, "employer"],
          [PARTNER, "agent"],
          [PARTNER_GONE, "agent"],
        ] as const
      ).entries()) {
        await sql`
        INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status)
        VALUES (${id}::uuid, ${role}, ${`enc:poj-${TAG}-${i}`}, ${`hash:poj-${TAG}-${i}`},
                ${`enc:poj-org-${TAG}-${i}`}, 'active')`;
      }
      await sql`
      INSERT INTO job_postings (id, created_by, payer_id, org_label, role_title, vacancy_band, status,
                                match_skill_ids, reach_skill_ids, published_at)
      VALUES (${POSTING}::uuid, ${OPS}::uuid, ${FACTORY}::uuid, ${`Factory ${TAG}`}, ${`Operator ${TAG}`},
              '1', 'open', '[]'::jsonb, '[]'::jsonb, now())`;
      for (const [i, w] of WORKERS.entries()) {
        await sql`
        INSERT INTO workers (id, phone_e164, phone_hash, status)
        VALUES (${w}::uuid, ${`enc:poj-${TAG}-${i}`}, ${`hash:poj-${TAG}-${i}`}, 'active')`;
      }
    }
  },
);
