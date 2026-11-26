import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "@badabhai/db";
import { DEFAULT_MATCH_CONFIG } from "@badabhai/match-engine";

import type { RequestContext } from "../common/request-context";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { WorkerSkillsRepository } from "../match/worker-skills.repository";
import type { MatchConfigService } from "../match/match-config.service";
import { toProfileSummary } from "../workers/profile-summary.mapper";
import { CandidateSearchRepository } from "./candidate-search.repository";
import { CandidateSearchService } from "./candidate-search.service";
import { CandidateSearchSchema, type CandidateSearchInput } from "./candidate-search.dto";

/**
 * #3033 — a student whose only role is "BIM Modeller", against a real Postgres.
 *
 * "BIM Modeller" is pack 7.2 "none, label only": the import keeps it as a display label on
 * the worker's profile (`raw_profile.role_label`, `import_source: campus`) and writes NO
 * `worker_skill` row for it (`mapCampusStudentProfile` lists it under `labelOnly` — proved
 * pure in `student-import/campus-profile-mapping.test.ts`). With no skill rows the pool's own
 * membership rule (`EXISTS … worker_skill … wants`) keeps him out of EVERY trade's company
 * search, while a consented worker holding a skill is served.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   RUN_DB_TESTS=1 DATABASE_URL=<a migrated LOCAL database> \
 *     pnpm --filter @badabhai/api run test campus-label-only.db
 *
 * Runs in CI as one of the DB-backed gates in `ci.yml`, which asserts per-file that it EXECUTED.
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function assertLocalDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`campus-label-only.db refuses to write to a non-local database host (${host})`);
  }
}

const TAG = randomUUID().slice(0, 8);
const PAYER = randomUUID();
const CTX: RequestContext = { correlationId: randomUUID(), requestId: `campus-label-${TAG}` };

const CAMPUS = randomUUID();
const CONTROL = randomUUID();
const TURNER = "mskill_cnc_turner";
const MFG = "ind_industrial_manufacturing";
const SHARING = ["profiling", "resume_generation", "employer_sharing"];

const page = (service: CandidateSearchService, body: CandidateSearchInput) =>
  service.search(PAYER, CandidateSearchSchema.parse(body), CTX);

async function servedIds(service: CandidateSearchService, body: CandidateSearchInput = {}): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const r = await page(service, { limit: 50, cursor, ...body });
    ids.push(...r.candidates.map((c) => c.workerId));
    cursor = r.nextCursor;
  } while (cursor);
  return ids;
}

describe.skipIf(!RUN)("a label-only Campus student appears in no trade's search", () => {
  let client!: DbClient;
  let service!: CandidateSearchService;

  beforeAll(async () => {
    assertLocalDatabase(DATABASE_URL);
    client = createDbClient(DATABASE_URL, { max: 2 });
    const events = new EventsService(new EventsRepository(client.db), {
      NODE_ENV: "test",
    } as never);
    service = new CandidateSearchService(
      new CandidateSearchRepository(client.db),
      new WorkerSkillsRepository(client.db),
      { get: async () => DEFAULT_MATCH_CONFIG } as unknown as MatchConfigService,
      events,
    );
    const { sql } = client;
    await sql`
      INSERT INTO skill (skill_id, label_en, domain_id, source, status, kind, industry_id)
      VALUES (${TURNER}, 'CNC Turner', 'cnc-machining', 'rvm', 'active', 'match_skill', ${MFG})
      ON CONFLICT (skill_id) DO NOTHING
    `;
    // NO PII: synthetic markers for the two NOT NULL phone columns.
    for (const [id, key] of [
      [CAMPUS, "label"],
      [CONTROL, "control"],
    ] as const) {
      await sql`
        INSERT INTO workers (id, phone_e164, phone_hash, status)
        VALUES (${id}::uuid, ${`enc:t3033-${TAG}-${key}`}, ${`hash:t3033-${TAG}-${key}`}, 'active')`;
      await sql`
        INSERT INTO worker_consents (worker_id, consent_version, purposes, accepted_at)
        VALUES (${id}::uuid, 'test', ${JSON.stringify(SHARING)}::jsonb, now() - interval '1 day')`;
    }
    // The moved student: a Campus-imported profile whose ONLY role is label-only. No skill
    // rows — exactly what the import writes, because the mapping has no skill for it.
    await sql`
      INSERT INTO worker_profiles (worker_id, profile_status, raw_profile)
      VALUES (${CAMPUS}::uuid, 'confirmed',
              '{"import_source": "campus", "role_label": "BIM Modeller"}'::jsonb)
    `;
    // The control: the same consent, but a held trade skill.
    await sql`
      INSERT INTO worker_skill (worker_id, skill_id, industry_id, months_bucketed, wants, source)
      VALUES (${CONTROL}::uuid, ${TURNER}, ${MFG}, 24, true, 'ops')
    `;
  });

  afterAll(async () => {
    if (!client) return;
    try {
      const { sql } = client;
      await sql`DELETE FROM events WHERE correlation_id = ${CTX.correlationId}::uuid`;
      // Profiles, skills and consents all cascade from workers.
      await sql`DELETE FROM workers WHERE id = ANY(${[CAMPUS, CONTROL]}::uuid[])`;
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  });

  it("the profile carries the label and no skills", async () => {
    const rows = (await client.sql<{ raw: unknown }[]>`
      SELECT raw_profile AS raw FROM worker_profiles WHERE worker_id = ${CAMPUS}::uuid`) as unknown as {
      raw: unknown;
    }[];
    const summary = toProfileSummary({
      profileStatus: "confirmed",
      canonicalTradeId: null,
      canonicalRoleId: null,
      skills: [],
      machines: [],
      experience: {},
      salaryExpectation: {},
      locationPreference: {},
      availability: {},
      rawProfile: rows[0]?.raw,
      confirmedAt: null,
      hasPhoto: false,
    });
    expect(summary.trade.display_name).toBe("Campus role: BIM Modeller");
    const skills = (await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM worker_skill WHERE worker_id = ${CAMPUS}::uuid`) as unknown as {
      n: number;
    }[];
    expect(skills[0]?.n).toBe(0);
  });

  it("no trade's search serves him; the skilled control is served", async () => {
    expect(await servedIds(service, { skill_ids: [TURNER] })).toEqual([CONTROL]);
    const all = await servedIds(service);
    expect(all).toContain(CONTROL);
    expect(all).not.toContain(CAMPUS);
  });
});
