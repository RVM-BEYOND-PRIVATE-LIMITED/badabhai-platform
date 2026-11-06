import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "@badabhai/db";
import type { RequestContext } from "../../common/request-context";
import { PiiCryptoService } from "../../common/pii-crypto.service";
import { EventsRepository } from "../../events/events.repository";
import { EventsService } from "../../events/events.service";
import { WorkerAttributesRepository } from "../../profiles/worker-attributes.repository";
import { WorkerPreferencesService } from "../../profiles/worker-preferences.service";
import { EffectiveFactsService } from "../../profiles/effective-facts.service";
import { ProfilesRepository } from "../../profiles/profiles.repository";
import { ProfileSkillsRepository } from "../../profiles/profile-skills.repository";
import { WorkerEmploymentRepository } from "../../profiles/worker-employment.repository";
import { WorkerLanguagesRepository } from "../../profiles/worker-languages.repository";
import { WorkerOccupationsRepository } from "../../profiles/worker-occupations.repository";
import { WorkerQualificationsRepository } from "../../profiles/worker-qualifications.repository";
import { WorkerSkillsRepository } from "../../match/worker-skills.repository";
import { WorkersRepository } from "../../workers/workers.repository";
import { WorkersService } from "../../workers/workers.service";
import { AdminActionsRepository } from "../admin-actions.repository";
import { AdminCorrectionsRepository } from "./admin-corrections.repository";
import { AdminCorrectionFactsService } from "./admin-correction-facts.service";
import { AdminCorrectionService } from "./admin-corrections.service";

