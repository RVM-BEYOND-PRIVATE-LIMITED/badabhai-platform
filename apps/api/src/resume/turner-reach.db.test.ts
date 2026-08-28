import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "@badabhai/db";

import { WorkerSkillsRepository } from "../match/worker-skills.repository";
import { WorkerSkillsService } from "../match/worker-skills.service";
import { MatchConfigService } from "../match/match-config.service";
import { MatchConfigRepository } from "../match/match-config.repository";
import type { EventsService } from "../events/events.service";

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * XFAIL(blocker="B0b") — A CNC TURNER WHO FINISHED THE ROLE-PACK INTERVIEW IS REACHABLE.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS ALLOWED TO FAIL. The résumé work on this branch makes a
 * turner's SHEET correct. It does not make him FINDABLE: `worker_skill` is derived from
 * `worker_profiles.canonical_role_id` and `worker_profiles.skills`, and the role-pack path
 * writes neither — `toExtractionOutput` hardcodes both canonical ids to null (deliberately: an
 * invented taxonomy id in the one place the match engine trusts absolutely is worse than none),
 * and the pack's fourteen answers land in `worker_attributes`, which no bridge reads.
 *
 * So the most completely-profiled worker on the platform derives ZERO skills, holds zero
 * `worker_skill` rows, and appears in no posting's `job_reach`. A perfect résumé that no
 * employer search can reach is a résumé nobody sees. That gap is B0b — `apps/api`, a different
 * item, a different tree — and it is explicitly out of scope on this branch.
 *
 * WHAT THIS FILE IS FOR: recording the dependency as an EXECUTABLE assertion rather than as a
 * sentence in a document. It uses vitest's `it.fails`, which is xfail proper:
 *
 *   - TODAY the suite passes while the assertion inside fails, so CI stays honest and green and
 *     nobody is blocked by somebody else's item;
 *   - WHEN B0B LANDS the inner assertion starts passing and `it.fails` turns RED with "Expected
 *     test to fail". That is the signal to delete the marker; the test is then green with no
 *     other edit, and it becomes a permanent regression gate for free.
 *
 * The one shape it must never take is an assertion on the BROKEN state
 * (`expect(rows).toHaveLength(0)`) — that has to be rewritten in order to land the fix, which is
 * how a placeholder turns into an obstacle.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   pnpm db:up && pnpm db:migrate
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api run test turner-reach.db
 *
 * Registered in ci.yml's DB-backed-gates step, which asserts per file that it EXECUTED — a
 * `skipIf` gate that never armed is a disclosed gap, not a pass.
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const WORKER = uuid(0x7101);
const PAYER = uuid(0x7201);
const POSTING = uuid(0x7301);
/**
 * THE REAL CLOSED-SET TURNER SKILL, not a synthetic one, and that choice is what stops this
 * gate from satisfying itself.
 *
 * A fixture-invented skill id could be published on the posting AND derived for the worker, so
 * reach would follow trivially the moment any bridge existed — including a wrong one. This is
 * the id an actual turner posting carries (`MATCH_SKILLS`, the launch wedge) and the id
 * `deriveWorkerSkills` must produce for a turner. The two have to MEET on it, which is the
 * product statement B0b owes: a turner posting reaches a turner.
 *
 * Upserted so the fixture is self-sufficient on a bare migrated database — the corpus is seeded
 * by `db:seed`, not by the migration train, and a gate that silently depends on a seed step is
 * a gate that fails for the wrong reason.
 */
const SKILL = "mskill_cnc_turner";
const INDUSTRY = "ind_industrial_manufacturing";

describe.skipIf(!RUN)("XFAIL(blocker=B0b) — a role-pack turner reaches a turner posting", () => {
  let client: DbClient;
  let service: WorkerSkillsService;
  let repo: WorkerSkillsRepository;

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 1 });
    await seed(client);
    repo = new WorkerSkillsRepository(client.db);
    service = new WorkerSkillsService(
      repo,
      new MatchConfigService(new MatchConfigRepository(client.db)),
      // The rebuild emits `match.worker_skills_rebuilt`; this gate is about the ROWS, and a
      // real EventsService would need the whole events graph to say nothing new.
      { emit: async () => undefined } as unknown as EventsService,
    );
  }, 60_000);

  afterAll(async () => {
    if (client !== undefined) {
      await cleanup(client);
      await client.sql.end();
    }
  });

  it.fails("XFAIL(B0b): derives at least one worker_skill row from the pack answers", async () => {
    await service.rebuildForWorker(WORKER);
    const rows = await repo.listSkillRows(WORKER);
    expect(
      rows.length,
      "A fully-answered CNC turner derived NO skills. The role pack writes worker_attributes; " +
        "deriveWorkerSkills reads worker_profiles.canonical_role_id and .skills, which the OIE " +
        "path leaves null and empty. That bridge is B0b.",
    ).toBeGreaterThan(0);
  });

  it.fails("XFAIL(B0b): appears in job_reach for a published turner posting", async () => {
    await service.rebuildForWorker(WORKER);
    await repo.materializeReachForPosting(POSTING, [SKILL], [SKILL]);
    const reach = await repo.findReachRow(WORKER, POSTING);
    expect(
      reach,
      "The turner is not in this posting's reach set, so no employer search can surface him — " +
        "his résumé is correct and unreachable.",
    ).toBeTruthy();
  });
});

