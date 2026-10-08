import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { createDbClient, type DbClient } from "@badabhai/db";
import { DEFAULT_MATCH_CONFIG } from "@badabhai/match-engine";
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
import { stagesOff } from "./payer-applicant-stages.test-support";
import type { PayerTenantScope } from "../payers/payer-tenant-scope";
import { defaultModeResolver, ownTenantKey } from "../payers/payer-tenant-scope.test-support";
import { decodeInboxCursor } from "./payer-applicant-inbox.cursor";
import type { InboxApplicantRowDto } from "./payer-applicant-inbox.dto";

/**
 * `GET /payer/reach/applicants` AGAINST A REAL POSTGRES.
 *
 * The unit suites prove the statements SAY the right thing and the service plumbs them right.
 * Only a database proves they EVALUATE that way:
 *  - ownership: payer A's walk is exactly A's applicants; B's rows never reach A; a `postingId`
 *    of B's, or an unknown one, is the same empty page as an owned posting nobody applied to;
 *  - order + pagination: `(created_at DESC, id DESC)` with a same-MICROSECOND tie across the two
 *    arms, walked at several page sizes — every applicant exactly once, no gap, no repeat;
 *  - membership: a skip, a worker in the deletion grace window and an agency applier with no
 *    profile row are never listed; a worker with two profile rows is one row per application;
 *    an application carrying BOTH references is listed once (jobs-first);
 *  - PARITY: every row, minus `posting`, is `toStrictEqual` to the row the per-posting route
 *    (the real `PayerApplicantsService.listForOwned`) serves for that applicant — which is where
 *    the window rank is proven equal to `listCandidates`' position, and the batched applier read
 *    equal to the per-job one;
 *  - events: the real `EventsService` validates and writes one `feed.shown` per agency row shown
 *    (payer actor), none for company rows.
 *
 * Fixtures carry no PII: synthetic `enc:`/`hash:` markers in the NOT NULL phone columns, ids
 * fresh per run, everything deleted afterwards.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api exec vitest run payer-applicant-inbox.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

const TAG = randomUUID().slice(0, 8);
const id = () => randomUUID();

const PAYER_A = id();
const PAYER_B = id();
const OPS = id();
const JOB_A1 = id();
const JOB_A2 = id();
const JOB_B = id();
const POST_A1 = id();
const POST_A2 = id();
const POST_A_EMPTY = id();
const POST_B = id();

const W = Object.fromEntries(
  ["w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8", "w9", "w10", "leaver", "noprof", "both"].map(
    (k) => [k, id()],
  ),
) as Record<string, string>;

interface Fixture {
  key: string;
  worker: string;
  jobId: string | null;
  postingId: string | null;
  action: "applied" | "skipped";
  /** Microsecond UTC text — written as-is, so the keyset sees exactly this. */
  t: string;
  tier?: number | null;
  skill?: number | null;
  industry?: number | null;
  lastWorked?: string | null;
}

