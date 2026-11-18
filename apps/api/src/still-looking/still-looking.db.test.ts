import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql as dsql } from "drizzle-orm";
import { loadServerConfig, type ServerConfig } from "@badabhai/config";
import { createDbClient, type DbClient } from "@badabhai/db";

import { DevicesRepository } from "../auth/devices.repository";
import { CandidateSearchRepository } from "../candidates/candidate-search.repository";
import type { RequestContext } from "../common/request-context";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import type { PushEnqueuer } from "../push/push-enqueuer.service";
import { SearchExitRepository } from "../search-exit/search-exit.repository";
import { SearchExitService } from "../search-exit/search-exit.service";
import { istDayOf } from "../worker-activity/worker-activity";
import { WorkerActivityRepository } from "../worker-activity/worker-activity.repository";
import { WorkerActivityService } from "../worker-activity/worker-activity.service";
import { WorkersRepository } from "../workers/workers.repository";
import { StillLookingRepository } from "./still-looking.repository";
import { StillLookingService } from "./still-looking.service";

/**
 * #2753 item 5 — `still_looking_checks` (migration 0173) against a real Postgres, with
 * STILL_LOOKING_CHECK_ENABLED, SEARCH_EXIT_ENABLED and WORKER_ACTIVITY_ENABLED on.
 *
 * The unit suites prove the service SAYS the right thing. Only a database proves:
 *  - the REAL sweep statement asks exactly the active, consented workers outside the deletion
 *    window, and two sweeps running AT ONCE open ONE check (and one prompted event) per worker —
 *    the open-check unique index is the guard;
 *  - it does not ask again inside STILL_LOOKING_EVERY_DAYS (counted from the answer too) and does
 *    after it, and an ignored open card is not re-opened;
 *  - `not_now` takes him out of the REAL company search (the admin card read of the candidate pool)
 *    and `yes` brings him back, each in the answer's own transaction with its events;
 *  - the answer moves his last active day to today (part B's table), so the mark clears;
 *  - two taps racing from Settings store ONE answer (the per-worker advisory lock);
 *  - erasure: `WorkersRepository.hardDelete` removes his checks (the FK cascade);
 *  - the CHECKs and the partial unique index, and RLS forced with no grant to any client role.
 *
 * Every sweep here is scoped to this file's workers (`onlyWorkerIds`), so a shared database's other
 * workers are never asked. Fixtures carry no real PII: synthetic `enc:` / `hash:` markers and a
 * made-up city.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api exec vitest run still-looking.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

const TAG = randomUUID().slice(0, 8);
const id = () => randomUUID();
const CTX = { correlationId: id(), requestId: `still-looking-db-${TAG}` } as RequestContext;
const DAY_MS = 24 * 60 * 60 * 1000;

const DUE_A = id(); // active, consented, never asked
const DUE_B = id(); // the same; he ignores his card
const RECONSENTED = id(); // an old revoked consent, a newer live one: asked
const PENDING = id(); // never finished sign-up: not asked
const SUSPENDED = id(); // frozen: not asked
const DELETING = id(); // inside the deletion grace window: not asked
const REVOKED = id(); // latest consent revoked: not asked
const NO_CONSENT = id(); // no consent row: not asked
const HIDER = id(); // in the company search pool; answers not_now, then yes
const QUIET = id(); // last active long ago: marked until he answers
const RACER = id(); // two taps at once from Settings
const ERASED = id(); // erased with a check
const CHECKER = id(); // the CHECK fixtures
const WORKERS = [
  DUE_A,
  DUE_B,
  RECONSENTED,
  PENDING,
  SUSPENDED,
  DELETING,
  REVOKED,
  NO_CONSENT,
  HIDER,
  QUIET,
  RACER,
  ERASED,
  CHECKER,
];
const CITY = `Stillpur ${TAG}`;
const TURNER = "mskill_cnc_turner";
const MFG = "ind_industrial_manufacturing";

describe.skipIf(!RUN)(
  "still_looking_checks against Postgres (#2753 item 5, migration 0173)",
  () => {
    let client!: DbClient;
    let config!: ServerConfig;
    let service!: StillLookingService;
    let search!: CandidateSearchRepository;
    const push = { enqueue: vi.fn(async () => undefined) };

    beforeAll(async () => {
      client = createDbClient(DATABASE_URL, { max: 6 });
      config = loadServerConfig({
        NODE_ENV: "test",
        STILL_LOOKING_CHECK_ENABLED: "true",
        STILL_LOOKING_EVERY_DAYS: "30",
        SEARCH_EXIT_ENABLED: "true",
        WORKER_ACTIVITY_ENABLED: "true",
        AVAILABILITY_ANSWERS_V2_ENABLED: "true",
      });
      const events = new EventsService(new EventsRepository(client.db), config);
      service = new StillLookingService(
        new StillLookingRepository(client.db),
        events,
        new SearchExitService(new SearchExitRepository(client.db), events, config),
        new WorkerActivityService(new WorkerActivityRepository(client.db), config),
        new DevicesRepository(client.db),
        push as unknown as PushEnqueuer,
        config,
      );
      search = new CandidateSearchRepository(client.db, config);
      await seed(client);
    }, 60_000);

    afterAll(async () => {
      if (!client) return;
      const { sql } = client;
      try {
        await sql`
        DELETE FROM events
        WHERE event_name IN ('worker.still_looking_prompted', 'worker.still_looking_answered',
                             'worker.search_visibility_changed')
          AND payload->>'worker_id' = ANY(${WORKERS}::text[])`;
        // Checks, exits, activity days, consents and skills all cascade from workers.
        await sql`DELETE FROM workers WHERE id = ANY(${WORKERS}::uuid[])`;
      } finally {
        await sql.end({ timeout: 5 });
      }
    });

    const checks = (workerId: string) =>
      client.sql<
        { id: string; prompted_at: Date; answered_at: Date | null; answer: string | null }[]
      >`
      SELECT id, prompted_at, answered_at, answer FROM still_looking_checks
      WHERE worker_id = ${workerId}::uuid ORDER BY prompted_at, created_at, id`;
    const prompted = (workerId: string) =>
      client.sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM events
      WHERE event_name = 'worker.still_looking_prompted' AND payload->>'worker_id' = ${workerId}`;
    const answeredEvents = (workerId: string) =>
      client.sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM events
      WHERE event_name = 'worker.still_looking_answered' AND payload->>'worker_id' = ${workerId}
      ORDER BY created_at, id`;
    const later = (days: number) => new Date(Date.now() + days * DAY_MS);

    it("the fixture is real: the table exists, nobody has a check, and HIDER is in the search pool", async () => {
      const [reg] = await client.sql<{ t: string | null }[]>`
      SELECT to_regclass('public.still_looking_checks')::text AS t`;
      expect(reg!.t).toBe("still_looking_checks");
      for (const w of WORKERS) expect(await checks(w)).toEqual([]);
      expect(await search.findCardRow(HIDER)).toMatchObject({ workerId: HIDER, currentCity: CITY });
    });

    it("two sweeps AT ONCE: one check and one prompted event per due worker; the ineligible are never asked", async () => {
      const now = new Date();
      const scope = [DUE_A, DUE_B, RECONSENTED, PENDING, SUSPENDED, DELETING, REVOKED, NO_CONSENT];
      const [first, second] = await Promise.all([
        service.sweep(now, scope),
        service.sweep(now, scope),
      ]);
      // Between them the two runs opened exactly the three due workers' checks, never more.
      expect(first.opened + second.opened).toBe(3);
      for (const w of [DUE_A, DUE_B, RECONSENTED]) {
        const rows = await checks(w);
        expect(rows, w).toHaveLength(1);
        expect(rows[0]).toMatchObject({ answered_at: null, answer: null });
        const events = await prompted(w);
        expect(events.map((e) => e.payload)).toEqual([{ worker_id: w, check_id: rows[0]!.id }]);
      }
      for (const w of [PENDING, SUSPENDED, DELETING, REVOKED, NO_CONSENT]) {
        expect(await checks(w), w).toEqual([]);
        expect(await prompted(w), w).toEqual([]);
      }
      // The card: GET says due, with the open check's id.
      const [open] = await checks(DUE_A);
      expect(await service.status(DUE_A)).toMatchObject({ due: true, check_id: open!.id });
      // A third run at the same moment opens nothing: everyone due has an open check.
      expect((await service.sweep(now, scope)).opened).toBe(0);
    });

    it("the window: no new prompt inside STILL_LOOKING_EVERY_DAYS of his answer, a new one after it; an ignored card is not re-opened", async () => {
      // DUE_A answers his card; DUE_B ignores his.
      await service.answer(DUE_A, "yes", CTX);
      const [answered] = await checks(DUE_A);
      expect(answered).toMatchObject({ answer: "yes" });
      expect(answered!.answered_at).not.toBeNull();
      expect(await service.status(DUE_A)).toMatchObject({ due: false, check_id: null });

      // 29 days on: not yet.
      expect((await service.sweep(later(29), [DUE_A, DUE_B])).opened).toBe(0);
      expect(await checks(DUE_A)).toHaveLength(1);
      // 31 days on: asked again (one new open check, one new prompted event). DUE_B's ignored card
      // is still the one card: no second check, no second prompt.
      expect((await service.sweep(later(31), [DUE_A, DUE_B])).opened).toBe(1);
      const rows = await checks(DUE_A);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ answered_at: null, answer: null });
      expect(await prompted(DUE_A)).toHaveLength(2);
      expect(await checks(DUE_B)).toHaveLength(1);
      expect(await prompted(DUE_B)).toHaveLength(1);
    });

    it("a LATE answer to an old card restarts the month: he is not asked again the next day", async () => {
      // RECONSENTED's open card is backdated 40 days (the sweep opened it then; he ignored it).
      await client.sql`
      UPDATE still_looking_checks SET prompted_at = now() - interval '40 days'
      WHERE worker_id = ${RECONSENTED}::uuid`;
      await service.answer(RECONSENTED, "not_now", CTX);
      expect((await service.sweep(later(1), [RECONSENTED])).opened).toBe(0);
      expect((await service.sweep(later(31), [RECONSENTED])).opened).toBe(1);
    });

    it("not_now takes him out of the REAL company search (via monthly_check); yes brings him back", async () => {
      const out = await service.answer(HIDER, "not_now", CTX);
      expect(out).toMatchObject({ due: false, check_id: null });
      const [exit] = await client.sql<{ via: string }[]>`
      SELECT via FROM worker_search_exits WHERE worker_id = ${HIDER}::uuid`;
      expect(exit!.via).toBe("monthly_check");
      expect(await search.findCardRow(HIDER)).toBeNull();

      await service.answer(HIDER, "yes", CTX);
      expect(
        await client.sql`SELECT 1 FROM worker_search_exits WHERE worker_id = ${HIDER}::uuid`,
      ).toHaveLength(0);
      expect(await search.findCardRow(HIDER)).toMatchObject({ workerId: HIDER });

      // Each answer opened and answered its own row (no card was open: he answered from Settings),
      // one answered event each, and one visibility change each way, all via monthly_check.
      expect((await checks(HIDER)).map((r) => r.answer)).toEqual(["not_now", "yes"]);
      expect((await answeredEvents(HIDER)).map((e) => e.payload.answer)).toEqual([
        "not_now",
        "yes",
      ]);
      const changes = await client.sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM events
      WHERE event_name = 'worker.search_visibility_changed' AND payload->>'worker_id' = ${HIDER}
      ORDER BY created_at, id`;
      expect(changes.map((c) => c.payload)).toEqual([
        { worker_id: HIDER, visible: false, via: "monthly_check" },
        { worker_id: HIDER, visible: true, via: "monthly_check" },
      ]);

      // The repeat: yes again writes no row and no event, and answers the same body.
      const before = await service.status(HIDER);
      const again = await service.answer(HIDER, "yes", CTX);
      expect(again).toMatchObject({ due: before.due, check_id: before.check_id });
      expect(await checks(HIDER)).toHaveLength(2);
      expect(await answeredEvents(HIDER)).toHaveLength(2);
    });

    it("yes also brings back a worker who left search with his own switch", async () => {
      await client.sql`
      INSERT INTO worker_search_exits (worker_id, via) VALUES (${HIDER}::uuid, 'worker')`;
      expect(await search.findCardRow(HIDER)).toBeNull();
      // His latest answer is already yes: the answer is a repeat, the search effect still applies.
      await service.answer(HIDER, "yes", CTX);
      expect(await search.findCardRow(HIDER)).toMatchObject({ workerId: HIDER });
    });

    it("the answer moves his last active day to today, so the mark clears", async () => {
      expect(await service.status(QUIET)).toMatchObject({
        last_active_on: "2026-01-02",
        not_recently_active: true,
      });
      const out = await service.answer(QUIET, "yes", CTX);
      const today = istDayOf(new Date());
      expect(out).toMatchObject({ last_active_on: today, not_recently_active: false });
      // The touch is fire-and-forget (part B's contract); wait for the row, then read it back.
      for (let i = 0; i < 50; i += 1) {
        const rows = await client.sql`
        SELECT 1 FROM worker_activity WHERE worker_id = ${QUIET}::uuid AND active_on = ${today}::date`;
        if (rows.length > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(await service.status(QUIET)).toMatchObject({
        last_active_on: today,
        not_recently_active: false,
      });
    });

    it("availability_needs_answer reads his own stored answer", async () => {
      // QUIET has none: asked.
      expect((await service.status(QUIET)).availability_needs_answer).toBe(true);
      const set = (status: string) => client.sql`
      INSERT INTO worker_attributes (worker_id, attribute_key, value_kind, value_json, source)
      VALUES (${QUIET}::uuid, 'availability', 'json', ${JSON.stringify({ status })}::jsonb, 'answer_map')
      ON CONFLICT (worker_id, attribute_key) DO UPDATE SET value_json = EXCLUDED.value_json`;
      await set("within_week"); // an old key, the four on: asked again
      expect((await service.status(QUIET)).availability_needs_answer).toBe(true);
      await set("in_15_days"); // one of the four: not asked
      expect((await service.status(QUIET)).availability_needs_answer).toBe(false);
    });

    it("two taps at once from Settings store ONE answer (the per-worker lock)", async () => {
      const [a, b] = await Promise.all([
        service.answer(RACER, "hired", CTX),
        service.answer(RACER, "hired", CTX),
      ]);
      expect(a).toEqual(b);
      expect((await checks(RACER)).map((r) => r.answer)).toEqual(["hired"]);
      expect(await answeredEvents(RACER)).toHaveLength(1);
      // hired is stored only: no exit, and no hire record (it names no company or posting).
      expect(
        await client.sql`SELECT 1 FROM worker_search_exits WHERE worker_id = ${RACER}::uuid`,
      ).toHaveLength(0);
      expect(await client.sql`SELECT 1 FROM hires WHERE worker_id = ${RACER}::uuid`).toHaveLength(
        0,
      );
    });

    it("erasure: hardDelete removes his checks (ON DELETE CASCADE)", async () => {
      await service.answer(ERASED, "yes", CTX);
      await service.sweep(later(31), [ERASED]);
      expect(await checks(ERASED)).toHaveLength(2);
      expect(await new WorkersRepository(client.db).hardDelete(ERASED)).toBe(true);
      expect(await checks(ERASED)).toEqual([]);
    });

    it("the CHECKs and the open-check unique index", async () => {
      const insert = (answer: string | null, answeredAt: string | null) =>
        client.sql`
        INSERT INTO still_looking_checks (worker_id, prompted_at, answered_at, answer)
        VALUES (${CHECKER}::uuid, now(), ${answeredAt}::timestamptz, ${answer})`.catch(
          (e: unknown) => e,
        );
      const code = (r: unknown) => (r as { code?: string }).code;
      // An answer outside the set.
      expect(code(await insert("no", new Date().toISOString()))).toBe("23514");
      expect(code(await insert("Yes", new Date().toISOString()))).toBe("23514");
      // An answer without its time, and a time without an answer.
      expect(code(await insert("yes", null))).toBe("23514");
      expect(code(await insert(null, new Date().toISOString()))).toBe("23514");
      // One open check is fine; a second is refused; answered ones are not limited.
      expect(code(await insert(null, null))).toBeUndefined();
      expect(code(await insert(null, null))).toBe("23505");
      expect(code(await insert("yes", new Date().toISOString()))).toBeUndefined();
      expect(code(await insert("not_now", new Date().toISOString()))).toBeUndefined();
      // The FK: a worker that does not exist.
      const orphan = await client.sql`
      INSERT INTO still_looking_checks (worker_id, prompted_at) VALUES (${id()}::uuid, now())`.catch(
        (e: unknown) => e,
      );
      expect(code(orphan)).toBe("23503");
    });

    it("RLS is ENABLED and FORCED, with no policy, and no client role holds any privilege", async () => {
      const [rls] = await client.sql<{ enabled: boolean; forced: boolean }[]>`
      SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
        FROM pg_class WHERE oid = 'public.still_looking_checks'::regclass`;
      expect(rls).toEqual({ enabled: true, forced: true });
      const [policies] = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'still_looking_checks'`;
      expect(policies!.n).toBe(0);
      const [publicGrants] = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.role_table_grants
      WHERE table_name = 'still_looking_checks' AND grantee = 'PUBLIC'`;
      expect(publicGrants!.n).toBe(0);
      const roles = await client.sql<{ rolname: string }[]>`
      SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')`;
      expect(roles.map((r) => r.rolname).sort()).toEqual(["anon", "authenticated", "service_role"]);
      for (const { rolname } of roles) {
        for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
          const [row] = await client.db.execute<{ has: boolean }>(
            dsql`SELECT has_table_privilege(${rolname}, 'public.still_looking_checks', ${priv}) AS has`,
          );
          expect(row!.has, `${rolname} ${priv}`).toBe(false);
        }
      }
    });

    async function seed(c: DbClient): Promise<void> {
      const { sql } = c;
      await sql`
      INSERT INTO skill (skill_id, label_en, domain_id, source, status, kind, industry_id)
      VALUES (${TURNER}, 'CNC Turner', 'cnc-machining', 'rvm', 'active', 'match_skill', ${MFG})
      ON CONFLICT (skill_id) DO NOTHING`;
      const status: Record<string, string> = { [PENDING]: "pending", [SUSPENDED]: "suspended" };
      for (const [i, w] of WORKERS.entries()) {
        await sql`
        INSERT INTO workers (id, phone_e164, phone_hash, status, current_city, deletion_scheduled_at)
        VALUES (${w}::uuid, ${`enc:still-${TAG}-w${i}`}, ${`hash:still-${TAG}-w${i}`},
                ${status[w] ?? "active"}, ${w === HIDER ? CITY : null},
                ${w === DELETING ? new Date(Date.now() + 7 * DAY_MS).toISOString() : null}::timestamptz)`;
        if (w === NO_CONSENT) continue;
        if (w === RECONSENTED) {
          await sql`
          INSERT INTO worker_consents (worker_id, consent_version, purposes, accepted_at, revoked_at)
          VALUES (${w}::uuid, 'test', ${JSON.stringify(["profiling"])}::jsonb,
                  now() - interval '10 days', now() - interval '9 days')`;
        }
        await sql`
        INSERT INTO worker_consents (worker_id, consent_version, purposes, accepted_at, revoked_at)
        VALUES (${w}::uuid, 'test', ${JSON.stringify(["profiling", "employer_sharing"])}::jsonb,
                now() - interval '1 day', ${w === REVOKED ? new Date().toISOString() : null}::timestamptz)`;
      }
      // HIDER is in the company search pool (consented for employer sharing, wants a skill).
      await sql`
      INSERT INTO worker_skill (worker_id, skill_id, industry_id, months_bucketed, wants, source)
      VALUES (${HIDER}::uuid, ${TURNER}, ${MFG}, 24, true, 'ops')`;
      // QUIET was last active on 2 January: well past the 90-day mark.
      await sql`
      INSERT INTO worker_activity (worker_id, active_on) VALUES (${QUIET}::uuid, '2026-01-02')`;
    }
  },
);
