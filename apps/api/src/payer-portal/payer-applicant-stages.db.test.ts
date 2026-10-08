import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { createDbClient, type DbClient } from "@badabhai/db";
import { DEFAULT_MATCH_CONFIG } from "@badabhai/match-engine";
import type { ApplicantStage } from "@badabhai/types";
import type { RequestContext } from "../common/request-context";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { ReachRepository } from "../reach/reach.repository";
import { ReachService } from "../reach/reach.service";
import { MatchFeedRepository } from "../match/match-feed.repository";
import { MatchCandidatesService } from "../match/match-candidates.service";
import { PayerApplicantsService } from "./payer-applicants.service";
import { PayerApplicantInboxRepository } from "./payer-applicant-inbox.repository";
import { PayerApplicantInboxService } from "./payer-applicant-inbox.service";
import { decodeInboxCursor } from "./payer-applicant-inbox.cursor";
import type { InboxApplicantRowDto } from "./payer-applicant-inbox.dto";
import { PayerApplicantStagesRepository } from "./payer-applicant-stages.repository";
import { PayerApplicantStagesService } from "./payer-applicant-stages.service";
import { APPLICANT_NOT_FOUND } from "./payer-applicant-stage.dto";
import type { PayerTenantScope } from "../payers/payer-tenant-scope";
import { defaultModeResolver, ownTenantKey } from "../payers/payer-tenant-scope.test-support";

/**
 * THE PAYER APPLICANT PIPELINE BOARD AGAINST A REAL POSTGRES (owner ruling 2026-10-07; migration
 * 0134), with PAYER_APPLICANT_STAGES_ENABLED on.
 *
 * The unit suites prove the statements SAY the right thing and the services plumb them right.
 * Only a database proves they EVALUATE that way:
 *  - ownership + membership: a foreign posting, an unknown id, a non-applicant, a skip, a worker in
 *    the deletion grace window and a profile-less agency applier are the same neutral 404, and
 *    nothing is written for any of them;
 *  - the write: the first move inserts, a repeat is a no-op (no row change, no event), moving back
 *    stores `new`, and every real change writes ONE validated event row with the right payload;
 *  - concurrency: two simultaneous first moves on one applicant serialise on the primary key —
 *    one row, two events whose `previous_stage` chain is exact;
 *  - reads: both per-posting feeds and the inbox carry the stage, the inbox row minus `posting`
 *    is the per-posting row, and `?stage=` with keyset paging walks each stage exactly once;
 *  - erasure: deleting a worker removes his board rows (the FK cascade).
 *
 * Fixtures carry no PII: synthetic `enc:`/`hash:` markers, ids fresh per run, all deleted after.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api exec vitest run payer-applicant-stages.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

const TAG = randomUUID().slice(0, 8);
const id = () => randomUUID();

const PAYER_A = id();
const PAYER_A2 = id(); // a teammate: today a separate payer; ownership stays A's
const PAYER_B = id();
const OPS = id();
const JOB_A = id(); // agency job, A
const POST_A = id(); // company posting, A
const POST_B = id(); // company posting, B

const W = Object.fromEntries(
  ["w1", "w2", "w3", "w4", "w5", "skipper", "leaver", "noprof", "stranger", "erased"].map((k) => [
    k,
    id(),
  ]),
) as Record<string, string>;

interface Fixture {
  worker: string;
  jobId: string | null;
  postingId: string | null;
  action: "applied" | "skipped";
  t: string;
}
const t = (s: string) => `2026-10-02T10:00:${s}Z`;
/** A's applicants: w1..w4 on the agency job, w1 + w5 on the posting; B's posting has w2. */
const FIXTURES: Fixture[] = [
  { worker: W.w1!, jobId: JOB_A, postingId: null, action: "applied", t: t("01.000000") },
  { worker: W.w2!, jobId: JOB_A, postingId: null, action: "applied", t: t("02.000000") },
  { worker: W.w3!, jobId: JOB_A, postingId: null, action: "applied", t: t("03.000000") },
  { worker: W.w4!, jobId: JOB_A, postingId: null, action: "applied", t: t("04.000000") },
  { worker: W.skipper!, jobId: JOB_A, postingId: null, action: "skipped", t: t("05.000000") },
  { worker: W.leaver!, jobId: JOB_A, postingId: null, action: "applied", t: t("06.000000") },
  { worker: W.noprof!, jobId: JOB_A, postingId: null, action: "applied", t: t("07.000000") },
  { worker: W.w1!, jobId: null, postingId: POST_A, action: "applied", t: t("08.000000") },
  { worker: W.w5!, jobId: null, postingId: POST_A, action: "applied", t: t("09.000000") },
  { worker: W.erased!, jobId: null, postingId: POST_A, action: "applied", t: t("10.000000") },
  { worker: W.w2!, jobId: null, postingId: POST_B, action: "applied", t: t("11.000000") },
];

