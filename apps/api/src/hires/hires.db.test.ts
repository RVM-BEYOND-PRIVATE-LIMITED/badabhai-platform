import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadServerConfig } from "@badabhai/config";
import { createDbClient, type Database, type DbClient } from "@badabhai/db";
import type { ApplicantStage } from "@badabhai/types";
import type { RequestContext } from "../common/request-context";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { PayerApplicantStagesRepository } from "../payer-portal/payer-applicant-stages.repository";
import { PayerApplicantStagesService } from "../payer-portal/payer-applicant-stages.service";
import { resolverOver } from "../payers/payer-tenant-scope.test-support";
import type { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import { WorkersRepository } from "../workers/workers.repository";
import { HiresRepository, type HireKey } from "./hires.repository";
import { HiresService, type HireOrigin } from "./hires.service";

/**
 * #2753 item 9 — `hires` (migration 0168) against a real Postgres, with HIRE_RECORDS_ENABLED on.
 *
 * The unit suites prove the rules and the plumbing. Only a database proves:
 *  - THE REAL STAGE TRANSACTION writes the row: a company's move INTO `hired` confirms one record
 *    (tenant, worker, posting) with its `hire.recorded` event beside the stage event; a no-op writes
 *    nothing; a move OUT rejects it (history kept); a re-mark confirms it again; a teammate's mark
 *    under org tenancy `on` lands on the founder's company;
 *  - the issue's check: a hired mark, a company answer and a worker answer give ONE row;
 *  - a rolled-back transaction takes its record and its event with it;
 *  - the switch off writes nothing;
 *  - the unique key (23505), the CHECKs (23514) and both foreign keys (23503);
 *  - erasure: `WorkersRepository.hardDelete` cascades to his records;
 *  - RLS enabled and FORCED, no policy, no grant to PUBLIC or a client role.
 *
 * Fixtures carry no PII: synthetic `enc:` / `hash:` markers, ids fresh per run, all deleted after.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api exec vitest run hires.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

const TAG = randomUUID().slice(0, 8);
const id = () => randomUUID();

const PAYER_A = id(); // the company (its founder: the org anchor)
const PAYER_A2 = id(); // a teammate of A's under org tenancy `on`
const PAYER_B = id(); // another company
const OPS = id();
const POST_A = id(); // company posting, A
const JOB_A = id(); // agency job, A
const W = Object.fromEntries(
  ["marked", "three", "off", "rolled", "team", "erased", "rules"].map((k) => [k, id()]),
) as Record<string, string>;
const WORKERS = Object.values(W);

const ctx = (): RequestContext => ({ correlationId: randomUUID(), requestId: `hires-db-${TAG}` });

describe.skipIf(!RUN)("hires against Postgres (#2753 item 9, migration 0168)", () => {
  let client!: DbClient;
  let hires!: HiresService;
  let stages!: PayerApplicantStagesService;
  let stagesOff!: PayerApplicantStagesService;
  let teamStages!: PayerApplicantStagesService;
  const correlations: string[] = [];

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 4 });
    const events = new EventsService(new EventsRepository(client.db), {
      NODE_ENV: "test",
    } as never);
    hires = new HiresService(new HiresRepository(client.db), events, {
      HIRE_RECORDS_ENABLED: true,
    });
    const hiresOff = new HiresService(new HiresRepository(client.db), events, {
      HIRE_RECORDS_ENABLED: false,
    });
    const build = (tenancy: PayerTenantScopeService, h: HiresService) =>
      new PayerApplicantStagesService(
        new PayerApplicantStagesRepository(client.db),
        events,
        { PAYER_APPLICANT_STAGES_ENABLED: true },
        tenancy,
        // The outcome stages are on for every company here; the RVM signal is off.
        { isEnabledFor: async () => true } as never,
        { signalsStateFor: async () => "off", recordMark: async () => "not_rvm" } as never,
        h,
      );
    const off = loadServerConfig({ NODE_ENV: "test" });
    stages = build(resolverOver(off), hires);
    stagesOff = build(resolverOver(off), hiresOff);
    // ADR-0053 `on`: A2 is a recruiter in A's org, so A2 acts for A's tenant.
    teamStages = build(
      resolverOver(loadServerConfig({ NODE_ENV: "test", PAYER_ORG_TENANCY_MODE: "on" }), [
        { anchor: PAYER_A, members: [PAYER_A2] },
      ]),
      hires,
    );
    await seed(client);
  }, 60_000);

  afterAll(async () => {
    if (!client) return;
    const { sql } = client;
    await sql`DELETE FROM hires WHERE worker_id = ANY(${WORKERS}::uuid[])`;
    await sql`DELETE FROM payer_applicant_stages WHERE worker_id = ANY(${WORKERS}::uuid[])`;
    await sql`DELETE FROM applications WHERE worker_id = ANY(${WORKERS}::uuid[])`;
    await sql`DELETE FROM worker_profiles WHERE worker_id = ANY(${WORKERS}::uuid[])`;
    if (correlations.length > 0) {
      await sql`DELETE FROM events WHERE correlation_id = ANY(${correlations}::uuid[])`;
    }
    await sql`DELETE FROM workers WHERE id = ANY(${WORKERS}::uuid[])`;
    await sql`DELETE FROM job_postings WHERE id = ${POST_A}::uuid`;
    await sql`DELETE FROM jobs WHERE id = ${JOB_A}::uuid`;
    await sql`DELETE FROM payers WHERE id = ANY(${[PAYER_A, PAYER_A2, PAYER_B]}::uuid[])`;
    await sql.end({ timeout: 5 });
  });

  /** A stage move through the REAL service, with a tracked correlation id. */
  async function move(
    svc: PayerApplicantStagesService,
    payerId: string,
    postingId: string,
    workerId: string,
    stage: ApplicantStage,
  ) {
    const c = ctx();
    correlations.push(c.correlationId);
    return { out: await svc.setStage(payerId, postingId, workerId, stage, c), c };
  }

  async function rowsFor(workerId: string) {
    return client.sql<
      {
        id: string;
        tenant_payer_id: string;
        posting_kind: string;
        posting_id: string;
        status: string;
        // The test client returns timestamps as text.
        company_marked_at: string | null;
        company_answered_at: string | null;
        worker_answered_at: string | null;
        desk_confirmed_at: string | null;
        hired_on: string | null;
        /** The India day of the company's mark, computed by Postgres (the cross-check). */
        marked_ist_day: string | null;
        updated_at: string;
      }[]
    >`
      SELECT id, tenant_payer_id, posting_kind, posting_id, status, company_marked_at,
             company_answered_at, worker_answered_at, desk_confirmed_at, hired_on::text AS hired_on,
             (company_marked_at AT TIME ZONE 'Asia/Kolkata')::date::text AS marked_ist_day,
             updated_at
      FROM hires WHERE worker_id = ${workerId}::uuid ORDER BY created_at`;
  }

  async function eventsFor(correlationId: string) {
    return client.sql<
      {
        event_name: string;
        actor_type: string;
        actor_id: string;
        subject_id: string;
        payload: Record<string, unknown>;
      }[]
    >`
      SELECT event_name, actor_type, actor_id, subject_id, payload
      FROM events WHERE correlation_id = ${correlationId}::uuid ORDER BY occurred_at, event_name`;
  }

  /** One HiresService call in its own transaction, as a later source will make it. */
  async function inTx(
    call: (tx: Database, by: HireOrigin) => Promise<unknown>,
    actor: HireOrigin["actor"],
  ) {
    const correlationId = randomUUID();
    correlations.push(correlationId);
    const by: HireOrigin = { actor, correlationId, requestId: `hires-db-${TAG}` };
    await client.db.transaction((tx) => call(tx as unknown as Database, by) as Promise<void>);
    return correlationId;
  }

  async function keyFor(workerId: string, postingId = POST_A): Promise<HireKey> {
    // The tenant key the default mode resolves for A: A itself (never a cast).
    const scope = await resolverOver(loadServerConfig({ NODE_ENV: "test" })).resolve(PAYER_A);
    return {
      tenantPayerId: scope.tenantKey,
      workerId,
      postingKind: postingId === JOB_A ? "agency_job" : "company_posting",
      postingId,
    };
  }

  it("the fixture is real: the table exists and holds nothing for these workers", async () => {
    const [reg] = await client.sql<{ t: string | null }[]>`
      SELECT to_regclass('public.hires')::text AS t`;
    expect(reg!.t).toBe("hires");
    for (const w of WORKERS) expect(await rowsFor(w)).toEqual([]);
  });

  describe("the hired-stage source: the REAL stage transaction", () => {
    it("a move INTO hired confirms ONE record, with its event beside the stage event", async () => {
      const { out, c } = await move(stages, PAYER_A, POST_A, W.marked!, "hired");
      expect(out).toMatchObject({ stage: "hired", previousStage: "new", changed: true });
      const [row, ...rest] = await rowsFor(W.marked!);
      expect(rest).toEqual([]);
      expect(row).toMatchObject({
        tenant_payer_id: PAYER_A,
        posting_kind: "company_posting",
        posting_id: POST_A,
        status: "confirmed",
        company_answered_at: null,
        worker_answered_at: null,
        desk_confirmed_at: null,
      });
      expect(row!.company_marked_at).not.toBeNull();
      // The India day of the mark, by Postgres's own clock arithmetic.
      expect(row!.hired_on).toBe(row!.marked_ist_day);
      expect(row!.hired_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const events = await eventsFor(c.correlationId);
      expect(events.map((e) => e.event_name).sort()).toEqual([
        "hire.recorded",
        "payer.applicant_stage_changed_v2",
      ]);
      expect(events.find((e) => e.event_name === "hire.recorded")).toEqual({
        event_name: "hire.recorded",
        actor_type: "payer",
        actor_id: PAYER_A,
        subject_id: W.marked,
        payload: {
          hire_id: row!.id,
          worker_id: W.marked,
          posting_kind: "company_posting",
          posting_id: POST_A,
          status: "confirmed",
          source: "company_mark",
        },
      });
    });

    it("a no-op (hired again) writes nothing and emits nothing", async () => {
      const [before] = await rowsFor(W.marked!);
      const { out, c } = await move(stages, PAYER_A, POST_A, W.marked!, "hired");
      expect(out).toMatchObject({ changed: false });
      expect(await eventsFor(c.correlationId)).toEqual([]);
      const [after] = await rowsFor(W.marked!);
      expect(after!.updated_at).toEqual(before!.updated_at);
    });

    it("a move OUT of hired rejects it (its mark kept); a re-mark confirms it again", async () => {
      const [first] = await rowsFor(W.marked!);
      const out1 = await move(stages, PAYER_A, POST_A, W.marked!, "shortlist");
      const [undone] = await rowsFor(W.marked!);
      expect(undone).toMatchObject({ id: first!.id, status: "rejected" });
      expect(undone!.company_marked_at).toEqual(first!.company_marked_at);
      expect(undone!.hired_on).toBe(first!.hired_on);
      const [e1] = (await eventsFor(out1.c.correlationId)).filter(
        (e) => e.event_name === "hire.recorded",
      );
      expect(e1!.payload).toMatchObject({ status: "rejected", source: "company_unmark" });

      await move(stages, PAYER_A, POST_A, W.marked!, "hired");
      const rows = await rowsFor(W.marked!);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: first!.id, status: "confirmed" });
      expect(rows[0]!.company_marked_at).toEqual(first!.company_marked_at);
    });

    it("a teammate's mark under org tenancy `on` is the founder's company's record", async () => {
      await move(teamStages, PAYER_A2, JOB_A, W.team!, "hired");
      const [row] = await rowsFor(W.team!);
      expect(row).toMatchObject({
        tenant_payer_id: PAYER_A,
        posting_kind: "agency_job",
        posting_id: JOB_A,
        status: "confirmed",
      });
    });

    it("the switch OFF: a move into hired writes no record and no hire event", async () => {
      const { out, c } = await move(stagesOff, PAYER_A, POST_A, W.off!, "hired");
      expect(out).toMatchObject({ changed: true });
      expect(await rowsFor(W.off!)).toEqual([]);
      expect((await eventsFor(c.correlationId)).map((e) => e.event_name)).toEqual([
        "payer.applicant_stage_changed_v2",
      ]);
    });
  });

  describe("the issue's check: a hired mark, a company answer and a worker answer → ONE record", () => {
    it("three sources, one row, every source stamped, confirmed", async () => {
      await move(stages, PAYER_A, POST_A, W.three!, "hired");
      const key = await keyFor(W.three!);
      await inTx((tx, by) => hires.recordCompanyAnswer(key, new Date(), tx, by), {
        actor_type: "payer",
        actor_id: PAYER_A,
      });
      const workerCorrelation = await inTx(
        (tx, by) => hires.recordWorkerAnswer(key, new Date(), tx, by),
        { actor_type: "worker", actor_id: W.three! },
      );
      const rows = await rowsFor(W.three!);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "confirmed", desk_confirmed_at: null });
      expect(rows[0]!.company_marked_at).not.toBeNull();
      expect(rows[0]!.company_answered_at).not.toBeNull();
      expect(rows[0]!.worker_answered_at).not.toBeNull();
      const [e] = await eventsFor(workerCorrelation);
      expect(e).toMatchObject({
        actor_type: "worker",
        actor_id: W.three,
        payload: { status: "confirmed", source: "worker_answer", hire_id: rows[0]!.id },
      });
      // With the company's answer on it, moving him out no longer rejects it.
      await move(stages, PAYER_A, POST_A, W.three!, "selected");
      expect((await rowsFor(W.three!))[0]!.status).toBe("confirmed");
    });
  });

  it("a transaction that rolls back takes its record and its event with it", async () => {
    const key = await keyFor(W.rolled!);
    const correlationId = randomUUID();
    correlations.push(correlationId);
    const by: HireOrigin = { actor: { actor_type: "payer", actor_id: PAYER_A }, correlationId };
    const boom = new Error("t2753: roll it back");
    await expect(
      client.db.transaction(async (tx) => {
        await hires.recordCompanyMark(key, new Date(), tx as unknown as Database, by);
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await rowsFor(W.rolled!)).toEqual([]);
    expect(await eventsFor(correlationId)).toEqual([]);
  });

  describe("the table's own rules", () => {
    /** A raw insert, for the constraint cases; the SQLSTATE it fails with, or "ok". */
    async function insert(over: Record<string, string>): Promise<string> {
      const v = {
        tenant: PAYER_B,
        worker: W.rules!,
        kind: "company_posting",
        posting: POST_A,
        status: "reported",
        ...over,
      };
      try {
        await client.sql`
          INSERT INTO hires (tenant_payer_id, worker_id, posting_kind, posting_id, status)
          VALUES (${v.tenant}::uuid, ${v.worker}::uuid, ${v.kind}, ${v.posting}::uuid, ${v.status})`;
        return "ok";
      } catch (err) {
        return (err as { code?: string }).code ?? String(err);
      }
    }

    it("one record per (company, worker, posting kind, posting id): a second is 23505", async () => {
      expect(await insert({})).toBe("ok");
      expect(await insert({ status: "confirmed" })).toBe("23505");
      // A different kind, posting or company is a different record.
      expect(await insert({ kind: "agency_job" })).toBe("ok");
      expect(await insert({ posting: JOB_A })).toBe("ok");
      expect(await insert({ tenant: PAYER_A })).toBe("ok");
      expect(await rowsFor(W.rules!)).toHaveLength(4);
    });

    it("the CHECKs refuse an unknown status or posting kind (23514)", async () => {
      const fresh = id();
      expect(await insert({ posting: fresh, status: "hired" })).toBe("23514");
      expect(await insert({ posting: fresh, status: "Confirmed" })).toBe("23514");
      expect(await insert({ posting: fresh, kind: "job" })).toBe("23514");
    });

    it("both foreign keys hold: an unknown company or worker is 23503", async () => {
      expect(await insert({ posting: id(), tenant: id() })).toBe("23503");
      expect(await insert({ posting: id(), worker: id() })).toBe("23503");
    });

    it("RLS is ENABLED and FORCED, with no policy and no grant to PUBLIC or a client role", async () => {
      const [rls] = await client.sql<{ enabled: boolean; forced: boolean }[]>`
        SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
          FROM pg_class WHERE oid = 'public.hires'::regclass`;
      expect(rls).toEqual({ enabled: true, forced: true });
      const [policies] = await client.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'hires'`;
      expect(policies!.n).toBe(0);
      const [grants] = await client.sql<{ n: number }[]>`
        SELECT count(*)::int AS n
          FROM pg_class c, aclexplode(c.relacl) a
         WHERE c.oid = 'public.hires'::regclass
           AND (a.grantee = 0
                OR a.grantee IN (SELECT oid FROM pg_roles
                                  WHERE rolname IN ('anon', 'authenticated', 'service_role')))`;
      expect(grants!.n).toBe(0);
    });
  });

  it("erasure: WorkersRepository.hardDelete removes his hire records (ON DELETE CASCADE)", async () => {
    await move(stages, PAYER_A, POST_A, W.erased!, "hired");
    expect(await rowsFor(W.erased!)).toHaveLength(1);
    await client.sql`DELETE FROM applications WHERE worker_id = ${W.erased!}::uuid`;
    await client.sql`DELETE FROM payer_applicant_stages WHERE worker_id = ${W.erased!}::uuid`;
    await expect(new WorkersRepository(client.db).hardDelete(W.erased!)).resolves.toBe(true);
    expect(await rowsFor(W.erased!)).toEqual([]);
  });

  async function seed(c: DbClient): Promise<void> {
    const { sql } = c;
    for (const [i, p] of [PAYER_A, PAYER_A2, PAYER_B].entries()) {
      await sql`
        INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status)
        VALUES (${p}::uuid, 'employer', ${`enc:hires-${TAG}-${i}`}, ${`hash:hires-${TAG}-${i}`},
                ${`enc:hires-org-${TAG}-${i}`}, 'active')`;
    }
    await sql`
      INSERT INTO job_postings (id, created_by, payer_id, org_label, role_title, vacancy_band, status,
                                match_skill_ids, reach_skill_ids, published_at)
      VALUES (${POST_A}::uuid, ${OPS}::uuid, ${PAYER_A}::uuid, 'Hires Fixture', ${`Hires posting ${TAG}`},
              '1', 'open', '["mskill_vmc_operator"]'::jsonb, '["mskill_vmc_operator"]'::jsonb, now())`;
    await sql`
      INSERT INTO jobs (id, trade_key, title, city, status, payer_id, min_experience_years, pay_min, pay_max)
      VALUES (${JOB_A}::uuid, 'cnc_vmc', ${`Hires job ${TAG}`}, 'pune', 'open', ${PAYER_A}::uuid, 1, 18000, 30000)`;
    for (const [k, workerId] of Object.entries(W)) {
      await sql`
        INSERT INTO workers (id, phone_e164, phone_hash, status)
        VALUES (${workerId}::uuid, ${`enc:hires-${TAG}-${k}`}, ${`hash:hires-${TAG}-${k}`}, 'active')`;
      await sql`
        INSERT INTO worker_profiles (worker_id, profile_status, canonical_role_id, canonical_trade_id,
                                     experience, location_preference, availability)
        VALUES (${workerId}::uuid, 'extracted', 'vmc_operator', 'cnc_vmc',
                ${JSON.stringify({ total_years: 3 })}::jsonb,
                ${JSON.stringify({ preferred_cities: ["pune"] })}::jsonb,
                ${JSON.stringify({ status: "immediate" })}::jsonb)`;
      // Every worker applied to both of A's postings, so each is on both feeds.
      await sql`
        INSERT INTO applications (id, worker_id, job_id, job_posting_id, action, source_surface,
                                  match_tier, engine_version)
        VALUES (${id()}::uuid, ${workerId}::uuid, NULL, ${POST_A}::uuid, 'applied', 'feed', 1, 'v1.0'),
               (${id()}::uuid, ${workerId}::uuid, ${JOB_A}::uuid, NULL, 'applied', 'feed', NULL, NULL)`;
    }
  }
});
