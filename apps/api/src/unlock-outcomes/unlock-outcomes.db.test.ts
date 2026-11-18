import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { loadServerConfig } from "@badabhai/config";
import { createDbClient, type Database, type DbClient } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { HiresRepository } from "../hires/hires.repository";
import { HiresService } from "../hires/hires.service";
import { resolverOver } from "../payers/payer-tenant-scope.test-support";
import { WorkersRepository } from "../workers/workers.repository";
import {
  decodeDueCursor,
  type DueUnlocksPageDto,
  type DueUnlocksQueryDto,
} from "./unlock-outcomes.dto";
import { UnlockOutcomesRepository } from "./unlock-outcomes.repository";
import { UnlockOutcomesService, type OutcomeOrigin } from "./unlock-outcomes.service";

/**
 * #2753 item 10 — `unlock_outcomes` (migration 0172) against a real Postgres, with
 * UNLOCK_FOLLOWUP_ENABLED and HIRE_RECORDS_ENABLED on.
 *
 * The unit suites prove the rules and the plumbing. Only a database proves:
 *  - THE DUE LIST over REAL unlock rows: granted at least 7 days ago (the boundary instant counts),
 *    no answer or a `still_talking` that old; never an answered contact, a request or a denial, an
 *    erased, pending-deletion or suspended worker, or another company's unlock; oldest first,
 *    paged by a microsecond keyset (two grants inside one millisecond are neither skipped nor
 *    repeated at a page boundary);
 *  - THE UPSERT: one row per unlock keyed to the unlock's own tenant, replaced by a later answer,
 *    a repeat writing nothing, a repeated `still_talking` moving `answered_at`; the event beside
 *    each real change; the ownership predicate (another company's unlock, a denial and an erased
 *    worker are the 404);
 *  - THE HIRES LINK: a `hired` answer confirms the company's hire record (company posting or agency
 *    job) in the same transaction; an unlock with no posting stores the answer only;
 *  - the desk's `not_reached` on the desk's transaction, and a rollback taking it with it;
 *  - the CHECKs (23514), the primary key (23505), both foreign keys (23503);
 *  - erasure: `WorkersRepository.hardDelete` cascades to his answers (the unlock survives with its
 *    worker_id nulled), and deleting an unlock deletes its answer;
 *  - RLS enabled and FORCED, no policy, no grant to PUBLIC or a client role.
 *
 * Fixtures carry no PII: synthetic `enc:` / `hash:` markers, ids fresh per run, all deleted after.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api exec vitest run unlock-outcomes.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

const TAG = randomUUID().slice(0, 8);
const id = () => randomUUID();
const DAY = 24 * 60 * 60 * 1000;
/** The clock every service call here is given (milliseconds only, so the boundary is exact). */
const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
const ago = (days: number, extraMs = 0) => new Date(NOW.getTime() - days * DAY + extraMs);

const PAYER_A = id(); // the company
const PAYER_B = id(); // another company
const OPS = id();
const POST_A = id(); // company posting, A
const JOB_A = id(); // agency job, A

/** One worker per unlock: `unlocks_payer_worker_uq` allows one unlock per company and worker. */
const W = Object.fromEntries(
  [
    "fresh",
    "boundary",
    "justUnder",
    "old",
    "answered",
    "talking",
    "talkingFresh",
    "revealed",
    "expired",
    "denied",
    "frozen",
    "suspended",
    "tieA",
    "tieB",
    "otherCo",
    "writes",
    "agency",
    "bare",
    "desk",
    "rolled",
    "rules",
    "erased",
    "dropped",
  ].map((k) => [k, id()]),
) as Record<string, string>;
const WORKERS = Object.values(W);
/** The unlock of each worker (A's, except `otherCo`'s), plus the one whose worker was erased. */
const UL = Object.fromEntries(Object.keys(W).map((k) => [k, id()])) as Record<string, string>;
const UL_ERASED_BEFORE = id(); // an unlock whose worker is already gone (worker_id NULL)
const UNLOCK_IDS = [...Object.values(UL), UL_ERASED_BEFORE];