const t = (s: string) => `2026-10-01T10:00:${s}Z`;
const FIXTURES: Fixture[] = [
  {
    key: "a1",
    worker: W.w1!,
    jobId: JOB_A1,
    postingId: null,
    action: "applied",
    t: t("00.000001"),
  },
  {
    key: "a2",
    worker: W.w2!,
    jobId: JOB_A1,
    postingId: null,
    action: "applied",
    t: t("00.000002"),
  },
  {
    key: "a3",
    worker: W.w3!,
    jobId: JOB_A1,
    postingId: null,
    action: "applied",
    t: t("01.000000"),
  },
  {
    key: "a4",
    worker: W.w4!,
    jobId: JOB_A1,
    postingId: null,
    action: "skipped",
    t: t("02.000000"),
  },
  {
    key: "a5",
    worker: W.leaver!,
    jobId: JOB_A1,
    postingId: null,
    action: "applied",
    t: t("03.000000"),
  },
  {
    key: "a6",
    worker: W.noprof!,
    jobId: JOB_A2,
    postingId: null,
    action: "applied",
    t: t("04.000000"),
  },
  {
    key: "a7",
    worker: W.w5!,
    jobId: JOB_A2,
    postingId: null,
    action: "applied",
    t: t("05.500000"),
  },
  // Same microsecond as a7, in the OTHER arm: the id breaks the tie across the union.
  {
    key: "a8",
    worker: W.w6!,
    jobId: null,
    postingId: POST_A1,
    action: "applied",
    t: t("05.500000"),
    tier: 1,
    skill: 6,
    industry: 6,
    lastWorked: null,
  },
  {
    key: "a9",
    worker: W.w7!,
    jobId: null,
    postingId: POST_A1,
    action: "applied",
    t: t("06.000000"),
    tier: 1,
    skill: 48,
    industry: 60,
    lastWorked: "2026-05-01",
  },
  {
    key: "a10",
    worker: W.w8!,
    jobId: null,
    postingId: POST_A1,
    action: "applied",
    t: t("07.000000"),
    tier: 2,
    skill: 12,
    industry: 12,
    lastWorked: "2025-01-01",
  },
  {
    key: "a11",
    worker: W.w1!,
    jobId: null,
    postingId: POST_A2,
    action: "applied",
    t: t("08.000000"),
    tier: 1,
    skill: null,
    industry: null,
    lastWorked: null,
  },
  {
    key: "a12",
    worker: W.leaver!,
    jobId: null,
    postingId: POST_A2,
    action: "applied",
    t: t("09.000000"),
    tier: 1,
    skill: 999,
    industry: 999,
    lastWorked: "2026-06-01",
  },
  // BOTH references, both A's: listed once, as the agency job (jobs-first).
  {
    key: "a13",
    worker: W.both!,
    jobId: JOB_A2,
    postingId: POST_A2,
    action: "applied",
    t: t("10.000000"),
    tier: 1,
    skill: 24,
    industry: 24,
    lastWorked: null,
  },
  {
    key: "a14",
    worker: W.w9!,
    jobId: JOB_B,
    postingId: null,
    action: "applied",
    t: t("11.000000"),
  },
  {
    key: "a15",
    worker: W.w10!,
    jobId: null,
    postingId: POST_B,
    action: "applied",
    t: t("12.000000"),
    tier: 1,
    skill: 1,
    industry: 1,
    lastWorked: null,
  },
  {
    key: "a16",
    worker: W.w2!,
    jobId: null,
    postingId: POST_A1,
    action: "skipped",
    t: t("13.000000"),
  },
];
const APP = Object.fromEntries(FIXTURES.map((f) => [f.key, id()])) as Record<string, string>;
const byApp = new Map(FIXTURES.map((f) => [APP[f.key]!, f]));

/** A's inbox, computed from the fixture alone: newest first, uuid DESC on a tie. */
const EXPECTED_A = ["a1", "a2", "a3", "a7", "a8", "a9", "a10", "a11", "a13"]
  .map((k) => ({ app: APP[k]!, t: FIXTURES.find((f) => f.key === k)!.t }))
  .sort((x, y) => (x.t !== y.t ? (x.t < y.t ? 1 : -1) : x.app < y.app ? 1 : -1))
  .map((r) => r.app);

const CTX: RequestContext = { correlationId: randomUUID(), requestId: `inbox-db-${TAG}` };

