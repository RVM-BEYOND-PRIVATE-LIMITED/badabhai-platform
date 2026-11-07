import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "@badabhai/db";
import { ApplicantProfileFactsRepository } from "./applicant-profile-facts.repository";
import { toApplicantProfileFacts } from "./applicant-profile-facts";

/**
 * #2736 — the batched facts read against real Postgres.
 *
 * Gated like the other DB release gates:
 *
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api test applicant-profile-facts.db
 *
 * A skipped gate is a disclosed gap, not a passing one. What the captured-SQL test
 * (`applicant-profile-facts.repository.test.ts`) cannot prove: that DISTINCT ON with
 * the shared CURRENT_PROFILE_ORDER tail actually resolves the worker's current
 * profile (a newer DRAFT row must lose to an older confirmed one), and that the
 * projected columns map to the card facts end to end.
 *
 * Fixtures carry synthetic `enc:`/`hash:` markers and fixed uuids; every row this file
 * inserts is deleted afterwards.
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

const RICH = "0b7f1a52-4a0e-4c80-9d61-2f1f3c4e5a01";
const SPARSE = "0b7f1a52-4a0e-4c80-9d61-2f1f3c4e5a02";

async function seed(client: DbClient): Promise<void> {
  const { sql } = client;
  for (const id of [RICH, SPARSE]) {
    await sql`
      INSERT INTO workers (id, phone_e164, phone_hash, status)
      VALUES (${id}::uuid, ${`enc:facts-${id.slice(0, 4)}`}, ${`hash:facts-${id.slice(0, 4)}`}, 'active')
      ON CONFLICT (id) DO NOTHING
    `;
  }
  // Two profiles: the NEWER one is a draft placeholder, so CURRENT_PROFILE_ORDER must
  // still resolve the older confirmed row (never recency alone).
  const confirmed = await sql<{ id: string }[]>`
    INSERT INTO worker_profiles (worker_id, profile_status, skills, experience, availability)
    VALUES (${RICH}::uuid, 'confirmed',
      ${JSON.stringify(["skill_tig_welding", "skill_arc_welding"])}::jsonb,
      ${JSON.stringify({ total_years: 4 })}::jsonb,
      ${JSON.stringify({ status: "within_week" })}::jsonb)
    RETURNING id
  `;
  await sql`
    INSERT INTO worker_profiles (worker_id, profile_status, skills, experience, availability)
    VALUES (${RICH}::uuid, 'draft', '[]'::jsonb, '{}'::jsonb, '{}'::jsonb)
  `;
  await sql`
    INSERT INTO worker_educations (worker_id, credential, field, council, year, institute, sort_order)
    VALUES (${RICH}::uuid, 'iti', 'Welder', 'ncvt', 2018, 'Govt. ITI', 0),
           (${RICH}::uuid, 'graduate', null, null, null, null, 1)
  `;
  await sql`
    INSERT INTO worker_certificates (worker_id, name, issuer, year, sort_order)
    VALUES (${RICH}::uuid, 'Welding safety', 'ITI', 2020, 0),
           (${RICH}::uuid, 'First aid', null, null, 1)
  `;
  await sql`
    INSERT INTO worker_industry_tenure (worker_id, industry_id, calendar_months)
    VALUES (${RICH}::uuid, 'ind_industrial_manufacturing', 30)
  `;
  await sql`
    INSERT INTO worker_profile_skill (worker_profile_id, skill_id, trade_level, level_confirmed)
    VALUES (${confirmed[0]!.id}::uuid, 'mskill_tig_welder', 'setter', true)
  `;
}

async function clean(client: DbClient): Promise<void> {
  const { sql } = client;
  for (const id of [RICH, SPARSE]) {
    await sql`DELETE FROM worker_profile_skill WHERE worker_profile_id IN (SELECT id FROM worker_profiles WHERE worker_id = ${id}::uuid)`;
    await sql`DELETE FROM worker_industry_tenure WHERE worker_id = ${id}::uuid`;
    await sql`DELETE FROM worker_certificates WHERE worker_id = ${id}::uuid`;
    await sql`DELETE FROM worker_educations WHERE worker_id = ${id}::uuid`;
    await sql`DELETE FROM worker_profiles WHERE worker_id = ${id}::uuid`;
    await sql`DELETE FROM workers WHERE id = ${id}::uuid`;
  }
}

describe.skipIf(!RUN)("applicant-profile-facts — against real Postgres", () => {
  let client: DbClient;
  let repo: ApplicantProfileFactsRepository;

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL);
    await clean(client);
    await seed(client);
    repo = new ApplicantProfileFactsRepository(client.db);
  });

  afterAll(async () => {
    await clean(client);
    await client.sql.end({ timeout: 5 });
  });

  it("resolves the confirmed profile — never the newer draft — and maps every fact", async () => {
    const rows = await repo.listForWorkers([RICH, SPARSE]);
    expect(rows.map((r) => r.workerId).sort()).toEqual([RICH, SPARSE].sort());
    const rich = toApplicantProfileFacts(rows.find((r) => r.workerId === RICH)!);
    expect(rich.skills).toEqual(["TIG welding", "Arc welding"]);
    expect(rich.totalExperienceBand).toBe("3-5 yrs");
    expect(rich.industryExperienceBand).toBe("1-2 yrs");
    expect(rich.educationLabel).toBe("Graduate");
    expect(rich.certificationCount).toBe(2);
    expect(rich.availabilityLabel).toBe("Within a week");
    expect(rich.lastActiveBand).toBe("today");
    expect(rich.tradeLevels).toEqual([
      {
        skillId: "mskill_tig_welder",
        skillLabel: "TIG Welder",
        tradeLevel: "setter",
        tradeLevelLabel: "Setter",
        levelConfirmed: true,
      },
    ]);
  });

  it("a worker with no stored signal gets the all-empty facts, never dropped", async () => {
    const rows = await repo.listForWorkers([SPARSE]);
    expect(rows).toHaveLength(1);
    const facts = toApplicantProfileFacts(rows[0]!);
    expect(facts.skills).toBeNull();
    expect(facts.totalExperienceBand).toBeNull();
    expect(facts.industryExperienceBand).toBeNull();
    expect(facts.educationLabel).toBeNull();
    expect(facts.certificationCount).toBe(0);
    expect(facts.availabilityLabel).toBeNull();
    expect(facts.lastActiveBand).toBe("today");
    expect(facts.tradeLevels).toEqual([]);
  });

  it("projects no PII column on any statement", async () => {
    const rows = await repo.listForWorkers([RICH]);
    expect(JSON.stringify(rows)).not.toMatch(/enc:|hash:/i);
    expect(JSON.stringify(rows)).not.toMatch(/phone|full_name|employer|licence/i);
  });
});