/**
 * #2561 — the correction layer's POSTGRES contract (ADR-0062 §3.1–§3.4):
 *
 *   - a city correction writes the override AND `workers.current_city` in one transaction;
 *   - a re-correction keeps the ORIGINAL previous value and links the old row to the new one;
 *   - revert writes previous back and supersedes with `superseded_by = NULL`;
 *   - a WORKER self-edit supersedes the live correction in the same transaction (A1);
 *   - the partial unique index refuses two live rows for one (worker, fact);
 *   - the CHECKs refuse a short reason, an unknown fact key and a non-AES envelope;
 *   - RLS is both enabled and FORCED, and the worker cascade erases the correction;
 *   - the résumé trigger CHECK now admits `admin_edit`.
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function assertLocalDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`admin-corrections.db refuses to write to a non-local host (${host})`);
  }
}

const TAG = randomUUID().slice(0, 8);
const CTX: RequestContext = { correlationId: randomUUID(), requestId: `corrections-db-${TAG}` };
const ADMIN = { id: randomUUID(), role: "ops_admin" as const, sid: "s" };
const WORKER = randomUUID();
const PROFILE = randomUUID();
const SKILL_A = `skill_admin_corr_a_${TAG}`;
const SKILL_B = `skill_admin_corr_b_${TAG}`;
const REASON = {
  reason_code: "worker_request" as const,
  reason_text: "Worker called support and asked us to correct the city",
};

describe.skipIf(!RUN)("#2561 admin corrections — against Postgres", () => {
  let client!: DbClient;
  let corrections!: AdminCorrectionsRepository;
  let service!: AdminCorrectionService;
  let workersRepo!: WorkersRepository;
  let workersService!: WorkersService;
  let effectiveFacts!: EffectiveFactsService;
  let pii!: PiiCryptoService;
  let preferences!: WorkerPreferencesService;

  beforeAll(async () => {
    assertLocalDatabase(DATABASE_URL);
    client = createDbClient(DATABASE_URL, { max: 4 });
    const events = new EventsService(new EventsRepository(client.db), {
      NODE_ENV: "test",
    } as never);
    pii = new PiiCryptoService({
      PII_HASH_PEPPER: "corrections-test-pepper",
      PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      PIN_PEPPER: "corrections-test-pin",
    } as never);
    corrections = new AdminCorrectionsRepository(client.db);
    workersRepo = new WorkersRepository(client.db);
    effectiveFacts = new EffectiveFactsService(client.db, pii, events);
    const attributes = new WorkerAttributesRepository(client.db);
    const queue = { add: async () => ({}) } as never;
    preferences = new WorkerPreferencesService(
      attributes,
      workersRepo,
      events,
      queue,
      effectiveFacts,
      client.db,
    );
    workersService = new WorkersService(
      workersRepo,
      pii,
      events,
      {} as never,
      {} as never,
      queue,
      attributes,
      effectiveFacts,
    );
    const facts = new AdminCorrectionFactsService(
      corrections,
      workersRepo,
      new ProfilesRepository(client.db),
      new ProfileSkillsRepository(client.db),
      new WorkerEmploymentRepository(client.db, pii),
      new WorkerQualificationsRepository(client.db),
      new WorkerLanguagesRepository(client.db),
      new WorkerOccupationsRepository(client.db),
      attributes,
      new WorkerSkillsRepository(client.db),
      preferences,
      pii,
    );
    service = new AdminCorrectionService(
      corrections,
      new AdminActionsRepository(client.db),
      workersRepo,
      workersService,
      preferences,
      pii,
      events,
      facts,
      // The DB contract stops at commit; PR 3's queues/push are unit-tested separately.
      { afterCorrection: async () => undefined } as never,
    );

    await client.sql`
      INSERT INTO workers (id, phone_e164, phone_hash, status)
      VALUES (${WORKER}::uuid, ${`enc:${TAG}`}, ${`hmac:${TAG}`}, 'active')`;
    await client.sql`UPDATE workers SET current_city = 'Mumbai' WHERE id = ${WORKER}::uuid`;
    // PR 2 needs somewhere for trade/role/skills/experience to land.
    await client.sql`
      INSERT INTO worker_profiles (id, worker_id, source, skills, machines, experience, raw_profile)
      VALUES (
        ${PROFILE}::uuid, ${WORKER}::uuid, 'chat',
        '[]'::jsonb, '[]'::jsonb, '{"total_years":3}'::jsonb,
        '{"skills":[],"machines":[],"experience":{"total_years":3}}'::jsonb
      )`;
    await client.sql`
      INSERT INTO skill (skill_id, label_en, source, kind, industry_id)
      VALUES
        (${SKILL_A}, 'Admin correction skill A', 'rvm', 'match_skill', 'ind_industrial_manufacturing'),
        (${SKILL_B}, 'Admin correction skill B', 'rvm', 'match_skill', 'ind_industrial_manufacturing')
      ON CONFLICT (skill_id) DO NOTHING`;
  });

  afterAll(async () => {
    if (!client) return;
    try {
      await client.sql`DELETE FROM audit_logs WHERE entity_id = ${WORKER}::uuid`;
      await client.sql`DELETE FROM events WHERE correlation_id = ${CTX.correlationId}::uuid`;
      await client.sql`DELETE FROM workers WHERE id = ${WORKER}::uuid`;
      await client.sql`DELETE FROM skill WHERE skill_id IN (${SKILL_A}, ${SKILL_B})`;
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  });

  const cityOf = async (): Promise<string | null> => {
    const [row] = await client.sql<{ current_city: string | null }[]>`
      SELECT current_city FROM workers WHERE id = ${WORKER}::uuid`;
    return row?.current_city ?? null;
  };

  it("a city correction writes the override AND the worker row in one transaction", async () => {
    const result = await service.correct(
      ADMIN as never,
      WORKER,
      { fact_key: "current_city", value: "Pune", ...REASON },
      CTX,
    );
    expect(result.changed).toBe(true);
    expect(await cityOf()).toBe("Pune");
    const [row] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM worker_admin_override
      WHERE worker_id = ${WORKER}::uuid AND fact_key = 'current_city' AND superseded_at IS NULL`;
    expect(row?.count).toBe(1);
    const [audit] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM audit_logs
      WHERE entity_id = ${WORKER}::uuid AND action = 'candidate_field_corrected'`;
    expect(audit?.count).toBe(1);
    const [spine] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM events
      WHERE correlation_id = ${CTX.correlationId}::uuid AND event_name = 'admin.candidate_field_corrected'`;
    expect(spine?.count).toBe(1);
    const effective = await effectiveFacts.resolve(WORKER);
    expect(effective.get("current_city")).toBe("Pune");
  });

  it("re-correcting keeps the ORIGINAL previous value and links the superseded row", async () => {
    const result = await service.correct(
      ADMIN as never,
      WORKER,
      { fact_key: "current_city", value: "Nashik", ...REASON },
      CTX,
    );
    expect(await cityOf()).toBe("Nashik");
    const rows = await client.sql<
      { id: string; superseded_by_id: string | null; live: boolean }[]
    >`
      SELECT id, superseded_by_id, superseded_at IS NULL AS live FROM worker_admin_override
      WHERE worker_id = ${WORKER}::uuid AND fact_key = 'current_city' ORDER BY created_at`;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.live).toBe(false);
    expect(rows[0]?.superseded_by_id).toBe(result.override_id);
    expect(rows[1]?.live).toBe(true);
  });

  it("revert writes the ORIGINAL previous city back and clears the live row", async () => {
    const result = await service.revert(
      ADMIN as never,
      WORKER,
      "current_city",
      { reason_code: "verification_error", reason_text: "The correction was based on a wrong address" },
      CTX,
    );
    expect(result.changed).toBe(true);
    expect(await cityOf()).toBe("Mumbai");
    const [live] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM worker_admin_override
      WHERE worker_id = ${WORKER}::uuid AND fact_key = 'current_city' AND superseded_at IS NULL`;
    expect(live?.count).toBe(0);
    const [reverted] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM events
      WHERE correlation_id = ${CTX.correlationId}::uuid AND event_name = 'admin.candidate_field_reverted'`;
    expect(reverted?.count).toBe(1);
  });

  it("a WORKER self-edit supersedes the live correction in the same transaction (A1)", async () => {
    await service.correct(
      ADMIN as never,
      WORKER,
      { fact_key: "current_city", value: "Pune", ...REASON },
      CTX,
    );
    await workersService.setLocation(WORKER, { city: "Delhi" }, CTX);
    expect(await cityOf()).toBe("Delhi");
    const [live] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM worker_admin_override
      WHERE worker_id = ${WORKER}::uuid AND fact_key = 'current_city' AND superseded_at IS NULL`;
    expect(live?.count).toBe(0);
    expect((await effectiveFacts.resolve(WORKER)).has("current_city")).toBe(false);
    const [superseded] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM events
      WHERE correlation_id = ${CTX.correlationId}::uuid
        AND event_name = 'worker.admin_correction_superseded'`;
    expect(superseded?.count).toBe(1);
  });

  it("preferred_locations writes the attribute list and revert clears it", async () => {
    await service.correct(
      ADMIN as never,
      WORKER,
      { fact_key: "preferred_locations", value: ["Pune", "Nashik"], ...REASON },
      CTX,
    );
    const [attr] = await client.sql<{ value_text_list: string[] | null }[]>`
      SELECT value_text_list FROM worker_attributes
      WHERE worker_id = ${WORKER}::uuid AND attribute_key = 'preferred_locations'`;
    expect(attr?.value_text_list).toEqual(["Pune", "Nashik"]);
    expect((await effectiveFacts.resolve(WORKER)).get("preferred_locations")).toEqual([
      "Pune",
      "Nashik",
    ]);

    await service.revert(
      ADMIN as never,
      WORKER,
      "preferred_locations",
      { reason_code: "worker_request", reason_text: "Worker asked us to undo the earlier city list" },
      CTX,
    );
    const [after] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM worker_attributes
      WHERE worker_id = ${WORKER}::uuid AND attribute_key = 'preferred_locations'`;
    expect(after?.count).toBe(0);
  });

  it("the database refuses a second LIVE row, a short reason, an unknown key and a plaintext envelope", async () => {
    await expect(
      client.sql`
        INSERT INTO worker_admin_override (worker_id, fact_key, value_enc, admin_id, reason_code, reason_text)
        VALUES (${WORKER}::uuid, 'current_city', 'v1.aaaaaaaaaaaaaaaa.bbbb.cccc', ${ADMIN.id}::uuid,
                'other', 'A valid-length reason that is definitely long enough')`,
    ).resolves.toBeDefined();
    await expect(
      client.sql`
        INSERT INTO worker_admin_override (worker_id, fact_key, value_enc, admin_id, reason_code, reason_text)
        VALUES (${WORKER}::uuid, 'current_city', 'v1.aaaaaaaaaaaaaaaa.bbbb.cccc', ${ADMIN.id}::uuid,
                'other', 'A second live row for the same worker and fact')`,
    ).rejects.toThrow(/worker_admin_override_live_uq/);
    // Use a fact with NO live row, so each case fails on the check it names (not the unique index).
    await expect(
      client.sql`
        INSERT INTO worker_admin_override (worker_id, fact_key, value_enc, admin_id, reason_code, reason_text)
        VALUES (${WORKER}::uuid, 'preferred_locations', 'v1.aaaaaaaaaaaaaaaa.bbbb.dddd', ${ADMIN.id}::uuid,
                'other', 'short')`,
    ).rejects.toThrow(/worker_admin_override_reason_chk/);
    await expect(
      client.sql`
        INSERT INTO worker_admin_override (worker_id, fact_key, value_enc, admin_id, reason_code, reason_text)
        VALUES (${WORKER}::uuid, 'not_a_fact', 'v1.aaaaaaaaaaaaaaaa.bbbb.eeee', ${ADMIN.id}::uuid,
                'other', 'A valid-length reason that is definitely long enough')`,
    ).rejects.toThrow(/worker_admin_override_fact_key_chk/);
    await expect(
      client.sql`
        INSERT INTO worker_admin_override (worker_id, fact_key, value_enc, admin_id, reason_code, reason_text)
        VALUES (${WORKER}::uuid, 'preferred_locations', '{"corrected":"Pune"}', ${ADMIN.id}::uuid,
                'other', 'A valid-length reason that is definitely long enough')`,
    ).rejects.toThrow(/worker_admin_override_value_enc_chk/);
    // Clean the deliberate live row so the cascade test starts clean.
    await client.sql`
      UPDATE worker_admin_override SET superseded_at = now()
      WHERE worker_id = ${WORKER}::uuid AND superseded_at IS NULL`;
  });

  it("trade, role and secondary_roles write the profile columns and the occupations table, and revert clears them", async () => {
    await service.correct(
      ADMIN as never,
      WORKER,
      { fact_key: "trade", value: "dom_cnc_machining", ...REASON },
      CTX,
    );
    await service.correct(
      ADMIN as never,
      WORKER,
      { fact_key: "role", value: "role_cnc_turner_operator", ...REASON },
      CTX,
    );
    await service.correct(
      ADMIN as never,
      WORKER,
      { fact_key: "secondary_roles", value: ["role_welder", "role_plumber"], ...REASON },
      CTX,
    );
    const [profile] = await client.sql<
      { canonical_trade_id: string | null; canonical_role_id: string | null }[]
    >`SELECT canonical_trade_id, canonical_role_id FROM worker_profiles WHERE id = ${PROFILE}::uuid`;
    expect(profile).toEqual({
      canonical_trade_id: "dom_cnc_machining",
      canonical_role_id: "role_cnc_turner_operator",
    });
    const [occupations] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM worker_occupation WHERE worker_id = ${WORKER}::uuid`;
    expect(occupations?.count).toBe(2);

    await service.revert(
      ADMIN as never,
      WORKER,
      "secondary_roles",
      { reason_code: "verification_error", reason_text: "The earlier secondary roles were wrong" },
      CTX,
    );
    const [afterOccupations] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM worker_occupation WHERE worker_id = ${WORKER}::uuid`;
    expect(afterOccupations?.count).toBe(0);

    await service.revert(
      ADMIN as never,
      WORKER,
      "role",
      { reason_code: "verification_error", reason_text: "The earlier role was wrong" },
      CTX,
    );
    await service.revert(
      ADMIN as never,
      WORKER,
      "trade",
      { reason_code: "verification_error", reason_text: "The earlier trade was wrong" },
      CTX,
    );
    const [after] = await client.sql<
      { canonical_trade_id: string | null; canonical_role_id: string | null }[]
    >`SELECT canonical_trade_id, canonical_role_id FROM worker_profiles WHERE id = ${PROFILE}::uuid`;
    expect(after).toEqual({ canonical_trade_id: null, canonical_role_id: null });
  });

  it("skills and experience write the authored, display and matching stores, and revert restores them", async () => {
    await service.correct(
      ADMIN as never,
      WORKER,
      { fact_key: "skills", value: [SKILL_A, SKILL_B], ...REASON },
      CTX,
    );
    const authored = await client.sql<{ skill_id: string; source: string }[]>`
      SELECT skill_id, source FROM worker_profile_skill
      WHERE worker_profile_id = ${PROFILE}::uuid ORDER BY skill_id`;
    expect(authored).toEqual([
      { skill_id: SKILL_A, source: "ops" },
      { skill_id: SKILL_B, source: "ops" },
    ]);
    const [display] = await client.sql<{ skills: string[] }[]>`
      SELECT skills FROM worker_profiles WHERE id = ${PROFILE}::uuid`;
    expect(display?.skills).toEqual([SKILL_A, SKILL_B]);
    const matching = await client.sql<{ skill_id: string; source: string }[]>`
      SELECT skill_id, source FROM worker_skill
      WHERE worker_id = ${WORKER}::uuid ORDER BY skill_id`;
    expect(matching).toEqual([
      { skill_id: SKILL_A, source: "ops" },
      { skill_id: SKILL_B, source: "ops" },
    ]);

    await service.correct(
      ADMIN as never,
      WORKER,
      { fact_key: "experience", value: 8, ...REASON },
      CTX,
    );
    const [experience] = await client.sql<{ experience: { total_years?: number } }[]>`
      SELECT experience FROM worker_profiles WHERE id = ${PROFILE}::uuid`;
    expect(experience?.experience.total_years).toBe(8);
    await service.revert(
      ADMIN as never,
      WORKER,
      "experience",
      { reason_code: "verification_error", reason_text: "The earlier total experience was wrong" },
      CTX,
    );
    const [restored] = await client.sql<{ experience: { total_years?: number } }[]>`
      SELECT experience FROM worker_profiles WHERE id = ${PROFILE}::uuid`;
    expect(restored?.experience.total_years).toBe(3);

    await service.revert(
      ADMIN as never,
      WORKER,
      "skills",
      { reason_code: "verification_error", reason_text: "The earlier skill list was wrong" },
      CTX,
    );
    const [authoredAfter] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM worker_profile_skill
      WHERE worker_profile_id = ${PROFILE}::uuid`;
    expect(authoredAfter?.count).toBe(0);
    const [displayAfter] = await client.sql<{ skills: string[] }[]>`
      SELECT skills FROM worker_profiles WHERE id = ${PROFILE}::uuid`;
    expect(displayAfter?.skills).toEqual([]);
    const [matchingAfter] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM worker_skill WHERE worker_id = ${WORKER}::uuid`;
    expect(matchingAfter?.count).toBe(0);
  });

  it("work_history replaces the live rows and revert restores the empty history", async () => {
    await service.correct(
      ADMIN as never,
      WORKER,
      {
        fact_key: "work_history",
        value: {
          employments: [
            {
              employer_name: "Tata Motors",
              employer_city: "Pune",
              employer_state: "Maharashtra",
              start_ym: "2020-01",
              end_ym: "2022-06",
              role_label: "CNC Operator",
              work_done: "Setup and turning",
            },
          ],
        },
        ...REASON,
      },
      CTX,
    );
    const [employment] = await client.sql<{ id: string; employer_name_enc: string }[]>`
      SELECT id, employer_name_enc FROM worker_employment WHERE worker_id = ${WORKER}::uuid`;
    expect(employment).toBeDefined();
    expect(pii.decrypt(employment!.employer_name_enc)).toBe("Tata Motors");
    const [role] = await client.sql<{ role_label: string }[]>`
      SELECT role_label FROM worker_employment_role
      WHERE employment_id = ${employment!.id}::uuid`;
    expect(role?.role_label).toBe("CNC Operator");

    await service.revert(
      ADMIN as never,
      WORKER,
      "work_history",
      { reason_code: "verification_error", reason_text: "The earlier work history was wrong" },
      CTX,
    );
    const [after] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM worker_employment WHERE worker_id = ${WORKER}::uuid`;
    expect(after?.count).toBe(0);
  });

  it("education, certifications and training write rows, and each revert clears only its own list", async () => {
    await service.correct(
      ADMIN as never,
      WORKER,
      {
        fact_key: "education",
        value: [
          {
            credential: "iti",
            field: "mechanical engineering",
            council: "ncvt",
            year: 2018,
            institute: "Govt ITI",
          },
        ],
        ...REASON,
      },
      CTX,
    );
    const [education] = await client.sql<{ field: string | null }[]>`
      SELECT field FROM worker_education WHERE worker_id = ${WORKER}::uuid`;
    expect(education?.field).toBe("Mechanical Engineering");

    await service.correct(
      ADMIN as never,
      WORKER,
      {
        fact_key: "certifications",
        value: [
          {
            name: "CNC certificate",
            issuer: "Govt ITI",
            year: 2019,
            licence_number: "ABC-123",
            licence_expiry: "2030-01-01",
          },
        ],
        ...REASON,
      },
      CTX,
    );
    const [certificate] = await client.sql<{ licence_number_enc: string | null }[]>`
      SELECT licence_number_enc FROM worker_certificate WHERE worker_id = ${WORKER}::uuid`;
    expect(certificate?.licence_number_enc).not.toBeNull();
    expect(pii.decrypt(certificate!.licence_number_enc!)).toBe("ABC-123");

    await service.correct(
      ADMIN as never,
      WORKER,
      {
        fact_key: "training",
        value: [{ name: "CNC course", provider: "Govt ITI", year: 2019 }],
        ...REASON,
      },
      CTX,
    );
    const [training] = await client.sql<{ name: string }[]>`
      SELECT name FROM worker_training WHERE worker_id = ${WORKER}::uuid`;
    expect(training?.name).toBe("CNC course");

    for (const factKey of ["education", "certifications", "training"] as const) {
      await service.revert(
        ADMIN as never,
        WORKER,
        factKey,
        { reason_code: "verification_error", reason_text: "The earlier credential was wrong" },
        CTX,
      );
    }
    const [educationCount] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM worker_education WHERE worker_id = ${WORKER}::uuid`;
    const [certificateCount] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM worker_certificate WHERE worker_id = ${WORKER}::uuid`;
    const [trainingCount] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM worker_training WHERE worker_id = ${WORKER}::uuid`;
    expect([educationCount?.count, certificateCount?.count, trainingCount?.count]).toEqual([0, 0, 0]);
  });

  it("languages write the rows and revert clears them", async () => {
    await service.correct(
      ADMIN as never,
      WORKER,
      {
        fact_key: "languages",
        value: [{ language: "hindi", can_speak: true, can_read: true, can_write: false }],
        ...REASON,
      },
      CTX,
    );
    const [language] = await client.sql<{
      language: string;
      can_speak: boolean;
      can_read: boolean;
    }[]>`
      SELECT language, can_speak, can_read FROM worker_language WHERE worker_id = ${WORKER}::uuid`;
    expect(language).toEqual({ language: "hindi", can_speak: true, can_read: true });

    await service.revert(
      ADMIN as never,
      WORKER,
      "languages",
      { reason_code: "verification_error", reason_text: "The earlier language list was wrong" },
      CTX,
    );
    const [after] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM worker_language WHERE worker_id = ${WORKER}::uuid`;
    expect(after?.count).toBe(0);
  });

  it("salary and preference corrections write the attributes, and each revert clears them", async () => {
    const cases = [
      ["salary_expected", { min: 20000, max: 25000 }],
      ["salary_period", "month"],
      ["availability", { status: "immediate", notice_period_days: 0 }],
      ["shift", "day"],
      ["relocation", true],
      ["accommodation", true],
      ["job_type", "permanent"],
      ["work_types", ["permanent"]],
      ["commute_max_km", 25],
      ["willing_to_travel", true],
      ["documents_ready", ["aadhaar"]],
    ] as const;

    for (const [factKey, value] of cases) {
      await service.correct(
        ADMIN as never,
        WORKER,
        { fact_key: factKey, value, ...REASON },
        CTX,
      );
      await service.revert(
        ADMIN as never,
        WORKER,
        factKey,
        { reason_code: "verification_error", reason_text: `The earlier ${factKey} was wrong` },
        CTX,
      );
    }

    const [left] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM worker_attributes
      WHERE worker_id = ${WORKER}::uuid AND attribute_key IN (
        'salary_expected_min', 'salary_expected_max', 'salary_period', 'availability',
        'shift_preference', 'relocation_willingness', 'accommodation_needed', 'job_type',
        'work_types', 'commute_max_km', 'willing_to_travel', 'documents_ready'
      )`;
    expect(left?.count).toBe(0);
  });

  it("a worker salary edit supersedes the live correction (A1)", async () => {
    await service.correct(
      ADMIN as never,
      WORKER,
      { fact_key: "salary_expected", value: { min: 30000, max: 35000 }, ...REASON },
      CTX,
    );
    await preferences.setForWorker(
      WORKER,
      { salary_expected_min: 18000, salary_expected_max: 20000, touched_only: true },
      CTX,
    );
    const [live] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM worker_admin_override
      WHERE worker_id = ${WORKER}::uuid AND fact_key = 'salary_expected'
        AND superseded_at IS NULL`;
    expect(live?.count).toBe(0);
  });

  it("RLS is ENABLED and FORCED, and the worker cascade erases the corrections", async () => {
    const [rls] = await client.sql<{ enabled: boolean; forced: boolean }[]>`
      SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
      FROM pg_class WHERE relname = 'worker_admin_override'`;
    expect(rls).toEqual({ enabled: true, forced: true });

    const [constraint] = await client.sql<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'generated_resumes_generation_trigger_chk'`;
    expect(constraint?.def).toContain("admin_edit");

    await client.sql`DELETE FROM workers WHERE id = ${WORKER}::uuid`;
    const [left] = await client.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM worker_admin_override WHERE worker_id = ${WORKER}::uuid`;
    expect(left?.count).toBe(0);
  });
});
