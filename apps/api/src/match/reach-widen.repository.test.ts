import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "@badabhai/db";
import { ReachWidenRepository } from "./reach-widen.repository";

/**
 * DB-backed regression test for `activeIdsForPostings` (Policy 27, migration 0090).
 *
 * Found in independent post-merge review of PR #1204: the method computed the
 * "still-active, must-stay-protected" skill-id set used by
 * `PublishReachService.retractExpiredWidens` to decide what NOT to subtract when a widen
 * grant expires, but it read EVERY `job_reach_widen` row for the posting — retracted or
 * not — instead of only the still-active ones. `findDueBatch` and `countDue` both filter
 * on `isNull(retracted_at)`; this method silently didn't.
 *
 * EFFECT: a posting that has ever had more than one widen grant for overlapping skills
 * would permanently "protect" an expired skill via its own old, already-retracted row,
 * so a later re-widen of that same skill could never actually expire again. This test
 * reproduces exactly that shape — one retracted row and one active row on the same
 * posting, overlapping skill ids — and pins that a retracted row's ids are excluded.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   pnpm db:up && pnpm db:migrate
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api test -- reach-widen.repository
 *
 * SKIPS by default so `pnpm --filter @badabhai/api test` stays DB-free.
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const POSTING = uuid(9101);
const PAYER = uuid(9201);
const OPS = uuid(9301);
const RETRACTED_ROW = uuid(9401);
const ACTIVE_ROW = uuid(9402);

// Overlapping on purpose: the retracted row's own id (SKILL_STALE) must NOT survive into
// the protection set even though the active row also mentions a DIFFERENT id
// (SKILL_LIVE) — the fix must not simply drop the whole table into the result, and it
// must not drop the genuinely active row's ids either.
const SKILL_STALE = "mskill_cnc_turner";
const SKILL_LIVE = "mskill_hmc_operator";

describe.skipIf(!RUN)("ReachWidenRepository.activeIdsForPostings — excludes retracted rows", () => {
  let client: DbClient;
  let repo: ReachWidenRepository;

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 1 });
    repo = new ReachWidenRepository(client.db);
    await seed(client);
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await cleanup(client);
      await client.sql.end({ timeout: 5 });
    }
  });

  it("does not protect a skill id whose only widen row is already retracted", async () => {
    const active = await repo.activeIdsForPostings([POSTING], []);
    expect(active.has(SKILL_STALE)).toBe(false);
  });

  it("still protects a skill id from a genuinely active row", async () => {
    const active = await repo.activeIdsForPostings([POSTING], []);
    expect(active.has(SKILL_LIVE)).toBe(true);
  });

  it("excludes the caller's own batch rows by id, as the sweep relies on", async () => {
    const active = await repo.activeIdsForPostings([POSTING], [ACTIVE_ROW]);
    expect(active.has(SKILL_LIVE)).toBe(false);
    expect(active.has(SKILL_STALE)).toBe(false);
  });
});

async function seed(client: DbClient): Promise<void> {
  const { sql } = client;
  await cleanup(client);

  for (const skillId of [SKILL_STALE, SKILL_LIVE]) {
    await sql`
      INSERT INTO skill (skill_id, label_en, domain_id, source, status, kind, industry_id)
      VALUES (${skillId}, ${skillId}, 'cnc-machining', 'rvm', 'active', 'match_skill',
              'ind_industrial_manufacturing')
      ON CONFLICT (skill_id) DO NOTHING
    `;
  }

  await sql`
    INSERT INTO workers (id, phone_e164, phone_hash, status)
    VALUES (${PAYER}::uuid, 'enc:reach-widen-repo-payer', 'hash:reach-widen-repo-payer', 'active')
    ON CONFLICT (id) DO NOTHING
  `;

  await sql`
    INSERT INTO job_postings (id, created_by, payer_id, org_label, role_title, vacancy_band,
                              status, match_skill_ids, reach_skill_ids, published_at)
    VALUES (${POSTING}::uuid, ${PAYER}::uuid, ${PAYER}::uuid, 'Repo Fixture', 'VMC Operator', '1',
            'open', '["mskill_vmc_operator"]'::jsonb,
            ${`["${SKILL_STALE}", "${SKILL_LIVE}"]`}::jsonb, now())
  `;

  // The RETRACTED row: added SKILL_STALE, but its grant has already been retracted. Its
  // id must not survive into the protection set.
  await sql`
    INSERT INTO job_reach_widen (id, job_posting_id, added_skill_ids, expires_at, retracted_at, ops_actor_id)
    VALUES (${RETRACTED_ROW}::uuid, ${POSTING}::uuid, ${`["${SKILL_STALE}"]`}::jsonb,
            now() - interval '2 hours', now() - interval '1 hour', ${OPS}::uuid)
  `;

  // The ACTIVE row: added SKILL_LIVE, still in force (no retracted_at).
  await sql`
    INSERT INTO job_reach_widen (id, job_posting_id, added_skill_ids, expires_at, retracted_at, ops_actor_id)
    VALUES (${ACTIVE_ROW}::uuid, ${POSTING}::uuid, ${`["${SKILL_LIVE}"]`}::jsonb,
            now() + interval '10 hours', NULL, ${OPS}::uuid)
  `;
}

async function cleanup(client: DbClient): Promise<void> {
  const { sql } = client;
  await sql`DELETE FROM job_reach_widen WHERE job_posting_id = ${POSTING}::uuid`;
  await sql`DELETE FROM job_reach WHERE job_posting_id = ${POSTING}::uuid`;
  await sql`DELETE FROM job_postings WHERE id = ${POSTING}::uuid`;
  await sql`DELETE FROM workers WHERE id = ${PAYER}::uuid`;
}
