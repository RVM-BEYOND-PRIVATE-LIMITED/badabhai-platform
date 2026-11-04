import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { CandidateSearchRepository } from "../candidates/candidate-search.repository";
import { toCandidateRow } from "../candidates/candidate-search.service";
import { WorkerSkillsRepository } from "../match/worker-skills.repository";
import { seedStatedRungs } from "../match/stated-rung.test-support";
import { WorkerAttributesRepository } from "../profiles/worker-attributes.repository";
import { WorkerLanguagesRepository } from "../profiles/worker-languages.repository";
import { WorkerOccupationsRepository } from "../profiles/worker-occupations.repository";
import { WorkerQualificationsRepository } from "../profiles/worker-qualifications.repository";
import { readProfileFormFacts } from "../workers/profile-form-facts";
import { toProfileSummary } from "../workers/profile-summary.mapper";
import { WorkersRepository } from "../workers/workers.repository";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminEntitiesRepository } from "./admin-entities.repository";
import { AdminCandidateDetailRepository } from "./admin-candidate-detail.repository";
import { AdminCandidateDetailService } from "./admin-candidate-detail.service";

/**
 * `GET /admin/candidates/:id` AGAINST POSTGRES (#2560) — the acceptance criterion, executed:
 *
 *   for the same seeded worker, the admin record's city, role, skills, experience and salary equal
 *   what the employer-facing reads produce — the payer search's OWN statement (walked unfiltered
 *   over the whole pool, then `toCandidateRow`) and `toProfileSummary` built from the same
 *   repositories `WorkersService.getProfileSummary` reads.
 *
 * …and the read's posture against real rows: an unknown id writes no audit row, a viewed record
 * writes exactly one `admin.candidate_viewed`, a worker outside the pool has no card, and the
 * provenance joins resolve. SEEDED LOCAL DATA ONLY. The identity layer is stubbed faceless (the
 * analyst path); its own gates are unit-tested in `admin-identity.service.test.ts`.
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

/** This file WRITES fixture rows, and the repo-root env points at PRODUCTION: local hosts only. */
function assertLocalDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(
      `admin-candidate-detail.db refuses to write to a non-local database host (${host})`,
    );
  }
}

const TAG = randomUUID().slice(0, 8);
const CTX: RequestContext = { correlationId: randomUUID(), requestId: `cand-detail-db-${TAG}` };
const ADMIN: AuthenticatedAdmin = { id: randomUUID(), role: "analyst", sid: "s" };
const IN_POOL = randomUUID();
const OUT_OF_POOL = randomUUID();
/**
 * A consenting worker with MORE role months, so he leads the unfiltered search order — the card
 * contract must find IN_POOL's own row, never "whoever is first in the pool".
 */
const RIVAL = randomUUID();
const MFG = "ind_industrial_manufacturing";
const TURNER = "mskill_cnc_turner";
const VMC = "mskill_vmc_operator";
const TIG = "mskill_tig_welder";
const SHARING = ["profiling", "resume_generation", "employer_sharing"];
const PACK = `qp_cand_detail_${TAG}`;

