import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "@badabhai/db";

import { ApplicationsRepository } from "./applications.repository";
import { ApplicationsService } from "./applications.service";
import type { EventsService } from "../events/events.service";

/**
 * THE APPLIED-TAB SUBTITLE, AGAINST A REAL POSTGRES — the join that feeds it, and the two
 * properties a mocked drizzle handle cannot check.
 *
 * WHY THIS FILE EXISTS. #1027 and #1051 were the same defect twice, a day apart, and both
 * shipped green. `#1027` swapped the subtitle to `matched_skill_label`, a field the API never
 * sent — every one of the 17 live applications lost its trade line, and the widget tests
 * passed because they BUILT `AppliedJob(...)` with the label supplied and so never met a real
 * response body. The lesson is not "write more widget tests". It is that the contract between
 * the query, the mapper and the client had no test that saw all three at once.
 *
 * TWO PROPERTIES OF POSTGRES, NOT OF TYPESCRIPT:
 *
 *   1. THE REACH JOIN CANNOT FAN OUT. `job_reach`'s PK is (job_posting_id, worker_id), so the
 *      join must use BOTH. Use only `worker_id` and every V1 decision is multiplied by the
 *      number of postings that worker can reach — a duplicate card per reach row. It is
 *      invisible in any fixture where the worker has ONE reach row, which is every fixture
 *      anyone writes by hand, so this one deliberately gives him THREE and applies to one.
 *
 *   2. A LEGACY DECISION SURVIVES IT. All 17 live applications are legacy `jobs` rows with no
 *      reach row at all. An INNER join here empties the Applied tab outright — a worse
 *      regression than the one it would be fixing.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api run test applied-subtitle.db
 *
 * Runs in CI as one of the DB-backed gates in `ci.yml`, which asserts per-file that it
 * EXECUTED rather than skipped — a `skipIf` gate that never armed is a disclosed gap, not a
 * pass.
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const WORKER = uuid(0x5101);
const PAYER = uuid(0x5201);
/** Applied to. The other two are reach-only, and they are the fan-out bait. */
const POSTING_APPLIED = uuid(0x5301);
const POSTING_REACH_ONLY_A = uuid(0x5302);
const POSTING_REACH_ONLY_B = uuid(0x5303);
const LEGACY_JOB = uuid(0x5401);

/**
 * A REAL match-skill id, not a synthetic one. `matchSkillLabel` is a closed-set lookup over
 * the shipped corpus, so a made-up id would exercise the null branch and quietly prove
 * nothing about the branch that matters.
 */
const SKILL = "mskill_mig_welder";
const SKILL_LABEL = "MIG Welder";
const INDUSTRY = "manufacturing";

describe.skipIf(!RUN)("Applied-tab subtitle: the reach join and the label seam (#1027, #1051)", () => {
  let client!: DbClient;
  let repo!: ApplicationsRepository;
  let service!: ApplicationsService;

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 1 });
    await seed(client);
    repo = new ApplicationsRepository(client.db);
    service = new ApplicationsService(
      repo,
      {} as unknown as EventsService,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  afterAll(async () => {
    if (client !== undefined) {
      await cleanup(client);
      await client.sql.end();
    }
  });

  it("returns ONE row per decision, though the worker holds three reach rows", async () => {
    // Property 1. With `eq(jobReach.workerId, …)` alone this is 4 (3 reach rows against the
    // V1 decision, plus the legacy one) and the worker sees the same card three times.
    const rows = await repo.findApplicationsByWorker(WORKER);

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.jobId)).size).toBe(2);
  });

  it("keeps the legacy decision, which has no reach row at all", async () => {
    // Property 2 — and the 17 live rows are all of this shape.
    const rows = await repo.findApplicationsByWorker(WORKER);
    const legacy = rows.find((r) => r.jobId === LEGACY_JOB);

    expect(legacy).toBeDefined();
    expect(legacy!.tradeKey).toBe("fitter");
    expect(legacy!.matchedSkillId).toBeNull();
  });

  it("carries the reach row's matched skill for the V1 decision", async () => {
    const rows = await repo.findApplicationsByWorker(WORKER);
    const v1 = rows.find((r) => r.jobId === POSTING_APPLIED);

    expect(v1).toBeDefined();
    // The V1 half of #1051: `job_postings` has no trade key, so without the reach join this
    // decision has NOTHING to say about the work.
    expect(v1!.tradeKey).toBeNull();
    expect(v1!.matchedSkillId).toBe(SKILL);
  });

  it("hands the client a LABEL for the V1 row and never the id", async () => {
    const out = await service.applicationsForWorker(WORKER);
    const v1 = out.applications.find((a) => a.job_id === POSTING_APPLIED)!;

    expect(v1.matched_skill_label).toBe(SKILL_LABEL);
    // `trade_key` is exempt by contract and is NULL here anyway; nothing else may carry an id.
    const { trade_key: _t, ...renderable } = v1;
    expect(JSON.stringify(renderable)).not.toContain("mskill_");
  });

  it("gives the legacy row a null label, so the client can fall back to its trade", async () => {
    const out = await service.applicationsForWorker(WORKER);
    const legacy = out.applications.find((a) => a.job_id === LEGACY_JOB)!;

    expect(legacy.matched_skill_label).toBeNull();
    expect(legacy.trade_key).toBe("fitter");
  });

  it("every returned row can render a subtitle — the #1051 regression, stated as a property", async () => {
    // What actually broke: a card whose subtitle had neither a label nor a usable trade, so it
    // rendered the place alone. Both shapes must yield something, by DIFFERENT routes.
    const out = await service.applicationsForWorker(WORKER);
    expect(out.applications).toHaveLength(2);

    for (const a of out.applications) {
      const renderable =
        a.matched_skill_label ??
        (a.trade_key !== null && !a.trade_key.startsWith("mskill_") ? a.trade_key : null);
      expect(renderable, `no subtitle source for job ${String(a.job_id)}`).not.toBeNull();
    }
  });
});

