import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "@badabhai/db";
import { DEFAULT_MATCH_CONFIG } from "@badabhai/match-engine";
import { MatchFeedRepository } from "./match-feed.repository";

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE THREE BOOST FENCES (ADR-0036 §7) — the release gate that REPLACES BOOST-INERT.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Boost has been purchasable and ranking-inert since it shipped (TD42, guarded by
 * `reach.job-source.test.ts`). V1 retires that: a boost now lifts a card in the worker
 * feed. Money is allowed to order JOBS for a worker. It is never allowed to order
 * WORKERS for money, and it is never allowed to conjure supply.
 *
 * Three fences, each asserted against a REAL database rather than reasoned about,
 * because all three are properties of the SQL, not of a TypeScript function:
 *
 *   (a) BOOST NEVER PASSES THE SKILL GATE. A boosted posting does not appear in the
 *       feed of a worker who has no `job_reach` row for it. Boost permutes order within
 *       what the worker ALREADY qualified for (Policy 13, spec Part 2: visibility is
 *       two conditions and boost is neither of them).
 *   (b) BOOST PERMUTES ONLY. The feed SET is identical with and without a boost — same
 *       postings, same count, different order. A boost that changed the set would be
 *       selling visibility that the skill gate refused.
 *   (c) BOOST NEVER TOUCHES THE COMPANY'S LIST. The candidate list is byte-identical
 *       with and without an active boost. "Money orders jobs for workers; it never
 *       orders workers for money."
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   pnpm db:up && pnpm db:migrate
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api test -- boost-fences
 *
 * SKIPS by default so `pnpm --filter @badabhai/api test` stays DB-free. A skipped gate
 * is a disclosed gap, not a pass — it is visible in the run output.
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

// Two postings from DIFFERENT companies, so the max-2-per-company interleave cannot be
// what reorders them, and one worker who reaches BOTH plus one who reaches NEITHER.
const POSTING_A = uuid(8101); // the one that gets boosted
const POSTING_B = uuid(8102);
const PAYER_A = uuid(8201);
const PAYER_B = uuid(8202);
const WORKER_REACHED = uuid(8301); // has a job_reach row for both postings
const WORKER_UNREACHED = uuid(8302); // has NO job_reach row for either
// Fence (c) needs APPLICANTS on POSTING_A, and the feed excludes any posting the worker
// has already decided on — so the applicants MUST be different workers from the two
// above, or POSTING_A would (correctly) vanish from WORKER_REACHED's feed and fences
// (a) and (b) would be testing nothing.
const WORKER_APPLICANT_1 = uuid(8303);
const WORKER_APPLICANT_2 = uuid(8304);
const APP_1 = uuid(8401);
const APP_2 = uuid(8402);

const SKILL = "mskill_vmc_operator";
const FLOOR = DEFAULT_MATCH_CONFIG.tierFloorMonths;

describe.skipIf(!RUN)("Matching V1 — the three boost fences (ADR-0036 §7)", () => {
  let client: DbClient;
  let repo: MatchFeedRepository;

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 1 });
    repo = new MatchFeedRepository(client.db);
    await seed(client);
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await cleanup(client);
      await client.sql.end({ timeout: 5 });
    }
  });

  it("(a) a boosted posting NEVER appears in the feed of a worker with no job_reach row", async () => {
    await setBoost(client, POSTING_A, true);

    const reached = await repo.listFeed(WORKER_REACHED, 50, {});
    const unreached = await repo.listFeed(WORKER_UNREACHED, 50, {});

    // The boosted posting is served to the worker who passed the skill gate …
    expect(reached.map((r) => r.jobPostingId)).toContain(POSTING_A);
    expect(reached.find((r) => r.jobPostingId === POSTING_A)?.boosted).toBe(true);
    // … and to NOBODY else. Boost is not a visibility mechanism.
    expect(unreached.map((r) => r.jobPostingId)).not.toContain(POSTING_A);
    expect(unreached).toHaveLength(0);
  });

  it("(b) boost permutes ORDER only — the feed SET is identical with and without it", async () => {
    await setBoost(client, POSTING_A, false);
    const without = await repo.listFeed(WORKER_REACHED, 50, {});

    await setBoost(client, POSTING_A, true);
    const with_ = await repo.listFeed(WORKER_REACHED, 50, {});

    const setOf = (rows: { jobPostingId: string }[]) => [...rows.map((r) => r.jobPostingId)].sort();
    // SAME MULTISET — same postings, same count. Nothing added, nothing dropped.
    expect(setOf(with_)).toEqual(setOf(without));
    expect(with_).toHaveLength(without.length);

    // …and the ORDER genuinely moved: A is published OLDER than B, so without a boost B
    // leads (newest first); with one, A leads. If this assertion ever passes trivially
    // the fixture has stopped exercising the rule.
    expect(without[0]?.jobPostingId).toBe(POSTING_B);
    expect(with_[0]?.jobPostingId).toBe(POSTING_A);
  });

  it("(c) boost NEVER touches the company's candidate list (Policy 13)", async () => {
    await setBoost(client, POSTING_A, false);
    const without = await repo.listCandidates(POSTING_A, FLOOR, 500);

    await setBoost(client, POSTING_A, true);
    const with_ = await repo.listCandidates(POSTING_A, FLOOR, 500);

    // BYTE-IDENTICAL. Not "same order" — the same rows, field for field. There is no
    // channel from `boosted_until` into `applications`, and this asserts the absence.
    expect(JSON.stringify(with_)).toEqual(JSON.stringify(without));
  });

  it("the candidate-list SQL reads no boost column at all (structural)", async () => {
    // Defence in depth for (c): if someone later joins `job_postings` into the
    // candidate query, this catches a boost column arriving on the row even if the
    // fixture happened not to reorder.
    const rows = await repo.listCandidates(POSTING_A, FLOOR, 500);
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        expect(key.toLowerCase(), `candidate row must not carry ${key}`).not.toContain("boost");
      }
    }
  });
});