describe.skipIf(!RUN)("unlock_outcomes against Postgres (#2753 item 10, migration 0172)", () => {
  let client!: DbClient;
  let outcomes!: UnlockOutcomesService;
  const correlations: string[] = [];

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 4 });
    const events = new EventsService(new EventsRepository(client.db), {
      NODE_ENV: "test",
    } as never);
    const hires = new HiresService(new HiresRepository(client.db), events, {
      HIRE_RECORDS_ENABLED: true,
    });
    outcomes = new UnlockOutcomesService(
      new UnlockOutcomesRepository(client.db),
      events,
      hires,
      resolverOver(loadServerConfig({ NODE_ENV: "test" })),
      { UNLOCK_FOLLOWUP_ENABLED: true, UNLOCK_FOLLOWUP_AFTER_DAYS: 7 },
    );
    await seed(client);
  }, 60_000);

  afterAll(async () => {
    if (!client) return;
    const { sql } = client;
    await sql`DELETE FROM unlock_outcomes WHERE unlock_id = ANY(${UNLOCK_IDS}::uuid[])`;
    await sql`DELETE FROM hires WHERE worker_id = ANY(${WORKERS}::uuid[])`;
    if (correlations.length > 0) {
      await sql`DELETE FROM events WHERE correlation_id = ANY(${correlations}::uuid[])`;
    }
    await sql`DELETE FROM unlocks WHERE id = ANY(${UNLOCK_IDS}::uuid[])`;
    await sql`DELETE FROM workers WHERE id = ANY(${WORKERS}::uuid[])`;
    await sql`DELETE FROM job_postings WHERE id = ${POST_A}::uuid`;
    await sql`DELETE FROM jobs WHERE id = ${JOB_A}::uuid`;
    await sql`DELETE FROM payers WHERE id = ANY(${[PAYER_A, PAYER_B]}::uuid[])`;
    await sql.end({ timeout: 5 });
  });

  const ctx = (): RequestContext => {
    const c = { correlationId: randomUUID(), requestId: `unlock-outcomes-db-${TAG}` };
    correlations.push(c.correlationId);
    return c;
  };

  /** The company's answer through the REAL service, with a tracked correlation id. */
  async function answer(
    unlockId: string,
    outcome: "hired" | "not_hired" | "still_talking",
    at: Date = NOW,
    payerId = PAYER_A,
  ) {
    const c = ctx();
    return { out: await outcomes.recordCompanyOutcome(payerId, unlockId, outcome, c, at), c };
  }

  async function rowOf(unlockId: string) {
    const rows = await client.sql<
      {
        tenant_payer_id: string;
        worker_id: string;
        outcome: string;
        answered_by: string;
        answered_at_ms: string;
        updated_at_ms: string;
      }[]
    >`
      SELECT tenant_payer_id, worker_id, outcome, answered_by,
             (extract(epoch FROM answered_at) * 1000)::bigint::text AS answered_at_ms,
             (extract(epoch FROM updated_at) * 1000)::bigint::text AS updated_at_ms
      FROM unlock_outcomes WHERE unlock_id = ${unlockId}::uuid`;
    return rows[0] ?? null;
  }

  async function eventsFor(correlationId: string) {
    return client.sql<
      {
        event_name: string;
        actor_type: string;
        actor_id: string;
        subject_type: string;
        subject_id: string;
        payload: Record<string, unknown>;
      }[]
    >`
      SELECT event_name, actor_type, actor_id, subject_type, subject_id, payload
      FROM events WHERE correlation_id = ${correlationId}::uuid ORDER BY occurred_at, event_name`;
  }

  async function hiresOf(workerId: string) {
    return client.sql<
      {
        tenant_payer_id: string;
        posting_kind: string;
        posting_id: string;
        status: string;
        company_answered_at: string | null;
        company_marked_at: string | null;
      }[]
    >`
      SELECT tenant_payer_id, posting_kind, posting_id, status, company_answered_at, company_marked_at
      FROM hires WHERE worker_id = ${workerId}::uuid`;
  }

  async function due(query: Partial<DueUnlocksQueryDto> = {}, payerId = PAYER_A) {
    return outcomes.listDue(payerId, { limit: 50, ...query } as DueUnlocksQueryDto, NOW);
  }

  /** Every page of the due list, walked with the cursor. */
  async function walk(limit: number): Promise<{ pages: DueUnlocksPageDto[]; ids: string[] }> {
    const pages: DueUnlocksPageDto[] = [];
    let cursor: DueUnlocksQueryDto["cursor"];
    for (let i = 0; i < 20; i += 1) {
      const page = await due({ limit, cursor });
      pages.push(page);
      if (page.nextCursor === null) break;
      cursor = decodeDueCursor(page.nextCursor) ?? undefined;
    }
    return { pages, ids: pages.flatMap((p) => p.items.map((i) => i.unlock_id)) };
  }

  it("the fixture is real: the table exists and holds nothing for these unlocks", async () => {
    const [reg] = await client.sql<{ t: string | null }[]>`
      SELECT to_regclass('public.unlock_outcomes')::text AS t`;
    expect(reg!.t).toBe("unlock_outcomes");
    const [n] = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM unlock_outcomes WHERE unlock_id = ANY(${UNLOCK_IDS}::uuid[])`;
    expect(n!.n).toBe(0);
  });

  describe("the due list, over real unlock rows", () => {
    beforeAll(async () => {
      // Answers given in the past, through the real service: one closed, two still talking.
      await answer(UL.answered!, "hired", ago(9));
      await answer(UL.talking!, "still_talking", ago(8));
      await answer(UL.talkingFresh!, "still_talking", ago(2));
    });

    it("lists exactly the due contacts, oldest grant first, ids only", async () => {
      const page = await due();
      expect(page.nextCursor).toBeNull();
      expect(page.items.map((i) => i.unlock_id)).toEqual([
        UL.expired, // 30 days, lapsed but opened
        UL.talking, // 20 days, still_talking answered 8 days ago
        UL.tieA, // 15 days (and a few microseconds)
        UL.tieB,
        UL.old, // 10 days, no answer
        UL.revealed, // 9 days
        UL.boundary, // exactly 7 days: the boundary counts
      ]);
      const talking = page.items.find((i) => i.unlock_id === UL.talking)!;
      expect(talking).toEqual({
        unlock_id: UL.talking,
        worker_id: W.talking,
        granted_at: ago(20).toISOString(),
        outcome: "still_talking",
      });
      expect(page.items.find((i) => i.unlock_id === UL.old)!.outcome).toBeNull();
      for (const item of page.items) {
        expect(Object.keys(item).sort()).toEqual([
          "granted_at",
          "outcome",
          "unlock_id",
          "worker_id",
        ]);
      }
    });

    it("never: too fresh (a second under 7 days), answered, a recent still_talking, a denial, frozen, erased, another company's", async () => {
      const ids = (await due()).items.map((i) => i.unlock_id);
      for (const k of [
        "fresh",
        "justUnder",
        "answered",
        "talkingFresh",
        "denied",
        "frozen",
        "suspended",
        "otherCo",
      ]) {
        expect(ids, k).not.toContain(UL[k]);
      }
      expect(ids).not.toContain(UL_ERASED_BEFORE);
    });

    it("another company sees only its own", async () => {
      const page = await due({}, PAYER_B);
      expect(page.items.map((i) => i.unlock_id)).toEqual([UL.otherCo]);
    });

    it("the setting moves the boundary: at 10 days only the older ones are due", async () => {
      const ten = new UnlockOutcomesService(
        new UnlockOutcomesRepository(client.db),
        { emit: async () => undefined } as never,
        { enabled: false } as never,
        resolverOver(loadServerConfig({ NODE_ENV: "test" })),
        { UNLOCK_FOLLOWUP_ENABLED: true, UNLOCK_FOLLOWUP_AFTER_DAYS: 10 },
      );
      const page = await ten.listDue(PAYER_A, { limit: 50 } as DueUnlocksQueryDto, NOW);
      // still_talking answered 8 days ago is not 10 days old, so `talking` drops out too.
      expect(page.items.map((i) => i.unlock_id)).toEqual([UL.expired, UL.tieA, UL.tieB, UL.old]);
    });

    it("pages by a microsecond keyset: two grants in one millisecond, neither skipped nor repeated", async () => {
      for (const limit of [1, 2, 3, 4]) {
        const { pages, ids } = await walk(limit);
        expect(ids, `limit ${limit}`).toEqual((await due()).items.map((i) => i.unlock_id));
        expect(new Set(ids).size).toBe(ids.length);
        expect(pages.at(-1)!.nextCursor).toBeNull();
      }
    });

    it("an answer takes a contact off the list; still_talking brings it back after the wait", async () => {
      await answer(UL.old!, "still_talking", NOW);
      expect((await due()).items.map((i) => i.unlock_id)).not.toContain(UL.old);
      const later = await outcomes.listDue(
        PAYER_A,
        { limit: 50 } as DueUnlocksQueryDto,
        new Date(NOW.getTime() + 7 * DAY),
      );
      expect(later.items.find((i) => i.unlock_id === UL.old)).toMatchObject({
        outcome: "still_talking",
      });
    });
  });

  describe("the upsert: one row per unlock, the event beside each real change", () => {
    it("the first answer writes one row keyed to the unlock's own tenant, with its event", async () => {
      const { out, c } = await answer(UL.writes!, "still_talking", ago(1));
      expect(out).toEqual({
        unlock_id: UL.writes,
        worker_id: W.writes,
        outcome: "still_talking",
        previous_outcome: null,
        answered_at: ago(1).toISOString(),
        changed: true,
      });
      expect(await rowOf(UL.writes!)).toEqual({
        tenant_payer_id: PAYER_A,
        worker_id: W.writes,
        outcome: "still_talking",
        answered_by: "company",
        answered_at_ms: String(ago(1).getTime()),
        updated_at_ms: String(ago(1).getTime()),
      });
      expect(await eventsFor(c.correlationId)).toEqual([
        {
          event_name: "unlock.outcome_recorded",
          actor_type: "payer",
          actor_id: PAYER_A,
          subject_type: "unlock",
          subject_id: UL.writes,
          payload: {
            unlock_id: UL.writes,
            worker_id: W.writes,
            outcome: "still_talking",
            answered_by: "company",
          },
        },
      ]);
    });

    it("a repeated still_talking moves answered_at and writes no event", async () => {
      const { out, c } = await answer(UL.writes!, "still_talking", NOW);
      expect(out).toMatchObject({ changed: false, answered_at: NOW.toISOString() });
      expect((await rowOf(UL.writes!))!.answered_at_ms).toBe(String(NOW.getTime()));
      expect(await eventsFor(c.correlationId)).toEqual([]);
    });

    it("a later answer REPLACES it (still_talking → not_hired): still one row", async () => {
      const at = new Date(NOW.getTime() + 1000);
      const { out, c } = await answer(UL.writes!, "not_hired", at);
      expect(out).toMatchObject({ previous_outcome: "still_talking", changed: true });
      const [n] = await client.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM unlock_outcomes WHERE unlock_id = ${UL.writes!}::uuid`;
      expect(n!.n).toBe(1);
      expect(await rowOf(UL.writes!)).toMatchObject({ outcome: "not_hired" });
      expect((await eventsFor(c.correlationId)).map((e) => e.payload.outcome)).toEqual([
        "not_hired",
      ]);
    });

    it("a repeat of a closing answer writes nothing: answered_at and updated_at stay", async () => {
      const before = await rowOf(UL.writes!);
      const { out, c } = await answer(UL.writes!, "not_hired", new Date(NOW.getTime() + 5000));
      expect(out.changed).toBe(false);
      expect(await rowOf(UL.writes!)).toEqual(before);
      expect(await eventsFor(c.correlationId)).toEqual([]);
    });

    it("ownership: another company's unlock, a denial, an erased worker and an unknown id are the 404", async () => {
      for (const unlockId of [UL.otherCo!, UL.denied!, UL_ERASED_BEFORE, id()]) {
        await expect(answer(unlockId, "hired")).rejects.toBeInstanceOf(NotFoundException);
        expect(await rowOf(unlockId)).toBeNull();
      }
      // The owner can.
      const owner = await answer(UL.otherCo!, "not_hired", NOW, PAYER_B);
      expect(owner.out).toMatchObject({ changed: true, previous_outcome: null });
      expect(await rowOf(UL.otherCo!)).toMatchObject({ tenant_payer_id: PAYER_B });
    });
  });

  describe("the hires link (#2753 item 9)", () => {
    it("`hired` on a company-posting unlock confirms the hire record in the same transaction", async () => {
      const { c } = await answer(UL.writes!, "hired", new Date(NOW.getTime() + 9000));
      const [hire, ...rest] = await hiresOf(W.writes!);
      expect(rest).toEqual([]);
      expect(hire).toMatchObject({
        tenant_payer_id: PAYER_A,
        posting_kind: "company_posting",
        posting_id: POST_A,
        status: "confirmed",
        company_marked_at: null,
      });
      expect(hire!.company_answered_at).not.toBeNull();
      const events = await eventsFor(c.correlationId);
      expect(events.map((e) => e.event_name).sort()).toEqual([
        "hire.recorded",
        "unlock.outcome_recorded",
      ]);
      expect(events.find((e) => e.event_name === "hire.recorded")!.payload).toMatchObject({
        status: "confirmed",
        source: "company_answer",
        posting_kind: "company_posting",
        posting_id: POST_A,
      });
    });

    it("an agency-job unlock confirms an agency_job record", async () => {
      await answer(UL.agency!, "hired");
      expect(await hiresOf(W.agency!)).toEqual([
        expect.objectContaining({
          tenant_payer_id: PAYER_A,
          posting_kind: "agency_job",
          posting_id: JOB_A,
          status: "confirmed",
        }),
      ]);
    });

    it("an unlock with no posting stores the answer and writes no hire record", async () => {
      const { c } = await answer(UL.bare!, "hired");
      expect(await rowOf(UL.bare!)).toMatchObject({ outcome: "hired" });
      expect(await hiresOf(W.bare!)).toEqual([]);
      expect((await eventsFor(c.correlationId)).map((e) => e.event_name)).toEqual([
        "unlock.outcome_recorded",
      ]);
    });
  });

  describe("the desk's not_reached (#2750)", () => {
    const byDesk = (): OutcomeOrigin => {
      const correlationId = randomUUID();
      correlations.push(correlationId);
      return { actor: { actor_type: "admin", actor_id: OPS }, correlationId };
    };

    it("stores not_reached answered by the desk, on the desk's transaction, with its event", async () => {
      const by = byDesk();
      const out = await client.db.transaction((tx) =>
        outcomes.recordDeskOutcome(UL.desk!, "not_reached", tx as unknown as Database, by, NOW),
      );
      expect(out).toMatchObject({ outcome: "not_reached", changed: true, previousOutcome: null });
      expect(await rowOf(UL.desk!)).toMatchObject({
        tenant_payer_id: PAYER_A,
        outcome: "not_reached",
        answered_by: "desk",
      });
      const [e] = await eventsFor(by.correlationId);
      expect(e).toMatchObject({
        event_name: "unlock.outcome_recorded",
        actor_type: "admin",
        actor_id: OPS,
        payload: { outcome: "not_reached", answered_by: "desk" },
      });
    });

    it("a desk transaction that rolls back takes the answer and its event with it", async () => {
      const by = byDesk();
      const boom = new Error("t2753: roll it back");
      await expect(
        client.db.transaction(async (tx) => {
          await outcomes.recordDeskOutcome(
            UL.rolled!,
            "not_reached",
            tx as unknown as Database,
            by,
            NOW,
          );
          throw boom;
        }),
      ).rejects.toBe(boom);
      expect(await rowOf(UL.rolled!)).toBeNull();
      expect(await eventsFor(by.correlationId)).toEqual([]);
    });
  });

  describe("the table's own rules", () => {
    /** A raw insert, for the constraint cases; the SQLSTATE it fails with, or "ok". */
    async function insert(over: Record<string, string>): Promise<string> {
      const v = {
        unlock: UL.rules!,
        tenant: PAYER_A,
        worker: W.rules!,
        outcome: "hired",
        by: "company",
        ...over,
      };
      try {
        await client.sql`
          INSERT INTO unlock_outcomes (unlock_id, tenant_payer_id, worker_id, outcome, answered_by,
                                       answered_at)
          VALUES (${v.unlock}::uuid, ${v.tenant}::uuid, ${v.worker}::uuid, ${v.outcome}, ${v.by},
                  now())`;
        return "ok";
      } catch (err) {
        return (err as { code?: string }).code ?? String(err);
      }
    }

    it("the CHECKs refuse an unknown outcome or answerer (23514)", async () => {
      expect(await insert({ outcome: "maybe" })).toBe("23514");
      expect(await insert({ outcome: "Hired" })).toBe("23514");
      expect(await insert({ by: "worker" })).toBe("23514");
    });

    it("one row per unlock: a second is 23505", async () => {
      expect(await insert({})).toBe("ok");
      expect(await insert({ outcome: "not_hired" })).toBe("23505");
    });

    it("both foreign keys hold: an unknown unlock or worker is 23503", async () => {
      expect(await insert({ unlock: id() })).toBe("23503");
      expect(await insert({ unlock: UL.dropped!, worker: id() })).toBe("23503");
    });

    it("RLS is ENABLED and FORCED, with no policy and no grant to PUBLIC or a client role", async () => {
      const [rls] = await client.sql<{ enabled: boolean; forced: boolean }[]>`
        SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
          FROM pg_class WHERE oid = 'public.unlock_outcomes'::regclass`;
      expect(rls).toEqual({ enabled: true, forced: true });
      const [policies] = await client.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'unlock_outcomes'`;
      expect(policies!.n).toBe(0);
      const [grants] = await client.sql<{ n: number }[]>`
        SELECT count(*)::int AS n
          FROM pg_class c, aclexplode(c.relacl) a
         WHERE c.oid = 'public.unlock_outcomes'::regclass
           AND (a.grantee = 0
                OR a.grantee IN (SELECT oid FROM pg_roles
                                  WHERE rolname IN ('anon', 'authenticated', 'service_role')))`;
      expect(grants!.n).toBe(0);
    });
  });

  describe("erasure and the unlock's own deletion", () => {
    it("WorkersRepository.hardDelete removes his answer (CASCADE); the paid unlock survives, worker_id nulled", async () => {
      await answer(UL.erased!, "not_hired");
      expect(await rowOf(UL.erased!)).not.toBeNull();
      await expect(new WorkersRepository(client.db).hardDelete(W.erased!)).resolves.toBe(true);
      expect(await rowOf(UL.erased!)).toBeNull();
      const [u] = await client.sql<{ worker_id: string | null }[]>`
        SELECT worker_id FROM unlocks WHERE id = ${UL.erased!}::uuid`;
      expect(u).toEqual({ worker_id: null });
      // And the erased worker's unlock is now a 404 for an answer, and off the due list.
      await expect(answer(UL.erased!, "hired")).rejects.toBeInstanceOf(NotFoundException);
    });

    it("deleting an unlock deletes its answer (CASCADE)", async () => {
      await answer(UL.dropped!, "still_talking");
      expect(await rowOf(UL.dropped!)).not.toBeNull();
      await client.sql`DELETE FROM unlocks WHERE id = ${UL.dropped!}::uuid`;
      expect(await rowOf(UL.dropped!)).toBeNull();
    });
  });

  async function seed(c: DbClient): Promise<void> {
    const { sql } = c;
    for (const [i, p] of [PAYER_A, PAYER_B].entries()) {
      await sql`
        INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status)
        VALUES (${p}::uuid, 'employer', ${`enc:uo-${TAG}-${i}`}, ${`hash:uo-${TAG}-${i}`},
                ${`enc:uo-org-${TAG}-${i}`}, 'active')`;
    }
    await sql`
      INSERT INTO job_postings (id, created_by, payer_id, org_label, role_title, vacancy_band, status,
                                match_skill_ids, reach_skill_ids, published_at)
      VALUES (${POST_A}::uuid, ${OPS}::uuid, ${PAYER_A}::uuid, 'Outcomes Fixture',
              ${`Outcomes posting ${TAG}`}, '1', 'open', '["mskill_vmc_operator"]'::jsonb,
              '["mskill_vmc_operator"]'::jsonb, now())`;
    await sql`
      INSERT INTO jobs (id, trade_key, title, city, status, payer_id, min_experience_years, pay_min, pay_max)
      VALUES (${JOB_A}::uuid, 'cnc_vmc', ${`Outcomes job ${TAG}`}, 'pune', 'open', ${PAYER_A}::uuid,
              1, 18000, 30000)`;
    for (const [k, workerId] of Object.entries(W)) {
      await sql`
        INSERT INTO workers (id, phone_e164, phone_hash, status, deletion_scheduled_at)
        VALUES (${workerId}::uuid, ${`enc:uo-${TAG}-${k}`}, ${`hash:uo-${TAG}-${k}`},
                ${k === "suspended" ? "suspended" : "active"},
                ${k === "frozen" ? new Date(NOW.getTime() + 7 * DAY).toISOString() : null}::timestamptz)`;
    }

    /**
     * One unlock: [worker key, status, granted days ago (null = never), context]. The write, desk,
     * rules and erasure fixtures are 3 days old, so none of them is on the due list it pins.
     */
    const unlockRows: [string, string, number | null, "posting" | "job" | null][] = [
      ["fresh", "granted", 2, null],
      ["boundary", "granted", 7, null],
      ["justUnder", "granted", 7 - 1 / 86_400, null], // one second under 7 days
      ["old", "granted", 10, null],
      ["answered", "granted", 11, null],
      ["talking", "granted", 20, null],
      ["talkingFresh", "granted", 21, null],
      ["revealed", "revealed", 9, null],
      ["expired", "expired", 30, null],
      ["denied", "denied", null, null],
      ["frozen", "granted", 12, null],
      ["suspended", "granted", 13, null],
      ["otherCo", "granted", 10, null],
      ["writes", "granted", 3, "posting"],
      ["agency", "granted", 3, "job"],
      ["bare", "revealed", 3, null],
      ["desk", "granted", 3, null],
      ["rolled", "granted", 3, null],
      ["rules", "granted", 3, null],
      ["erased", "granted", 3, null],
      ["dropped", "granted", 3, null],
    ];
    for (const [k, status, days, context] of unlockRows) {
      const grantedAt = days === null ? null : ago(days).toISOString();
      await sql`
        INSERT INTO unlocks (id, payer_id, worker_id, job_id, job_posting_id, status, granted_at,
                             expires_at)
        VALUES (${UL[k]!}::uuid, ${k === "otherCo" ? PAYER_B : PAYER_A}::uuid, ${W[k]!}::uuid,
                ${context === "job" ? JOB_A : null}::uuid,
                ${context === "posting" ? POST_A : null}::uuid, ${status},
                ${grantedAt}::timestamptz,
                ${grantedAt === null ? null : new Date(ago(days!).getTime() + 14 * DAY).toISOString()}::timestamptz)`;
    }
    // Two grants inside ONE millisecond, 15 days ago: a millisecond cursor would lose one.
    const base = ago(15).toISOString();
    for (const [k, micros] of [
      ["tieA", 100],
      ["tieB", 200],
    ] as const) {
      await sql`
        INSERT INTO unlocks (id, payer_id, worker_id, status, granted_at)
        VALUES (${UL[k]!}::uuid, ${PAYER_A}::uuid, ${W[k]!}::uuid, 'granted',
                ${base}::timestamptz + ${`${micros} microseconds`}::interval)`;
    }
    // An unlock whose worker was erased before this run: worker_id NULL (ADR-0026 SET NULL).
    await sql`
      INSERT INTO unlocks (id, payer_id, worker_id, status, granted_at)
      VALUES (${UL_ERASED_BEFORE}::uuid, ${PAYER_A}::uuid, NULL, 'granted',
              ${ago(10).toISOString()}::timestamptz)`;
  }
});
