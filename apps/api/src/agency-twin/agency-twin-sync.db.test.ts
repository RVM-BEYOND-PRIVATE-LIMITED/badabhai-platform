import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AGENCY_TWIN_ORG_LABEL, AGENCY_TWIN_SYSTEM_ACTOR_ID } from "@badabhai/config";
import { createDbClient, type DbClient } from "@badabhai/db";

import type { RequestContext } from "../common/request-context";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { MatchApplyService } from "../match/match-apply.service";
import { MatchConfigRepository } from "../match/match-config.repository";
import { MatchConfigService } from "../match/match-config.service";
import { MatchFeedRepository } from "../match/match-feed.repository";
import { WorkerSkillsRepository } from "../match/worker-skills.repository";
import { ApplicationsRepository } from "../applications/applications.repository";
import { ApplicationsService } from "../applications/applications.service";
import { AgencyTwinRepository } from "./agency-twin.repository";
import { AgencyTwinService } from "./agency-twin.service";

/**
 * ADR-0050 — THE AGENCY TWIN, AGAINST A REAL POSTGRES (#1957).
 *
 * The unit tests prove what the sync PLANS and what each statement SAYS. Only a database proves
 * the parts that are about evaluation:
 *
 *   - migration 0132's CHECKs really refuse an agent-owned or unlinked twin;
 *   - `FOR UPDATE OF jobs` over the agent join, the insert, the diffed update and the in-tx
 *     `job_reach` materialization run, and an unchanged source writes and emits NOTHING;
 *   - every write persists exactly one VALIDATED `job_posting.twin_synced` on its own tx;
 *   - V1 off stages `draft`; V1 on mirrors the source; an empty pick is a refused `paused` twin;
 *   - the kill switch pauses every non-closed twin in one statement;
 *   - the V1 feed serves a twin only while its SOURCE is open, keys its interleave on the
 *     agency, and hides it from a worker who decided on the source;
 *   - a V1 apply on a twin lands on the SOURCE id with the twin's rank snapshot, bumps the
 *     source's counter, and is the neutral 404 once the source closes.
 *
 * THE REAL STACK: the shipped repositories, EventsService (validated + persisted) and services.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api run test agency-twin-sync.db
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

const CTX: RequestContext = { correlationId: uuid(0x19570001), requestId: "agency-twin-db" };

const WORKER = uuid(0x19571001);
const AGENCY = uuid(0x19572001);
const EMPLOYER = uuid(0x19572002);

const SKILL = "mskill_vmc_operator";
const INDUSTRY = "ind_industrial_manufacturing";

const J_OPEN = uuid(0x19573001); // agency, open, picked SKILL
const J_EMPTY = uuid(0x19573002); // agency, open, no pick yet
const J_CLOSED = uuid(0x19573003); // agency, closed
const J_SEED = uuid(0x19573004); // seed row (payer_id NULL) — never twinned
const J_EMPLOYER = uuid(0x19573005); // legacy employer-owned row — not an agency job
const ALL_JOBS = [J_OPEN, J_EMPTY, J_CLOSED, J_SEED, J_EMPLOYER];
const AGENCY_JOBS = [J_OPEN, J_EMPTY, J_CLOSED];

function twinService(client: DbClient, flags: { armed: boolean; v1: boolean }): AgencyTwinService {
  return new AgencyTwinService(
    new AgencyTwinRepository(client.db),
    new EventsService(new EventsRepository(client.db), { NODE_ENV: "test" } as never),
    new MatchConfigService(new MatchConfigRepository(client.db)),
    { AGENCY_TWIN_SYNC_ENABLED: flags.armed, MATCH_V1_ENABLED: flags.v1 } as never,
  );
}

describe.skipIf(!RUN)("ADR-0050 agency twin sync, against Postgres", () => {
  let client!: DbClient;

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 1 });
    await cleanup(client);
    await seed(client);
  }, 60_000);

  afterAll(async () => {
    if (client !== undefined) {
      await cleanup(client);
      await client.sql.end({ timeout: 5 });
    }
  });

  beforeEach(async () => {
    await resetTwins(client);
  });

  async function twinOf(jobId: string) {
    const rows = await client.sql<
      {
        id: string;
        status: string;
        payer_id: string | null;
        created_by: string;
        org_label: string;
        sync_source: string | null;
        role_title: string;
        match_skill_ids: string[];
        reach_skill_ids: string[];
        published_at: Date | null;
      }[]
    >`SELECT id, status, payer_id, created_by, org_label, sync_source, role_title,
             match_skill_ids, reach_skill_ids, published_at
        FROM job_postings WHERE source_job_id = ${jobId}::uuid`;
    return rows[0];
  }

  async function twinEvents(jobId: string) {
    return client.sql<{ subject_id: string; payload: Record<string, unknown> }[]>`
      SELECT subject_id, payload FROM events
       WHERE event_name = 'job_posting.twin_synced' AND payload->>'source_job_id' = ${jobId}
       ORDER BY occurred_at`;
  }

  it("V1 off: stages a system-owned DRAFT twin per agency job, evented once, and nothing for other rows", async () => {
    const svc = twinService(client, { armed: true, v1: false });
    for (const id of ALL_JOBS) await svc.syncJob(id);

    const twin = (await twinOf(J_OPEN))!;
    expect(twin).toMatchObject({
      status: "draft",
      payer_id: null,
      created_by: AGENCY_TWIN_SYSTEM_ACTOR_ID,
      org_label: AGENCY_TWIN_ORG_LABEL,
      sync_source: "agency_job",
      role_title: "VMC Operator — Agency Twin Fixture",
      published_at: null,
    });
    expect(twin.match_skill_ids).toEqual([SKILL]);
    expect(await twinOf(J_SEED)).toBeUndefined(); // seed rows stay D4's
    expect(await twinOf(J_EMPLOYER)).toBeUndefined(); // not an agency job
    const evs = await twinEvents(J_OPEN);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload).toMatchObject({
      operation: "created",
      status: "draft",
      refused_reason: null,
    });
  });

  it("is idempotent: an unchanged source writes nothing and emits nothing", async () => {
    const svc = twinService(client, { armed: true, v1: false });
    await svc.syncJob(J_OPEN);
    const before = (await twinOf(J_OPEN))!;
    const again = await svc.syncJob(J_OPEN);
    expect(again).toMatchObject({ kind: "unchanged", jobPostingId: before.id });
    expect(await twinEvents(J_OPEN)).toHaveLength(1);
  });

  it("V1 on: mirrors the source — open serves (published, reach materialized), empty pick is a refused pause, closed closes", async () => {
    const svc = twinService(client, { armed: true, v1: true });
    for (const id of AGENCY_JOBS) await svc.syncJob(id);

    const open = (await twinOf(J_OPEN))!;
    expect(open.status).toBe("open");
    expect(open.published_at).not.toBeNull();
    const reach = await client.sql<{ match_tier: number }[]>`
      SELECT match_tier FROM job_reach WHERE job_posting_id = ${open.id}::uuid AND worker_id = ${WORKER}::uuid`;
    expect(reach).toEqual([{ match_tier: 1 }]);

    const empty = (await twinOf(J_EMPTY))!;
    expect(empty.status).toBe("paused");
    expect(empty.match_skill_ids).toEqual([]);
    expect((await twinEvents(J_EMPTY)).at(-1)!.payload).toMatchObject({
      // Born unservable → reported as a refusal (the CI 37487401977 regression).
      operation: "refused",
      status: "paused",
      refused_reason: "no_match_skills",
    });

    expect((await twinOf(J_CLOSED))!.status).toBe("closed");
  });

  it("an agency edit (a new pick) reaches the twin on the next sync, re-materializing its reach", async () => {
    const svc = twinService(client, { armed: true, v1: true });
    await svc.syncJob(J_EMPTY);
    try {
      await client.sql`UPDATE jobs SET match_skill_ids = ${JSON.stringify([SKILL])}::jsonb WHERE id = ${J_EMPTY}::uuid`;
      const out = await svc.syncJob(J_EMPTY);
      expect(out).toMatchObject({ kind: "written", status: "open" });
      const twin = (await twinOf(J_EMPTY))!;
      const reach = await client.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM job_reach WHERE job_posting_id = ${twin.id}::uuid`;
      expect(reach[0]!.n).toBeGreaterThan(0);
    } finally {
      await client.sql`UPDATE jobs SET match_skill_ids = '[]'::jsonb WHERE id = ${J_EMPTY}::uuid`;
    }
  });

  it("the kill switch pauses every non-closed twin in one statement, and re-arming restores them", async () => {
    await twinService(client, { armed: true, v1: true }).syncJob(J_OPEN);
    await twinService(client, { armed: true, v1: true }).syncJob(J_CLOSED);
    const summary = await twinService(client, { armed: false, v1: true }).sweep();
    expect(summary.disarmed).toBeGreaterThanOrEqual(1);
    expect((await twinOf(J_OPEN))!.status).toBe("paused");
    expect((await twinOf(J_CLOSED))!.status).toBe("closed");
    expect((await twinEvents(J_OPEN)).at(-1)!.payload).toMatchObject({
      operation: "refused",
      refused_reason: "kill_switch",
    });
    await twinService(client, { armed: true, v1: true }).syncJob(J_OPEN);
    expect((await twinOf(J_OPEN))!.status).toBe("open");
  });

  it("migration 0132's CHECKs refuse an agent-owned or unlinked twin (C2 in the database)", async () => {
    await expect(client.sql`
      INSERT INTO job_postings (created_by, payer_id, org_label, role_title, vacancy_band, status,
                                source_job_id, sync_source)
      VALUES (${AGENCY_TWIN_SYSTEM_ACTOR_ID}::uuid, ${AGENCY}::uuid, 'x', 'x', '1', 'draft',
              ${J_SEED}::uuid, 'agency_job')`).rejects.toThrow(/job_postings_twin_owner_chk/);
    await expect(client.sql`
      INSERT INTO job_postings (created_by, org_label, role_title, vacancy_band, status, sync_source)
      VALUES (${AGENCY_TWIN_SYSTEM_ACTOR_ID}::uuid, 'x', 'x', '1', 'draft', 'agency_job')`).rejects.toThrow(
      /job_postings_twin_owner_chk/,
    );
    await expect(client.sql`
      UPDATE jobs SET match_skill_ids = '{"a":1}'::jsonb WHERE id = ${J_SEED}::uuid`).rejects.toThrow(
      /jobs_match_skill_ids_array_chk/,
    );
  });

  describe("the V1 read and apply paths (ADR-0050 §4.4, §4.5)", () => {
    let feed!: MatchFeedRepository;
    let applications!: ApplicationsService;

    beforeEach(async () => {
      await twinService(client, { armed: true, v1: true }).syncJob(J_OPEN);
      feed = new MatchFeedRepository(client.db);
      const workerSkills = new WorkerSkillsRepository(client.db);
      applications = new ApplicationsService(
        new ApplicationsRepository(client.db),
        new EventsService(new EventsRepository(client.db), { NODE_ENV: "test" } as never),
        {} as never,
        new MatchApplyService(
          client.db,
          workerSkills,
          new MatchConfigService(new MatchConfigRepository(client.db)),
        ),
        { MATCH_V1_ENABLED: true, FEED_POSTINGS_UNION_ENABLED: false } as never,
        workerSkills,
      );
    });

    async function servedTwin(): Promise<{ id: string; payerKey: string } | undefined> {
      const twin = (await twinOf(J_OPEN))!;
      const rows = await feed.listFeed(WORKER, 500, {});
      const row = rows.find((r) => r.jobPostingId === twin.id);
      return row ? { id: row.jobPostingId, payerKey: row.payerKey } : undefined;
    }

    it("serves the twin, keyed on the AGENCY for the interleave (Q1), only while the source is open", async () => {
      expect(await servedTwin()).toMatchObject({ payerKey: AGENCY });
      try {
        await client.sql`UPDATE jobs SET status = 'paused' WHERE id = ${J_OPEN}::uuid`;
        expect(await servedTwin()).toBeUndefined(); // stale twin, source wins
      } finally {
        await client.sql`UPDATE jobs SET status = 'open' WHERE id = ${J_OPEN}::uuid`;
      }
    });

    it("a V1 apply on the twin lands on the SOURCE id with the twin's snapshot, and hides the twin", async () => {
      const twin = (await twinOf(J_OPEN))!;
      const before = await client.sql<{ n: number }[]>`
        SELECT applicants_received AS n FROM jobs WHERE id = ${J_OPEN}::uuid`;
      await applications.apply(WORKER, twin.id, { rank: 1, source_surface: "feed" }, CTX);

      const rows = await client.sql<
        {
          job_id: string | null;
          job_posting_id: string | null;
          match_tier: number | null;
          engine_version: string | null;
        }[]
      >`SELECT job_id, job_posting_id, match_tier, engine_version FROM applications
         WHERE worker_id = ${WORKER}::uuid AND (job_id = ${J_OPEN}::uuid OR job_posting_id = ${twin.id}::uuid)`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ job_id: J_OPEN, job_posting_id: null, match_tier: 1 });
      expect(rows[0]!.engine_version).not.toBeNull();

      const after = await client.sql<{ n: number }[]>`
        SELECT applicants_received AS n FROM jobs WHERE id = ${J_OPEN}::uuid`;
      expect(after[0]!.n).toBe(before[0]!.n + 1);

      const submitted = await client.sql<{ subject_type: string }[]>`
        SELECT subject_type FROM events WHERE idempotency_key = ${`application.submitted:${WORKER}:${J_OPEN}`}`;
      expect(submitted).toEqual([{ subject_type: "job" }]);

      expect(await servedTwin()).toBeUndefined(); // decided on the source → not re-served
    });

    it("an apply on a twin whose source is not open is the neutral 404, with nothing written", async () => {
      const twin = (await twinOf(J_OPEN))!;
      try {
        await client.sql`UPDATE jobs SET status = 'closed' WHERE id = ${J_OPEN}::uuid`;
        await expect(
          applications.apply(WORKER, twin.id, { rank: 1, source_surface: "feed" }, CTX),
        ).rejects.toThrow("Job not found");
        const rows = await client.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM applications WHERE worker_id = ${WORKER}::uuid`;
        expect(rows[0]!.n).toBe(0);
      } finally {
        await client.sql`UPDATE jobs SET status = 'open' WHERE id = ${J_OPEN}::uuid`;
      }
    });
  });
});

async function resetTwins(client: DbClient): Promise<void> {
  const { sql } = client;
  await sql`DELETE FROM applications WHERE worker_id = ${WORKER}::uuid`;
  await sql`UPDATE jobs SET applicants_received = 0 WHERE id = ANY(${ALL_JOBS}::uuid[])`;
  await sql`
    DELETE FROM events
     WHERE (event_name = 'job_posting.twin_synced' AND payload->>'source_job_id' = ANY(${ALL_JOBS}::text[]))
        OR correlation_id = ${CTX.correlationId}::uuid
        OR idempotency_key = ${`application.submitted:${WORKER}:${J_OPEN}`}`;
  await sql`
    DELETE FROM job_reach WHERE job_posting_id IN (
      SELECT id FROM job_postings WHERE source_job_id = ANY(${ALL_JOBS}::uuid[]))`;
  await sql`DELETE FROM job_postings WHERE source_job_id = ANY(${ALL_JOBS}::uuid[])`;
}

async function seed(client: DbClient): Promise<void> {
  const { sql } = client;
  await sql`
    INSERT INTO skill (skill_id, label_en, domain_id, source, status, kind, industry_id)
    VALUES (${SKILL}, 'VMC Operator', 'cnc-machining', 'rvm', 'active', 'match_skill', ${INDUSTRY})
    ON CONFLICT (skill_id) DO NOTHING`;
  // Synthetic markers only — no real phone, email or name exists in this fixture.
  await sql`
    INSERT INTO workers (id, phone_e164, phone_hash, status)
    VALUES (${WORKER}::uuid, 'enc:agency-twin-w', 'hash:agency-twin-w', 'active')
    ON CONFLICT (id) DO NOTHING`;
  await sql`
    INSERT INTO worker_skill (worker_id, skill_id, industry_id, months_bucketed, wants, source)
    VALUES (${WORKER}::uuid, ${SKILL}, ${INDUSTRY}, 48, true, 'derived_coarse')`;
  for (const [id, role, tag] of [
    [AGENCY, "agent", "a"],
    [EMPLOYER, "employer", "e"],
  ] as const) {
    await sql`
      INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status)
      VALUES (${id}::uuid, ${role}, ${`enc:agency-twin-${tag}`}, ${`hash:agency-twin-${tag}`},
              ${`enc:agency-twin-org-${tag}`}, 'active')
      ON CONFLICT (id) DO NOTHING`;
  }
  for (const [id, payer, status, picks] of [
    [J_OPEN, AGENCY, "open", [SKILL]],
    [J_EMPTY, AGENCY, "open", []],
    [J_CLOSED, AGENCY, "closed", [SKILL]],
    [J_SEED, null, "open", []],
    [J_EMPLOYER, EMPLOYER, "open", [SKILL]],
  ] as const) {
    await sql`
      INSERT INTO jobs (id, trade_key, title, city, status, payer_id, match_skill_ids, created_at)
      VALUES (${id}::uuid, 'machine_operator', 'VMC Operator — Agency Twin Fixture', 'Pune',
              ${status}, ${payer}::uuid, ${JSON.stringify(picks)}::jsonb, '2099-02-01T00:00:00Z')`;
  }
}

async function cleanup(client: DbClient): Promise<void> {
  const { sql } = client;
  await resetTwins(client);
  await sql`DELETE FROM jobs WHERE id = ANY(${ALL_JOBS}::uuid[])`;
  await sql`DELETE FROM payers WHERE id = ANY(${[AGENCY, EMPLOYER]}::uuid[])`;
  await sql`DELETE FROM worker_skill WHERE worker_id = ${WORKER}::uuid`;
  await sql`DELETE FROM workers WHERE id = ${WORKER}::uuid`;
}