/** Set or clear the posting's boost window. A time, not a flag — boost expires. */
async function setBoost(client: DbClient, postingId: string, boosted: boolean): Promise<void> {
  if (boosted) {
    await client.sql`
      UPDATE job_postings SET boosted_until = now() + interval '7 days'
       WHERE id = ${postingId}::uuid
    `;
    return;
  }
  await client.sql`
    UPDATE job_postings SET boosted_until = NULL WHERE id = ${postingId}::uuid
  `;
}

async function seed(client: DbClient): Promise<void> {
  const { sql } = client;
  await cleanup(client);

  // `job_reach.matched_skill_id` FKs to `skill.skill_id`, so the match skill must exist.
  // On a database where D1 (`db:seed:match:vocabulary`) has run it already does; this
  // upsert makes the fixture self-sufficient on a bare migrated database too, and is a
  // no-op on a seeded one.
  await sql`
    INSERT INTO skill (skill_id, label_en, domain_id, source, status, kind, industry_id)
    VALUES (${SKILL}, 'VMC Operator', 'cnc-machining', 'rvm', 'active', 'match_skill',
            'ind_industrial_manufacturing')
    ON CONFLICT (skill_id) DO NOTHING
  `;

  // Two workers. NO PII: an id and the minimum the NOT NULLs demand.
  for (const [id, tag] of [
    [WORKER_REACHED, "reached"],
    [WORKER_UNREACHED, "unreached"],
    [WORKER_APPLICANT_1, "applicant-1"],
    [WORKER_APPLICANT_2, "applicant-2"],
  ] as const) {
    // `phone_e164` (encrypted) and `phone_hash` (HMAC) are both NOT NULL. Synthetic
    // markers only — no real phone number exists in this fixture.
    await sql`
      INSERT INTO workers (id, phone_e164, phone_hash, status)
      VALUES (${id}::uuid, ${`enc:boost-fence-${tag}`}, ${`hash:boost-fence-${tag}`}, 'active')
      ON CONFLICT (id) DO NOTHING
    `;
  }

  // A is published OLDER than B, so unboosted the feed leads with B (newest first) and
  // any change of leader is attributable to the boost and to nothing else.
  await sql`
    INSERT INTO job_postings (id, created_by, payer_id, org_label, role_title, vacancy_band,
                              status, match_skill_ids, reach_skill_ids, published_at)
    VALUES (${POSTING_A}::uuid, ${PAYER_A}::uuid, ${PAYER_A}::uuid, 'Fence A', 'VMC Operator', '1',
            'open', ${`["${SKILL}"]`}::jsonb, ${`["${SKILL}"]`}::jsonb, now() - interval '2 days'),
           (${POSTING_B}::uuid, ${PAYER_B}::uuid, ${PAYER_B}::uuid, 'Fence B', 'VMC Operator', '1',
            'open', ${`["${SKILL}"]`}::jsonb, ${`["${SKILL}"]`}::jsonb, now() - interval '1 day')
  `;

  // Only WORKER_REACHED passes the skill gate — the reach rows ARE the gate.
  await sql`
    INSERT INTO job_reach (job_posting_id, worker_id, match_tier, matched_skill_id)
    VALUES (${POSTING_A}::uuid, ${WORKER_REACHED}::uuid, 1, ${SKILL}),
           (${POSTING_B}::uuid, ${WORKER_REACHED}::uuid, 1, ${SKILL})
  `;

  // Two applicants on POSTING_A for fence (c) — DISTINCT from the two feed workers (see
  // the constant declarations): the feed excludes any posting the worker has already
  // decided on, so reusing them would delete POSTING_A from the feed under test.
  await sql`
    INSERT INTO applications (id, worker_id, job_posting_id, action, source_surface,
                              match_tier, skill_months, industry_months, engine_version)
    VALUES (${APP_1}::uuid, ${WORKER_APPLICANT_1}::uuid, ${POSTING_A}::uuid, 'applied', 'feed',
            1, 48, 48, 'v1.0'),
           (${APP_2}::uuid, ${WORKER_APPLICANT_2}::uuid, ${POSTING_A}::uuid, 'applied', 'feed',
            2, 12, 12, 'v1.0')
  `;
}

async function cleanup(client: DbClient): Promise<void> {
  const { sql } = client;
  for (const id of [POSTING_A, POSTING_B]) {
    await sql`DELETE FROM applications WHERE job_posting_id = ${id}::uuid`;
    await sql`DELETE FROM job_reach WHERE job_posting_id = ${id}::uuid`;
    await sql`DELETE FROM job_postings WHERE id = ${id}::uuid`;
  }
  for (const id of [WORKER_REACHED, WORKER_UNREACHED, WORKER_APPLICANT_1, WORKER_APPLICANT_2]) {
    await sql`DELETE FROM workers WHERE id = ${id}::uuid`;
  }
}