async function seed(client: DbClient): Promise<void> {
  const { sql } = client;
  await cleanup(client);

  // `job_reach.matched_skill_id` FKs to `skill`, so the reach assertion cannot even be
  // EXPRESSED without a real row here. Upserted rather than looked up: pinning a corpus id a
  // later taxonomy pass may retire would make this gate fail for a reason that has nothing to
  // do with B0b.
  await sql`
    INSERT INTO skill (skill_id, label_en, domain_id, source, status, kind, industry_id)
    VALUES (${SKILL}, 'CNC Turner', 'cnc-machining', 'rvm', 'active', 'match_skill', ${INDUSTRY})
    ON CONFLICT (skill_id) DO NOTHING
  `;

  // Synthetic markers only — no real phone number exists in this fixture, so nothing here can
  // leak or resemble PII even in a shared database.
  await sql`
    INSERT INTO workers (id, phone_e164, phone_hash, status)
    VALUES (${WORKER}::uuid, 'enc:turner-reach', 'hash:turner-reach', 'active')
    ON CONFLICT (id) DO NOTHING
  `;

  // ── THE PROFILE A ROLE-PACK INTERVIEW ACTUALLY LEAVES ──────────────────────────────
  // `canonical_role_id` NULL and `skills` [] is not a degenerate fixture: it is what every
  // OIE-path extraction writes today, and it IS B0b. `experience.total_years` is present
  // because the pack does capture it (`turning_experience`), which is what makes the gap so
  // sharp — the platform knows he has eight years and still derives nothing from them.
  await sql`
    INSERT INTO worker_profiles (worker_id, canonical_role_id, skills, experience, profile_status)
    VALUES (${WORKER}::uuid, NULL, '[]'::jsonb, ${JSON.stringify({ total_years: 8 })}::jsonb,
            'confirmed')
  `;

  // The answers the interview really did settle. Every one is a matching input under §2
  // (skills, domain relevance, role-specific experience) and none reaches `worker_skill`.
  const answers: [string, string[]][] = [
    ["turning_machine", ["cnc_lathe", "conventional_lathe"]],
    ["controller_brand", ["fanuc", "siemens"]],
    ["setting_operation", ["tool_offset", "work_offset", "first_piece"]],
  ];
  for (const [key, value] of answers) {
    await sql`
      INSERT INTO worker_attributes
        (worker_id, attribute_key, value_kind, value_text_list, source, pack_id, pack_version)
      VALUES (${WORKER}::uuid, ${key}, 'text_list', ${JSON.stringify(value)}::jsonb, 'answer_map',
              'qp_cnc_turning', 1)
      ON CONFLICT (worker_id, attribute_key) DO NOTHING
    `;
  }

  await sql`
    INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status)
    VALUES (${PAYER}::uuid, 'employer', 'enc:turner-reach', 'hash:turner-reach',
            'enc:Turner Reach Fixture Co', 'active')
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO job_postings (id, created_by, payer_id, org_label, role_title, vacancy_band,
                              status, match_skill_ids, reach_skill_ids, published_at)
    VALUES (${POSTING}::uuid, ${PAYER}::uuid, ${PAYER}::uuid, 'Turner Reach Fixture',
            'CNC Turner', '1', 'open', ${`["${SKILL}"]`}::jsonb, ${`["${SKILL}"]`}::jsonb, now())
  `;
}

async function cleanup(client: DbClient): Promise<void> {
  const { sql } = client;
  await sql`DELETE FROM job_reach WHERE worker_id = ${WORKER}::uuid`;
  await sql`DELETE FROM job_postings WHERE id = ${POSTING}::uuid`;
  await sql`DELETE FROM payers WHERE id = ${PAYER}::uuid`;
  await sql`DELETE FROM worker_attributes WHERE worker_id = ${WORKER}::uuid`;
  await sql`DELETE FROM worker_profiles WHERE worker_id = ${WORKER}::uuid`;
  await sql`DELETE FROM workers WHERE id = ${WORKER}::uuid`;
}