async function seed(client: DbClient): Promise<void> {
  const { sql } = client;
  await cleanup(client);

  // `job_reach.matched_skill_id` FKs to `skill`. Present already on a seeded database; the
  // upsert makes the fixture self-sufficient on a bare migrated one and is a no-op otherwise.
  await sql`
    INSERT INTO skill (skill_id, label_en, domain_id, source, status, kind, industry_id)
    VALUES (${SKILL}, ${SKILL_LABEL}, 'welding', 'rvm', 'active', 'match_skill', ${INDUSTRY})
    ON CONFLICT (skill_id) DO NOTHING
  `;

  // Synthetic markers only — no real phone number exists in this fixture, so it cannot leak
  // or resemble PII even in a shared database.
  await sql`
    INSERT INTO workers (id, phone_e164, phone_hash, status)
    VALUES (${WORKER}::uuid, 'enc:applied-subtitle', 'hash:applied-subtitle', 'active')
    ON CONFLICT (id) DO NOTHING
  `;

  for (const id of [POSTING_APPLIED, POSTING_REACH_ONLY_A, POSTING_REACH_ONLY_B]) {
    await sql`
      INSERT INTO job_postings (id, created_by, payer_id, org_label, role_title, vacancy_band,
                                status, match_skill_ids, reach_skill_ids, published_at)
      VALUES (${id}::uuid, ${PAYER}::uuid, ${PAYER}::uuid, 'Applied Subtitle Fixture',
              'MIG Welder', '1', 'open', ${`["${SKILL}"]`}::jsonb, ${`["${SKILL}"]`}::jsonb, now())
    `;
    // THREE reach rows for ONE worker. This is the fixture detail the fan-out test needs: a
    // worker who can reach only the posting he applied to proves nothing about the join key.
    await sql`
      INSERT INTO job_reach (job_posting_id, worker_id, match_tier, matched_skill_id)
      VALUES (${id}::uuid, ${WORKER}::uuid, 1, ${SKILL})
    `;
  }

  await sql`
    INSERT INTO jobs (id, trade_key, title, city, status)
    VALUES (${LEGACY_JOB}::uuid, 'fitter', 'Fitter — Day Shift', 'Pune', 'open')
  `;

  // One decision on each surface. The other two postings stay reach-only ON PURPOSE.
  await sql`
    INSERT INTO applications (worker_id, job_posting_id, action, source_surface)
    VALUES (${WORKER}::uuid, ${POSTING_APPLIED}::uuid, 'applied', 'feed')
  `;
  await sql`
    INSERT INTO applications (worker_id, job_id, action, source_surface)
    VALUES (${WORKER}::uuid, ${LEGACY_JOB}::uuid, 'applied', 'feed')
  `;
}

async function cleanup(client: DbClient): Promise<void> {
  const { sql } = client;
  await sql`DELETE FROM applications WHERE worker_id = ${WORKER}::uuid`;
  await sql`DELETE FROM job_reach WHERE worker_id = ${WORKER}::uuid`;
  for (const id of [POSTING_APPLIED, POSTING_REACH_ONLY_A, POSTING_REACH_ONLY_B]) {
    await sql`DELETE FROM job_postings WHERE id = ${id}::uuid`;
  }
  await sql`DELETE FROM jobs WHERE id = ${LEGACY_JOB}::uuid`;
  await sql`DELETE FROM workers WHERE id = ${WORKER}::uuid`;
}