const ctx = (): RequestContext => ({ correlationId: randomUUID(), requestId: `stages-db-${TAG}` });

describe.skipIf(!RUN)("payer applicant pipeline board — against Postgres (flag on)", () => {
  let client!: DbClient;
  let stages!: PayerApplicantStagesService;
  let perPosting!: PayerApplicantsService;
  let inbox!: PayerApplicantInboxService;
  const correlations: string[] = [];

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 4 });
    const events = new EventsService(new EventsRepository(client.db), {
      NODE_ENV: "test",
    } as never);
    const on = { PAYER_APPLICANT_STAGES_ENABLED: true };
    // ADR-0053 — the default tenancy mode (off): A2 is a separate payer, as before.
    const tenancy = defaultModeResolver();
    stages = new PayerApplicantStagesService(
      new PayerApplicantStagesRepository(client.db),
      events,
      on,
      tenancy,
    );
    const reach = new ReachService(new ReachRepository(client.db), events, {} as never);
    const candidates = new MatchCandidatesService(new MatchFeedRepository(client.db), {
      get: async () => DEFAULT_MATCH_CONFIG,
    } as never);
    // The per-posting route's ownership seam for a posting, reduced to its WHERE.
    const jobPostings = {
      getOneInScope: async (postingId: string, scope: PayerTenantScope) => {
        const rows = await client.sql`
          SELECT id FROM job_postings WHERE id = ${postingId}::uuid AND payer_id = ${scope.tenantKey}::uuid`;
        if (rows.length === 0) throw new NotFoundException("Job posting not found");
        return rows[0];
      },
    };
    perPosting = new PayerApplicantsService(
      reach,
      jobPostings as never,
      candidates,
      stages,
      tenancy,
    );
    inbox = new PayerApplicantInboxService(
      new PayerApplicantInboxRepository(client.db),
      reach,
      candidates,
      on,
      tenancy,
    );
    await seed(client);
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await cleanup(client, correlations);
      await client.sql.end({ timeout: 5 });
    }
  });

  /** setStage with a fresh, tracked correlation id. */
  async function move(payerId: string, postingId: string, workerId: string, stage: ApplicantStage) {
    const c = ctx();
    correlations.push(c.correlationId);
    return { out: await stages.setStage(payerId, postingId, workerId, stage, c), c };
  }

  async function eventsFor(correlationId: string) {
    return client.sql<
      {
        event_name: string;
        event_version: number;
        actor_type: string;
        actor_id: string;
        subject_type: string;
        subject_id: string;
        payload: Record<string, unknown>;
      }[]
    >`
      SELECT event_name, event_version, actor_type, actor_id, subject_type, subject_id, payload
      FROM events WHERE correlation_id = ${correlationId}::uuid`;
  }

  async function rowsFor(postingId: string) {
    return client.sql<
      { posting_kind: string; worker_id: string; stage: string; actor_payer_id: string }[]
    >`
      SELECT posting_kind, worker_id, stage, actor_payer_id
      FROM payer_applicant_stages WHERE posting_id = ${postingId}::uuid ORDER BY worker_id`;
  }

  it("the fixture is real: the migration's table exists and starts empty for these postings", async () => {
    const [reg] = await client.sql<{ t: string | null }[]>`
      SELECT to_regclass('public.payer_applicant_stages')::text AS t`;
    expect(reg!.t).toBe("payer_applicant_stages");
    for (const p of [JOB_A, POST_A, POST_B]) expect(await rowsFor(p)).toEqual([]);
  });

  /** [case, () => [payer, posting id, worker id]] — thunks, because W is filled at module load. */
  const MISSES: [string, () => [string, string, string]][] = [
    ["another payer's posting (the worker IS on it)", () => [PAYER_A, POST_B, W.w2!]],
    ["an unknown id", () => [PAYER_A, randomUUID(), W.w1!]],
    ["a worker who never applied", () => [PAYER_A, JOB_A, W.stranger!]],
    ["a worker who skipped", () => [PAYER_A, JOB_A, W.skipper!]],
    ["a worker in the deletion grace window", () => [PAYER_A, JOB_A, W.leaver!]],
    ["an agency applier with no profile row", () => [PAYER_A, JOB_A, W.noprof!]],
    [
      "a posting applicant, asked about on the payer's OTHER posting",
      () => [PAYER_A, POST_A, W.w2!],
    ],
  ];
  it.each(MISSES)("404 (the feeds' body) and nothing written: %s", async (_c, args) => {
    const [payer, posting, worker] = args();
    const c = ctx();
    correlations.push(c.correlationId);
    const err = await stages.setStage(payer, posting, worker, "shortlist", c).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).message).toBe(APPLICANT_NOT_FOUND);
    expect(await eventsFor(c.correlationId)).toEqual([]);
    const counted = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM payer_applicant_stages
      WHERE posting_id = ${posting}::uuid AND worker_id = ${worker}::uuid`;
    expect(counted[0]!.n).toBe(0);
  });

  it("first move: one row (stamped with the session payer) and ONE validated event", async () => {
    const { out, c } = await move(PAYER_A, JOB_A, W.w1!, "shortlist");
    expect(out).toEqual({
      postingId: JOB_A,
      postingKind: "agency_job",
      workerId: W.w1,
      stage: "shortlist",
      previousStage: "new",
      changed: true,
    });
    expect(await rowsFor(JOB_A)).toEqual([
      {
        posting_kind: "agency_job",
        worker_id: W.w1,
        stage: "shortlist",
        actor_payer_id: PAYER_A,
      },
    ]);
    expect(await eventsFor(c.correlationId)).toEqual([
      {
        event_name: "payer.applicant_stage_changed",
        event_version: 1,
        actor_type: "payer",
        actor_id: PAYER_A,
        subject_type: "worker",
        subject_id: W.w1,
        payload: {
          posting_kind: "agency_job",
          posting_id: JOB_A,
          worker_id: W.w1,
          stage: "shortlist",
          previous_stage: "new",
        },
      },
    ]);
  });

  it("idempotent: the same stage again changes no row and writes no event", async () => {
    const [before] = await client.sql<{ updated_at: Date }[]>`
      SELECT updated_at FROM payer_applicant_stages
      WHERE posting_kind = 'agency_job' AND posting_id = ${JOB_A}::uuid AND worker_id = ${W.w1!}::uuid`;
    const { out, c } = await move(PAYER_A, JOB_A, W.w1!, "shortlist");
    expect(out).toMatchObject({ previousStage: "shortlist", changed: false });
    expect(await eventsFor(c.correlationId)).toEqual([]);
    const [after] = await client.sql<{ updated_at: Date }[]>`
      SELECT updated_at FROM payer_applicant_stages
      WHERE posting_kind = 'agency_job' AND posting_id = ${JOB_A}::uuid AND worker_id = ${W.w1!}::uuid`;
    expect(after!.updated_at).toEqual(before!.updated_at);
    // `new` for someone nobody moved: no row is created.
    const none = await move(PAYER_A, JOB_A, W.w4!, "new");
    expect(none.out).toMatchObject({ previousStage: "new", changed: false });
    expect((await rowsFor(JOB_A)).map((r) => r.worker_id)).not.toContain(W.w4);
  });

  it("moving back to New STORES `new`, records who moved it, and emits", async () => {
    const { out, c } = await move(PAYER_A, JOB_A, W.w1!, "new");
    expect(out).toMatchObject({ stage: "new", previousStage: "shortlist", changed: true });
    expect((await rowsFor(JOB_A)).find((r) => r.worker_id === W.w1)).toMatchObject({
      stage: "new",
      actor_payer_id: PAYER_A,
    });
    const [e] = await eventsFor(c.correlationId);
    expect(e!.payload).toMatchObject({ stage: "new", previous_stage: "shortlist" });
  });

  it("concurrency: two simultaneous FIRST moves → one row, two events with an exact chain", async () => {
    const results = await Promise.all([
      move(PAYER_A, JOB_A, W.w2!, "shortlist"),
      move(PAYER_A, JOB_A, W.w2!, "passed"),
    ]);
    const rows = (await rowsFor(JOB_A)).filter((r) => r.worker_id === W.w2);
    expect(rows).toHaveLength(1);
    const events = (await Promise.all(results.map((r) => eventsFor(r.c.correlationId)))).flat();
    expect(events).toHaveLength(2);
    // Whichever committed first replaced `new`; the second replaced the first's stage.
    const first = events.find((e) => e.payload.previous_stage === "new")!;
    const second = events.find((e) => e !== first)!;
    expect(second.payload.previous_stage).toBe(first.payload.stage);
    expect(rows[0]!.stage).toBe(second.payload.stage);
  });

  it("set up the rest of the board", async () => {
    await move(PAYER_A, JOB_A, W.w3!, "passed");
    await move(PAYER_A, POST_A, W.w5!, "shortlist");
    // A teammate's session is a different payer today: until org tenancy (PAY-DB-01) widens
    // ownership, it cannot write A's board — the same 404 as anyone else.
    const err = await stages
      .setStage(PAYER_A2, POST_A, W.w1!, "passed", ctx())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    // B's own board is B's: w2 is shortlisted on B's posting.
    await move(PAYER_B, POST_B, W.w2!, "shortlist");
  });

  it("the board read goes through the ownership chokepoint: B's stored board never reaches A (ADR-0053 §4)", async () => {
    // Not vacuous: B's posting DOES have a stored stage.
    expect((await rowsFor(POST_B)).map((r) => r.stage)).toEqual(["shortlist"]);
    const asA = await stages.stagesForOwnedPosting(POST_B, await ownTenantKey(PAYER_A));
    expect(asA!.company_posting.size).toBe(0);
    expect(asA!.agency_job.size).toBe(0);
    const asB = await stages.stagesForOwnedPosting(POST_B, await ownTenantKey(PAYER_B));
    expect([...asB!.company_posting]).toEqual([[W.w2, "shortlist"]]);
    // An unknown id reads nothing either.
    const unknown = await stages.stagesForOwnedPosting(randomUUID(), await ownTenantKey(PAYER_A));
    expect(unknown!.company_posting.size + unknown!.agency_job.size).toBe(0);
  });

  it("per-posting feeds carry each applicant's stage — agency and company — and keep everyone listed", async () => {
    const c = ctx();
    correlations.push(c.correlationId);
    const agency = (await perPosting.listForOwned(JOB_A, PAYER_A, c)) as {
      applicants: { workerId: string; stage: string; score: number }[];
    };
    const w2 = (await rowsFor(JOB_A)).find((r) => r.worker_id === W.w2)!.stage;
    expect(Object.fromEntries(agency.applicants.map((a) => [a.workerId, a.stage]))).toEqual({
      [W.w1!]: "new",
      [W.w2!]: w2,
      [W.w3!]: "passed",
      [W.w4!]: "new",
    });
    expect(agency.applicants.every((a) => typeof a.score === "number")).toBe(true);

    const company = (await perPosting.listForOwned(POST_A, PAYER_A, c)) as {
      applicants: { workerId: string; stage: string; applicationId: string }[];
    };
    expect(Object.fromEntries(company.applicants.map((a) => [a.workerId, a.stage]))).toEqual({
      [W.w1!]: "new",
      [W.w5!]: "shortlist",
      [W.erased!]: "new",
    });
    // w1 is `new` on the posting although his agency-job row is stored `new` too: boards are
    // per posting, and B's shortlist of w2 never reaches A.
  });

  async function walk(limit: number, stage?: ApplicantStage, postingId?: string) {
    const rows: InboxApplicantRowDto[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 100; i += 1) {
      const c = ctx();
      correlations.push(c.correlationId);
      const page = await inbox.list(
        PAYER_A,
        {
          limit,
          postingId,
          stage,
          cursor: cursor === undefined ? undefined : decodeInboxCursor(cursor)!,
        },
        c,
      );
      rows.push(...page.applicants);
      if (page.nextCursor === null) return rows;
      cursor = page.nextCursor;
    }
    throw new Error("pagination never ended");
  }
  const keyOf = (r: InboxApplicantRowDto) => `${r.posting.id}|${r.workerId}`;

  it("inbox: every row carries its stage, equal to the per-posting row (parity, minus `posting`)", async () => {
    const rows = await walk(50);
    expect(rows).toHaveLength(7); // w1..w4 on the job, w1/w5/erased on the posting
    for (const row of rows) {
      const { posting, ...rest } = row;
      const c = ctx();
      correlations.push(c.correlationId);
      const list = await perPosting.listForOwned(posting.id, PAYER_A, c);
      const twin = (list.applicants as unknown as Record<string, unknown>[]).find(
        (a) => a.workerId === rest.workerId,
      );
      expect(twin, keyOf(row)).toBeDefined();
      expect(rest).toStrictEqual(twin);
    }
    expect(JSON.stringify(rows)).not.toContain(POST_B);
  });

  it.each([1, 2, 3])(
    "inbox ?stage= at page size %i: each stage's walk is exact, and the three partition the inbox",
    async (limit) => {
      const all = (await walk(50)).map(keyOf);
      const byStage: Record<string, string[]> = {};
      for (const stage of ["new", "shortlist", "passed"] as const) {
        const rows = await walk(limit, stage);
        expect(rows.every((r) => r.stage === stage)).toBe(true);
        byStage[stage] = rows.map(keyOf);
        // Same relative order as the unfiltered inbox, no repeats.
        expect(byStage[stage]).toEqual(all.filter((k) => byStage[stage]!.includes(k)));
        expect(new Set(byStage[stage]).size).toBe(byStage[stage]!.length);
      }
      expect([...byStage.new!, ...byStage.shortlist!, ...byStage.passed!].sort()).toEqual(
        [...all].sort(),
      );
      // `new` = no row (w4, w3-is-passed excluded) OR stored `new` (w1 on the job).
      expect(byStage.new).toContain(`${JOB_A}|${W.w1}`);
      expect(byStage.new).toContain(`${JOB_A}|${W.w4}`);
      expect(byStage.passed).toContain(`${JOB_A}|${W.w3}`);
      expect(byStage.shortlist).toContain(`${POST_A}|${W.w5}`);
    },
  );

  it("inbox ?stage= composes with postingId", async () => {
    expect((await walk(1, "shortlist", POST_A)).map(keyOf)).toEqual([`${POST_A}|${W.w5}`]);
    expect((await walk(1, "passed", POST_A)).map(keyOf)).toEqual([]);
    // Another payer's posting under a filter is the same neutral empty page.
    expect(await walk(1, "shortlist", POST_B)).toEqual([]);
  });

  it("erasure: deleting the worker removes his board rows (ON DELETE CASCADE)", async () => {
    await move(PAYER_A, POST_A, W.erased!, "passed");
    expect((await rowsFor(POST_A)).map((r) => r.worker_id)).toContain(W.erased);
    await client.sql`DELETE FROM applications WHERE worker_id = ${W.erased!}::uuid`;
    await client.sql`DELETE FROM worker_profiles WHERE worker_id = ${W.erased!}::uuid`;
    await client.sql`DELETE FROM workers WHERE id = ${W.erased!}::uuid`;
    expect((await rowsFor(POST_A)).map((r) => r.worker_id)).not.toContain(W.erased);
  });
});

async function seed(client: DbClient): Promise<void> {
  const { sql } = client;
  await sql`
    INSERT INTO jobs (id, trade_key, title, city, status, payer_id, min_experience_years, pay_min, pay_max)
    VALUES (${JOB_A}::uuid, 'cnc_vmc', ${`Stages job A ${TAG}`}, 'pune', 'open', ${PAYER_A}::uuid, 1, 18000, 30000)`;
  for (const [postingId, payer] of [
    [POST_A, PAYER_A],
    [POST_B, PAYER_B],
  ] as const) {
    await sql`
      INSERT INTO job_postings (id, created_by, payer_id, org_label, role_title, vacancy_band, status,
                                match_skill_ids, reach_skill_ids, published_at)
      VALUES (${postingId}::uuid, ${OPS}::uuid, ${payer}::uuid, 'Stages Fixture', ${`Stages posting ${TAG}`},
              '1', 'open', '["mskill_vmc_operator"]'::jsonb, '["mskill_vmc_operator"]'::jsonb, now())`;
  }
  for (const [k, workerId] of Object.entries(W)) {
    await sql`
      INSERT INTO workers (id, phone_e164, phone_hash, status, deletion_scheduled_at)
      VALUES (${workerId}::uuid, ${`enc:stages-${TAG}-${k}`}, ${`hash:stages-${TAG}-${k}`}, 'active',
              ${k === "leaver" ? sql`now() + interval '7 days'` : null})`;
    if (k === "noprof") continue;
    await sql`
      INSERT INTO worker_profiles (worker_id, profile_status, canonical_role_id, canonical_trade_id,
                                   experience, location_preference, availability)
      VALUES (${workerId}::uuid, 'extracted', 'vmc_operator', 'cnc_vmc',
              ${JSON.stringify({ total_years: 3 })}::jsonb,
              ${JSON.stringify({ preferred_cities: ["pune"] })}::jsonb,
              ${JSON.stringify({ status: "immediate" })}::jsonb)`;
  }
  for (const f of FIXTURES) {
    await sql`
      INSERT INTO applications (id, worker_id, job_id, job_posting_id, action, source_surface,
                                match_tier, engine_version, created_at)
      VALUES (${id()}::uuid, ${f.worker}::uuid, ${f.jobId}::uuid, ${f.postingId}::uuid, ${f.action},
              'feed', ${f.postingId ? 1 : null}, ${f.postingId ? "v1.0" : null}, ${f.t}::timestamptz)`;
  }
}

async function cleanup(client: DbClient, correlations: readonly string[]): Promise<void> {
  const { sql } = client;
  const workers = Object.values(W);
  await sql`DELETE FROM payer_applicant_stages WHERE posting_id = ANY(${[JOB_A, POST_A, POST_B]}::uuid[])`;
  await sql`DELETE FROM applications WHERE worker_id = ANY(${workers}::uuid[])`;
  await sql`DELETE FROM worker_profiles WHERE worker_id = ANY(${workers}::uuid[])`;
  if (correlations.length > 0) {
    await sql`DELETE FROM events WHERE correlation_id = ANY(${[...correlations]}::uuid[])`;
  }
  await sql`DELETE FROM workers WHERE id = ANY(${workers}::uuid[])`;
  await sql`DELETE FROM jobs WHERE id = ${JOB_A}::uuid`;
  await sql`DELETE FROM job_postings WHERE id = ANY(${[POST_A, POST_B]}::uuid[])`;
}