describe.skipIf(!RUN)("GET /admin/candidates/:id — against Postgres", () => {
  let client!: DbClient;
  let service!: AdminCandidateDetailService;
  let search!: CandidateSearchRepository;
  let workersRepo!: WorkersRepository;
  let attributesRepo!: WorkerAttributesRepository;

  beforeAll(async () => {
    assertLocalDatabase(DATABASE_URL);
    client = createDbClient(DATABASE_URL, { max: 4 });
    const db = client.db;
    search = new CandidateSearchRepository(db);
    workersRepo = new WorkersRepository(db);
    attributesRepo = new WorkerAttributesRepository(db);
    service = new AdminCandidateDetailService(
      new AdminCandidateDetailRepository(db),
      workersRepo,
      attributesRepo,
      new WorkerQualificationsRepository(db),
      new WorkerLanguagesRepository(db),
      new WorkerOccupationsRepository(db),
      search,
      new WorkerSkillsRepository(db),
      new AdminEntitiesRepository(db),
      { resolve: async () => null } as never,
      new EventsService(new EventsRepository(db), { NODE_ENV: "test" } as never),
    );
    await ensureSkills(client);
    await seed(client);
  });

  afterAll(async () => {
    if (!client) return;
    try {
      const { sql } = client;
      await sql`DELETE FROM events WHERE correlation_id = ${CTX.correlationId}::uuid`;
      await sql`DELETE FROM workers WHERE id = ANY(${[IN_POOL, OUT_OF_POOL, RIVAL]}::uuid[])`;
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  });

  it("THE CONTRACT: the employer card is the row the UNFILTERED payer search serves for him", async () => {
    // The search's own statement over the whole pool, then his row out of it — exactly what an
    // employer's all-candidates search would build his card from.
    const { rows } = await search.searchPool({
      skillIds: [],
      relatedSkillIds: [],
      experience: null,
      industryId: null,
      industryExperience: null,
      city: null,
      tierFloorMonths: 0,
      strict: false,
      after: null,
      limit: 100_000,
    });
    const served = rows.find((r) => r.workerId === IN_POOL);
    expect(served, "the seeded worker must be in the pool").toBeDefined();
    // Not first in the pool: the rival outranks him, so a card read that ignored the worker id
    // would serve the rival's row.
    expect(rows.findIndex((r) => r.workerId === RIVAL)).toBeLessThan(
      rows.findIndex((r) => r.workerId === IN_POOL),
    );
    const card = toCandidateRow(
      served!,
      false,
      await search.listWantedRoles([IN_POOL]),
      await new WorkerSkillsRepository(client.db).listStatedTradeLevels([IN_POOL]),
    );

    const d = await service.getCandidate(ADMIN, IN_POOL, CTX);
    expect(d.employer_card.in_search_pool).toBe(true);
    expect(d.employer_card.role.value).toEqual(card.role);
    expect(d.employer_card.other_roles.value).toEqual(card.otherRoles);
    expect(d.employer_card.role_months.value).toBe(card.skillMonths);
    expect(d.employer_card.industry.value).toEqual(card.industry);
    expect(d.employer_card.industry_months.value).toBe(card.industryMonths);
    expect(d.employer_card.city.value).toBe(card.city);
    expect(d.employer_card.trade_levels.value).toEqual(card.tradeLevels);
    // ...and the fixture really exercises the search's own rules (not vacuous): the lead is the
    // most-months WANTED role, the tenure is floored to 6, the raw " pune " is canonicalised.
    expect(card.role.id).toBe(TURNER);
    expect(card.otherRoles.map((r) => r.id)).toEqual([VMC]);
    expect(card.industryMonths).toBe(48);
    expect(card.city).toBe("Pune");
    expect(card.tradeLevels.map((l) => l.tradeLevel)).toEqual(["setter"]);
  });

  it("THE CONTRACT: city, skills, machines, experience and salary equal toProfileSummary's", async () => {
    // Built from the same three reads `WorkersService.getProfileSummary` makes.
    const [profile, worker, sheet] = await Promise.all([
      workersRepo.latestProfile(IN_POOL),
      workersRepo.findById(IN_POOL),
      attributesRepo.loadTradeSheet(IN_POOL),
    ]);
    const summary = toProfileSummary({
      ...profile!,
      hasPhoto: typeof worker?.photoStorageKey === "string" && worker.photoStorageKey.length > 0,
      workerCity: worker?.currentCity ?? null,
      formFacts: readProfileFormFacts(sheet),
    });

    const d = await service.getCandidate(ADMIN, IN_POOL, CTX);
    expect(d.location.current_city.value).toBe(summary.city);
    expect(d.skills.skills.value).toEqual(summary.skills);
    expect(d.skills.machines.value).toEqual(summary.machines);
    expect(d.experience.total_years.value).toBe(summary.experience_years);
    expect(d.trade.display_name.value).toBe(summary.trade.display_name);
    expect(d.salary.band.value !== null).toBe(!summary.missing_fields.includes("salary"));
    // Not vacuous: real values on both sides.
    expect(summary.city).toBe(" pune ".trim());
    expect(summary.skills).toEqual(["MIG Welding"]);
    expect(summary.experience_years).toBe(4);
    expect(d.salary.band.value).toEqual({ low: 18000, high: 22000 });
  });

  it("provenance resolves against real rows: the chip answer is the interview, the page write the worker's", async () => {
    const d = await service.getCandidate(ADMIN, IN_POOL, CTX);
    expect(d.preferences.shift).toEqual({
      value: "Night shift",
      source: "interview",
      correction: null,
    });
    expect(d.salary.band.source).toBe("worker_edit");
    expect(d.trade.display_name.source).toBe("interview");
    expect(d.skills.match_skills.find((s) => s.skill_id === TIG)).toMatchObject({
      wants: false,
      source: "worker_edit",
    });
    expect(d.skills.match_skills.find((s) => s.skill_id === TURNER)?.source).toBe("ops");
  });

  it("account, résumé and activity aggregates come back from their tables", async () => {
    const d = await service.getCandidate(ADMIN, IN_POOL, CTX);
    expect(d.account.consent).toMatchObject({ state: "active", employer_sharing: true });
    expect(d.account.devices).toMatchObject({ count: 1, latest_app_version: "1.4.2" });
    expect(d.resume.versions.map((v) => [v.version, v.generation_trigger, v.has_pdf])).toEqual([
      [1, "profile_confirmed", false],
    ]);
    expect(d.activity).toMatchObject({ application_count: 0, skipped_count: 0, unlock_count: 0 });
    // Faceless for the analyst path, never an error.
    expect(d.identity.name).toEqual({ value: null, source: "unknown", correction: null });
    expect(d.identity.name_disclosed).toBe(false);
  });

  it("a worker OUTSIDE the pool (no consent) has no employer card at all", async () => {
    const d = await service.getCandidate(ADMIN, OUT_OF_POOL, CTX);
    expect(d.employer_card.in_search_pool).toBe(false);
    expect(d.employer_card.role.value).toBeNull();
    expect(d.account.consent.state).toBe("none");
    expect(await search.findCardRow(OUT_OF_POOL)).toBeNull();
  });

  it("every view writes exactly ONE admin.candidate_viewed (subject = the worker); an unknown id writes none", async () => {
    const { sql } = client;
    const count = async (subject: string) =>
      (
        await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM events
          WHERE correlation_id = ${CTX.correlationId}::uuid
            AND event_name = 'admin.candidate_viewed' AND subject_id = ${subject}::uuid`
      )[0]!.n;
    const before = await count(OUT_OF_POOL);
    await service.getCandidate(ADMIN, OUT_OF_POOL, CTX);
    expect(await count(OUT_OF_POOL)).toBe(before + 1);
    const [row] = await sql<{ subject_type: string; payload: Record<string, unknown> }[]>`
      SELECT subject_type, payload FROM events
      WHERE correlation_id = ${CTX.correlationId}::uuid AND event_name = 'admin.candidate_viewed'
      LIMIT 1`;
    expect(row!.subject_type).toBe("worker");
    expect(Object.keys(row!.payload).sort()).toEqual(["admin_id", "worker_id"]);

    const ghost = randomUUID();
    await expect(service.getCandidate(ADMIN, ghost, CTX)).rejects.toBeInstanceOf(NotFoundException);
    expect(await count(ghost)).toBe(0);
  });
});

async function ensureSkills(client: DbClient): Promise<void> {
  // The D1 vocabulary rows these fixtures name — a no-op where D1 has run.
  const rows: [string, string, string][] = [
    [TURNER, "CNC Turner", "cnc-machining"],
    [VMC, "VMC Operator", "vmc-machining"],
    [TIG, "TIG Welder", "welding"],
  ];
  for (const [id, label, domain] of rows) {
    await client.sql`
      INSERT INTO skill (skill_id, label_en, domain_id, source, status, kind, industry_id)
      VALUES (${id}, ${label}, ${domain}, 'rvm', 'active', 'match_skill', ${MFG})
      ON CONFLICT (skill_id) DO NOTHING`;
  }
}

async function seed(client: DbClient): Promise<void> {
  const { sql } = client;
  // NO PII: synthetic markers for the two NOT NULL phone columns; a city is not identity.
  for (const [id, city] of [
    [IN_POOL, " pune "],
    [OUT_OF_POOL, "Nagpur"],
    [RIVAL, "Delhi"],
  ] as const) {
    await sql`
      INSERT INTO workers (id, phone_e164, phone_hash, status, current_city)
      VALUES (${id}::uuid, ${`enc:cand-detail-${TAG}-${id}`}, ${`hash:cand-detail-${TAG}-${id}`},
              'active', ${city})`;
    await sql`
      INSERT INTO worker_skill (worker_id, skill_id, industry_id, months_bucketed, wants, source)
      VALUES (${id}::uuid, ${TURNER}, ${MFG}, 48, true, 'ops')`;
  }
  await sql`
    INSERT INTO worker_consents (worker_id, consent_version, purposes, accepted_at)
    VALUES (${RIVAL}::uuid, 'test', ${JSON.stringify(SHARING)}::jsonb, now() - interval '1 day')`;
  await sql`UPDATE worker_skill SET months_bucketed = 600 WHERE worker_id = ${RIVAL}::uuid`;
  // IN_POOL: consent with employer_sharing, a second wanted role, a switched-off one, tenure.
  await sql`
    INSERT INTO worker_consents (worker_id, consent_version, purposes, accepted_at)
    VALUES (${IN_POOL}::uuid, 'test', ${JSON.stringify(SHARING)}::jsonb, now() - interval '1 day')`;
  await sql`
    INSERT INTO worker_skill (worker_id, skill_id, industry_id, months_bucketed, wants, source)
    VALUES (${IN_POOL}::uuid, ${VMC}, ${MFG}, 30, true, 'derived_coarse'),
           (${IN_POOL}::uuid, ${TIG}, ${MFG}, 60, false, 'interview')`;
  await sql`
    INSERT INTO worker_industry_tenure (worker_id, industry_id, calendar_months)
    VALUES (${IN_POOL}::uuid, ${MFG}, 50)`;
  await seedStatedRungs(client, IN_POOL, [{ skill: TURNER, level: "setter" }]);

  // The CURRENT profile (confirmed, chat road) — newer than the rung's profile row.
  const [profile] = await sql<{ id: string }[]>`
    INSERT INTO worker_profiles
      (worker_id, profile_status, source, skills, machines, experience, salary_expectation,
       location_preference, availability, raw_profile, confirmed_at, created_at)
    VALUES (${IN_POOL}::uuid, 'confirmed', 'chat', '["MIG Welding"]'::jsonb, '["VMC"]'::jsonb,
            '{"total_years": 4}'::jsonb, '{}'::jsonb,
            '{"current_city": "Chakan", "preferred_cities": ["Pune"]}'::jsonb,
            '{"status": "immediate"}'::jsonb, '{"role_label": "Welder"}'::jsonb,
            now(), now() + interval '1 minute')
    RETURNING id`;
  // Attributes: a salary band written by the worker's preferences page (no pack, no session) and
  // a shift projected from a CHIP pack answer (the interview).
  await sql`
    INSERT INTO worker_attributes (worker_id, attribute_key, value_kind, value_number, source, question_key)
    VALUES (${IN_POOL}::uuid, 'salary_expected_min', 'number', 18000, 'answer_map', 'salary_expected_min'),
           (${IN_POOL}::uuid, 'salary_expected_max', 'number', 22000, 'answer_map', 'salary_expected_max')`;
  await sql`
    INSERT INTO worker_attributes
      (worker_id, attribute_key, value_kind, value_text, source, question_key, pack_id, pack_version)
    VALUES (${IN_POOL}::uuid, 'shift_preference', 'text', 'night', 'answer_map', 'shift_preference', ${PACK}, 1)`;
  await sql`
    INSERT INTO worker_pack_answer
      (worker_id, pack_id, pack_version, question_key, answer_option_keys, status, source)
    VALUES (${IN_POOL}::uuid, ${PACK}, 1, 'shift_preference', ARRAY['night'], 'answered', 'chip')`;
  await sql`
    INSERT INTO worker_devices (worker_id, device_hash, platform, app_version)
    VALUES (${IN_POOL}::uuid, ${`dev-${TAG}`}, 'android', '1.4.2')`;
  await sql`
    INSERT INTO generated_resumes (worker_id, profile_id, resume_text, version, generation_trigger)
    VALUES (${IN_POOL}::uuid, ${profile!.id}::uuid, 'synthetic', 1, 'profile_confirmed')`;
}