describe.skipIf(!RUN)("GET /payer/reach/applicants — against Postgres", () => {
  let client!: DbClient;
  let inbox!: PayerApplicantInboxService;
  let perPosting!: PayerApplicantsService;

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 2 });
    const events = new EventsService(new EventsRepository(client.db), {
      NODE_ENV: "test",
    } as never);
    const reach = new ReachService(new ReachRepository(client.db), events, {} as never);
    const candidates = new MatchCandidatesService(new MatchFeedRepository(client.db), {
      get: async () => DEFAULT_MATCH_CONFIG,
    } as never);
    // The per-posting route's own ownership seam for a posting, reduced to its WHERE (on the
    // scope's TENANT key, ADR-0053).
    const jobPostings = {
      getOneInScope: async (postingId: string, scope: PayerTenantScope) => {
        const rows = await client.sql`
          SELECT id FROM job_postings WHERE id = ${postingId}::uuid AND payer_id = ${scope.tenantKey}::uuid`;
        if (rows.length === 0) throw new NotFoundException("Job posting not found");
        return rows[0];
      },
    };
    // ADR-0053 — the default mode (off): every payer is their own tenant.
    const tenancy = defaultModeResolver();
    // Flag OFF (the default) — the flag-ON walk is payer-applicant-stages.db.test.ts.
    perPosting = new PayerApplicantsService(
      reach,
      jobPostings as never,
      candidates,
      stagesOff(),
      tenancy,
    );
    inbox = new PayerApplicantInboxService(
      new PayerApplicantInboxRepository(client.db),
      reach,
      candidates,
      { PAYER_APPLICANT_STAGES_ENABLED: false },
      tenancy,
    );
    await seed(client);
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await cleanup(client);
      await client.sql.end({ timeout: 5 });
    }
  });

  async function walk(payerId: string, limit: number, postingId?: string) {
    const rows: InboxApplicantRowDto[] = [];
    const pageSizes: number[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 100; i += 1) {
      const page = await inbox.list(
        payerId,
        { limit, postingId, cursor: cursor === undefined ? undefined : decodeInboxCursor(cursor)! },
        CTX,
      );
      rows.push(...page.applicants);
      pageSizes.push(page.applicants.length);
      if (page.nextCursor === null) return { rows, pageSizes };
      cursor = page.nextCursor;
    }
    throw new Error("pagination never ended");
  }

  /** The application a row stands for: company rows carry it; agency rows by (job, worker). */
  function appOf(row: InboxApplicantRowDto): string {
    if (row.posting.kind === "company_posting")
      return (row as { applicationId: string }).applicationId;
    const f = FIXTURES.find((x) => x.jobId === row.posting.id && x.worker === row.workerId)!;
    return APP[f.key]!;
  }

  it("the fixture's expectation is non-trivial (a guard against a vacuous suite)", () => {
    expect(EXPECTED_A).toHaveLength(9);
    // The cross-arm same-microsecond tie is really in A's set.
    expect(byApp.get(APP.a7!)!.t).toBe(byApp.get(APP.a8!)!.t);
  });

  it.each([1, 2, 4, 50])(
    "A's walk at page size %i: every applicant once, newest first, id tiebreak",
    async (limit) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-07T00:00:00.000Z"));
      try {
        const { rows, pageSizes } = await walk(PAYER_A, limit);
        expect(rows.map(appOf)).toEqual(EXPECTED_A);
        expect(new Set(rows.map(appOf)).size).toBe(rows.length);
        for (const size of pageSizes.slice(0, -1)) expect(size).toBe(limit);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("ownership: nothing of B's reaches A, and B sees only B's", async () => {
    const a = JSON.stringify((await walk(PAYER_A, 50)).rows);
    for (const foreign of [JOB_B, POST_B, W.w9!, W.w10!, APP.a14!, APP.a15!])
      expect(a).not.toContain(foreign);
    const b = (await walk(PAYER_B, 50)).rows;
    expect(b.map(appOf).sort()).toEqual([APP.a14!, APP.a15!].sort());
  });

  it("membership: no skip, no leaver, no profile-less agency applier; one row per application", async () => {
    const rows = (await walk(PAYER_A, 50)).rows;
    const apps = rows.map(appOf);
    for (const k of ["a4", "a5", "a6", "a12", "a16"]) expect(apps).not.toContain(APP[k]);
    // w3 has two profile rows: still one row for his one application.
    expect(rows.filter((r) => r.workerId === W.w3)).toHaveLength(1);
    // w1 applied twice (agency + company): two rows.
    expect(
      rows
        .filter((r) => r.workerId === W.w1)
        .map((r) => r.posting.kind)
        .sort(),
    ).toEqual(["agency_job", "company_posting"]);
    // Both references → once, as the agency job.
    const both = rows.filter((r) => r.workerId === W.both);
    expect(both).toHaveLength(1);
    expect(both[0]!.posting).toEqual({
      id: JOB_A2,
      title: `Inbox job A2 ${TAG}`,
      kind: "agency_job",
    });
  });

  it("postingId: owned → only it; B's, unknown, or owned-but-empty → the same empty page", async () => {
    const only = (await walk(PAYER_A, 2, POST_A1)).rows;
    expect(only.map(appOf)).toEqual(
      EXPECTED_A.filter((a) => byApp.get(a)!.postingId === POST_A1 && byApp.get(a)!.jobId === null),
    );
    expect(only.every((r) => r.posting.id === POST_A1)).toBe(true);
    const job = (await walk(PAYER_A, 2, JOB_A1)).rows;
    expect(job.map(appOf).sort()).toEqual([APP.a1!, APP.a2!, APP.a3!].sort());
    const NEUTRAL = { applicants: [], nextCursor: null };
    for (const postingId of [POST_B, JOB_B, randomUUID(), POST_A_EMPTY]) {
      expect(
        await inbox.list(PAYER_A, { limit: 20, postingId, cursor: undefined }, CTX),
      ).toStrictEqual(NEUTRAL);
    }
  });

  it("PARITY: every row minus `posting` is the per-posting route's row for that applicant", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T00:00:00.000Z"));
    try {
      const rows = (await walk(PAYER_A, 3)).rows;
      expect(rows).toHaveLength(EXPECTED_A.length);
      for (const row of rows) {
        const { posting, ...rest } = row;
        const list = await perPosting.listForOwned(posting.id, PAYER_A, CTX);
        const twin = (list.applicants as unknown as Record<string, unknown>[]).find((a) =>
          posting.kind === "agency_job"
            ? a.workerId === rest.workerId
            : a.applicationId === (rest as { applicationId: string }).applicationId,
        );
        expect(twin, `${posting.kind} row for ${rest.workerId}`).toBeDefined();
        expect(rest).toStrictEqual(twin);
      }
      // Not vacuous: POST_A1's ranks are not its arrival order.
      const a1 = rows.filter((r) => r.posting.id === POST_A1).map((r) => [appOf(r), r.rank]);
      expect(a1).toEqual([
        [APP.a10, 3],
        [APP.a9, 1],
        [APP.a8, 2],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("DEFENCE IN DEPTH: each detail read is owner-scoped on its own, whatever ids it is handed", async () => {
    // The page read already scopes to the session payer; these prove the second layer holds on
    // Postgres too, so a page-SQL regression still cannot render another payer's applicant.
    const matchRepo = new MatchFeedRepository(client.db);
    const reachRepo = new ReachRepository(client.db);
    const floor = DEFAULT_MATCH_CONFIG.tierFloorMonths;
    const [keyA, keyB] = [await ownTenantKey(PAYER_A), await ownTenantKey(PAYER_B)];
    expect(
      await matchRepo.listRankedCandidatesByApplication(keyA, [POST_B], [APP.a15!], floor),
    ).toEqual([]);
    expect(await reachRepo.findOwnedJobSignalRowsByIds([JOB_B], keyA)).toEqual([]);
    // CONTROL: the owner gets them.
    expect(
      await matchRepo.listRankedCandidatesByApplication(keyB, [POST_B], [APP.a15!], floor),
    ).toHaveLength(1);
    expect(await reachRepo.findOwnedJobSignalRowsByIds([JOB_B], keyB)).toHaveLength(1);
  });

  it("events: one validated feed.shown per AGENCY row shown, payer actor; none for company rows", async () => {
    const corr = randomUUID();
    const ctx = { ...CTX, correlationId: corr };
    const page = await inbox.list(
      PAYER_A,
      { limit: 50, postingId: undefined, cursor: undefined },
      ctx,
    );
    const agency = page.applicants.filter((r) => r.posting.kind === "agency_job") as Array<
      InboxApplicantRowDto & { score: number; hot: boolean }
    >;
    const written = await client.sql<
      {
        event_name: string;
        actor_type: string;
        actor_id: string;
        payload: Record<string, unknown>;
      }[]
    >`
      SELECT event_name, actor_type, actor_id, payload FROM events WHERE correlation_id = ${corr}::uuid`;
    expect(written).toHaveLength(agency.length);
    expect(agency.length).toBe(5);
    for (const e of written) {
      expect(e.event_name).toBe("feed.shown");
      expect(e.actor_type).toBe("payer");
      expect(e.actor_id).toBe(PAYER_A);
      const row = agency.find(
        (r) => r.workerId === e.payload.worker_id && r.posting.id === e.payload.job_id,
      )!;
      expect(row).toBeDefined();
      expect(e.payload).toEqual({
        worker_id: row.workerId,
        job_id: row.posting.id,
        rank: row.rank,
        score: row.score,
        hot: row.hot,
      });
    }
    await client.sql`DELETE FROM events WHERE correlation_id = ${corr}::uuid`;
  });
});

async function seed(client: DbClient): Promise<void> {
  const { sql } = client;
  for (const [jobId, payer, title] of [
    [JOB_A1, PAYER_A, `Inbox job A1 ${TAG}`],
    [JOB_A2, PAYER_A, `Inbox job A2 ${TAG}`],
    [JOB_B, PAYER_B, `Inbox job B ${TAG}`],
  ] as const) {
    await sql`
      INSERT INTO jobs (id, trade_key, title, city, status, payer_id, min_experience_years, pay_min, pay_max)
      VALUES (${jobId}::uuid, 'cnc_vmc', ${title}, 'pune', 'open', ${payer}::uuid, 1, 18000, 30000)`;
  }
  for (const [postingId, payer, title] of [
    [POST_A1, PAYER_A, `Inbox posting A1 ${TAG}`],
    [POST_A2, PAYER_A, `Inbox posting A2 ${TAG}`],
    [POST_A_EMPTY, PAYER_A, `Inbox posting A-empty ${TAG}`],
    [POST_B, PAYER_B, `Inbox posting B ${TAG}`],
  ] as const) {
    await sql`
      INSERT INTO job_postings (id, created_by, payer_id, org_label, role_title, vacancy_band, status,
                                match_skill_ids, reach_skill_ids, published_at)
      VALUES (${postingId}::uuid, ${OPS}::uuid, ${payer}::uuid, 'Inbox Fixture', ${title}, '1', 'open',
              '["mskill_vmc_operator"]'::jsonb, '["mskill_vmc_operator"]'::jsonb, now())`;
  }
  for (const [k, workerId] of Object.entries(W)) {
    await sql`
      INSERT INTO workers (id, phone_e164, phone_hash, status, deletion_scheduled_at)
      VALUES (${workerId}::uuid, ${`enc:inbox-${TAG}-${k}`}, ${`hash:inbox-${TAG}-${k}`}, 'active',
              ${k === "leaver" ? sql`now() + interval '7 days'` : null})`;
    if (k === "noprof") continue;
    const n = Number.parseInt(k.replace(/\D/g, ""), 10) || 3;
    await sql`
      INSERT INTO worker_profiles (worker_id, profile_status, canonical_role_id, canonical_trade_id,
                                   experience, location_preference, availability)
      VALUES (${workerId}::uuid, 'extracted', ${n % 2 === 0 ? "vmc_operator" : "welder"},
              ${n % 2 === 0 ? "cnc_vmc" : "fabrication"}, ${JSON.stringify({ total_years: n })}::jsonb,
              ${JSON.stringify({ preferred_cities: ["pune"] })}::jsonb, ${JSON.stringify({ status: "immediate" })}::jsonb)`;
    if (k === "w3") {
      // A second, OLDER draft row: the current-profile pick must keep the one above.
      await sql`
        INSERT INTO worker_profiles (worker_id, profile_status, created_at)
        VALUES (${workerId}::uuid, 'draft', now() - interval '30 days')`;
    }
  }
  for (const f of FIXTURES) {
    await sql`
      INSERT INTO applications (id, worker_id, job_id, job_posting_id, action, source_surface,
                                match_tier, skill_months, industry_months, last_worked_at,
                                engine_version, created_at)
      VALUES (${APP[f.key]!}::uuid, ${f.worker}::uuid, ${f.jobId}::uuid, ${f.postingId}::uuid,
              ${f.action}, 'feed', ${f.tier ?? null}, ${f.skill ?? null}, ${f.industry ?? null},
              ${f.lastWorked ?? null}::date, ${f.postingId ? "v1.0" : null}, ${f.t}::timestamptz)`;
  }
}

async function cleanup(client: DbClient): Promise<void> {
  const { sql } = client;
  const workers = Object.values(W);
  await sql`DELETE FROM applications WHERE worker_id = ANY(${workers}::uuid[])`;
  await sql`DELETE FROM worker_profiles WHERE worker_id = ANY(${workers}::uuid[])`;
  await sql`DELETE FROM events WHERE correlation_id = ${CTX.correlationId}::uuid`;
  await sql`DELETE FROM workers WHERE id = ANY(${workers}::uuid[])`;
  await sql`DELETE FROM jobs WHERE id = ANY(${[JOB_A1, JOB_A2, JOB_B]}::uuid[])`;
  await sql`DELETE FROM job_postings WHERE id = ANY(${[POST_A1, POST_A2, POST_A_EMPTY, POST_B]}::uuid[])`;
}
