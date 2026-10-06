import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "@badabhai/db";
import { getMatchSkill, MATCH_SKILLS } from "@badabhai/taxonomy";

import type { EventsService } from "../events/events.service";
import { WorkerAttributesRepository } from "../profiles/worker-attributes.repository";
import { descriptorForKind } from "../profiling/roles/role-registry";
import { MatchConfigRepository } from "./match-config.repository";
import { MatchConfigService } from "./match-config.service";
import { MatchFeedRepository } from "./match-feed.repository";
import { WorkerSkillsRepository } from "./worker-skills.repository";
import { WorkerSkillsService } from "./worker-skills.service";
import { attributesFor, latestPack, TRADE_FORM_CASES } from "./form-onboarding.test-support";

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * A WORKER ONBOARDED THROUGH ANY TRADE FORM SEES HIS TRADE'S JOBS IN THE V1 FEED.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * THE BUG, AS A WORKER MET IT. With `MATCH_V1_ENABLED=true` a welder who completed the welder form
 * opened the app to an empty job feed, while a MIG-welder posting sat open. Only the CNC-turning
 * form derived `worker_skill` rows. The `.test.ts` twin proves the derivation per trade without a
 * database; this proves the rows LAND and the feed SERVES them — the half a stub cannot show
 * (the attribute upsert, the delete-then-insert rebuild, the `job_reach` reconcile, the feed join).
 *
 * THE ORDER IS THE LIVE ORDER: the posting is published FIRST, then the worker onboards. That is
 * the case the reach reconcile exists for — a worker profiled after publish must still be reached.
 *
 * BOTH SURFACES, PER TRADE:
 *   - FORM: `worker_attributes` only, no `worker_profiles` row (the form switches extraction off).
 *   - STRUCTURED CHAT: the same attribute rows plus the profile row the OIE path writes —
 *     `canonical_role_id` NULL and `skills` [] (`toExtractionOutput` hardcodes both).
 * Attributes go through the real `WorkerAttributesRepository.upsertMany`, shaped by the real
 * projector, exactly as both writers call them.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   pnpm db:up && pnpm db:migrate
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api run test form-onboarding-reach.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** A disjoint fixture id block (0x7Axx/0x7Bxx/0x7Cxx) so this file cannot touch another gate's rows. */
const PAYER = uuid(0x7a01);
const formWorker = (i: number): string => uuid(0x7b00 + i);
const chatWorker = (i: number): string => uuid(0x7b80 + i);
/** One open posting per match skill, so a worker's feed is exactly the postings his skills reach. */
const postingFor = (i: number): string => uuid(0x7c00 + i);
const POSTINGS = MATCH_SKILLS.map((skill, i) => ({ id: postingFor(i), skillId: skill.skillId }));
const ALL_WORKERS = TRADE_FORM_CASES.flatMap((_, i) => [formWorker(i), chatWorker(i)]);

describe.skipIf(!RUN)("form-onboarded workers reach their trade's postings (Matching V1)", () => {
  let client: DbClient;
  let service: WorkerSkillsService;
  let repo: WorkerSkillsRepository;
  let attributes: WorkerAttributesRepository;
  let feed: MatchFeedRepository;

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 1 });
    await cleanup(client);
    await seedPostings(client);
    repo = new WorkerSkillsRepository(client.db);
    attributes = new WorkerAttributesRepository(client.db);
    feed = new MatchFeedRepository(client.db);
    service = new WorkerSkillsService(
      repo,
      new MatchConfigService(new MatchConfigRepository(client.db)),
      // The rebuild emits `worker.match_skills_rebuilt`; this gate is about rows and the feed.
      { emit: async () => undefined } as unknown as EventsService,
    );
  }, 60_000);

  afterAll(async () => {
    if (client !== undefined) {
      await cleanup(client);
      await client.sql.end();
    }
  });

  /** Onboard one worker through a surface, then run the same rebuild the form/extraction calls. */
  async function onboard(
    workerId: string,
    kind: (typeof TRADE_FORM_CASES)[number]["kind"],
    answers: Readonly<Record<string, readonly string[]>>,
    surface: "form" | "chat",
  ): Promise<void> {
    const packId = descriptorForKind(kind)!.packId;
    const pack = latestPack(packId);
    await client.sql`
      INSERT INTO workers (id, phone_e164, phone_hash, status)
      VALUES (${workerId}::uuid, ${`enc:form-reach-${workerId}`}, ${`hash:form-reach-${workerId}`},
              'active')
    `;
    if (surface === "chat") {
      await client.sql`
        INSERT INTO worker_profiles (worker_id, canonical_role_id, skills, experience, profile_status)
        VALUES (${workerId}::uuid, NULL, '[]'::jsonb, ${JSON.stringify({ total_years: 5 })}::jsonb,
                'extracted')
      `;
    }
    await attributes.upsertMany(
      attributesFor(pack, answers).map((attribute) => ({
        workerId,
        attributeKey: attribute.attributeKey,
        valueKind: attribute.valueKind,
        valueBool: attribute.valueKind === "boolean" ? (attribute.value as boolean) : null,
        valueNumber: attribute.valueKind === "number" ? String(attribute.value as number) : null,
        valueText: attribute.valueKind === "text" ? (attribute.value as string) : null,
        valueTextList:
          attribute.valueKind === "text_list" ? [...(attribute.value as readonly string[])] : null,
        source: attribute.source,
        questionKey: attribute.attributeKey,
        packId,
        packVersion: pack.version,
        sessionId: null,
      })),
    );
    await service.rebuildForWorker(workerId);
  }

  describe.each(TRADE_FORM_CASES.map((c, i) => ({ ...c, i })))(
    "$kind",
    ({ kind, answers, expected, i }) => {
      it.each(["form", "chat"] as const)(
        "onboarded via %s: worker_skill + V1 feed",
        async (surface) => {
          const workerId = surface === "form" ? formWorker(i) : chatWorker(i);
          await onboard(workerId, kind, answers, surface);

          const skills = (await repo.listSkillRows(workerId)).map((row) => row.skillId).sort();
          expect(skills, `${kind} via ${surface} derived the wrong match skills`).toEqual(
            [...expected].sort(),
          );

          const served = await feed.listFeed(workerId, 100, {});
          if (expected.length === 0) {
            // NO NEAREST-SKILL PROXY: every match skill has an open posting here, and a trade with
            // no match skill must see NONE of them — not the closest one.
            expect(served, `${kind} has no match skill but was served a posting`).toEqual([]);
            return;
          }
          expect(served.length, `${kind} via ${surface} got an EMPTY V1 feed`).toBeGreaterThan(0);
          // EXACTLY his trade's postings, each at tier 1 on its own skill. Every fixture posting
          // reaches only its posted skill, so anything else in the feed would be a wrong skill.
          const want = expected
            .map((skillId) => POSTINGS.find((p) => p.skillId === skillId)!.id)
            .sort();
          expect(served.map((row) => row.jobPostingId).sort()).toEqual(want);
          for (const row of served) {
            expect(row.matchTier).toBe(1);
            expect(expected).toContain(row.matchedSkillId);
          }
        },
      );
    },
  );

  it("a worker who answered only trade-neutral questions is left untouched (no rows, no prune)", async () => {
    // The guard: no profile, no pack evidence, no declared occupation → rebuild returns null and
    // deletes nothing. Seeded with a pre-existing derived row to prove it is NOT pruned.
    const workerId = uuid(0x7bff);
    await client.sql`
      INSERT INTO workers (id, phone_e164, phone_hash, status)
      VALUES (${workerId}::uuid, 'enc:form-reach-neutral', 'hash:form-reach-neutral', 'active')
    `;
    await client.sql`
      INSERT INTO worker_skill (worker_id, skill_id, industry_id, months_bucketed, wants, source)
      VALUES (${workerId}::uuid, 'mskill_fitter', 'ind_industrial_manufacturing', 0, true,
              'derived_coarse')
    `;
    const pack = latestPack("qp_welding_trade");
    await attributes.upsertMany(
      attributesFor(pack, { welding_position: ["flat"] }).map((attribute) => ({
        workerId,
        attributeKey: attribute.attributeKey,
        valueKind: attribute.valueKind,
        valueTextList: [...(attribute.value as readonly string[])],
        source: attribute.source,
        questionKey: attribute.attributeKey,
        packId: "qp_welding_trade",
        packVersion: pack.version,
      })),
    );
    expect(await service.rebuildForWorker(workerId)).toBeNull();
    expect((await repo.listSkillRows(workerId)).map((r) => r.skillId)).toEqual(["mskill_fitter"]);
  });
});

async function seedPostings(client: DbClient): Promise<void> {
  const { sql } = client;
  // Self-sufficient on a bare migrated database: the match vocabulary is seeded by
  // `db:seed:match:vocabulary`, not by the migration train, and `job_reach.matched_skill_id`
  // FKs to `skill`. Upserted from the checked-in vocabulary, never invented.
  for (const { skillId } of POSTINGS) {
    const skill = getMatchSkill(skillId)!;
    await sql`
      INSERT INTO skill (skill_id, label_en, domain_id, source, status, kind, industry_id)
      VALUES (${skill.skillId}, ${skill.labelEn}, ${skill.domainId}, ${skill.source},
              ${skill.status}, 'match_skill', ${skill.industryId})
      ON CONFLICT (skill_id) DO NOTHING
    `;
  }
  await sql`
    INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status)
    VALUES (${PAYER}::uuid, 'employer', 'enc:form-reach', 'hash:form-reach',
            'enc:Form Reach Fixture Co', 'active')
  `;
  // Published BEFORE any worker onboards — the live order the reach reconcile exists for.
  // `reach_skill_ids` is the posted skill alone: tier-2 widening is the publish path's concern,
  // and an exact-only reach set makes "his trade's posting reached him" unambiguous.
  for (const { id, skillId } of POSTINGS) {
    await sql`
      INSERT INTO job_postings (id, created_by, payer_id, org_label, role_title, vacancy_band,
                                status, match_skill_ids, reach_skill_ids, published_at)
      VALUES (${id}::uuid, ${PAYER}::uuid, ${PAYER}::uuid, 'Form Reach Fixture', ${skillId}, '1',
              'open', ${JSON.stringify([skillId])}::jsonb, ${JSON.stringify([skillId])}::jsonb,
              now())
    `;
  }
}

async function cleanup(client: DbClient): Promise<void> {
  const { sql } = client;
  const workers = [...ALL_WORKERS, uuid(0x7bff)];
  const postings = POSTINGS.map((p) => p.id);
  await sql`DELETE FROM job_reach WHERE worker_id = ANY(${workers}::uuid[])
                                    OR job_posting_id = ANY(${postings}::uuid[])`;
  await sql`DELETE FROM job_postings WHERE id = ANY(${postings}::uuid[])`;
  await sql`DELETE FROM payers WHERE id = ${PAYER}::uuid`;
  await sql`DELETE FROM worker_industry_tenure WHERE worker_id = ANY(${workers}::uuid[])`;
  await sql`DELETE FROM worker_skill WHERE worker_id = ANY(${workers}::uuid[])`;
  await sql`DELETE FROM worker_attributes WHERE worker_id = ANY(${workers}::uuid[])`;
  await sql`DELETE FROM worker_profiles WHERE worker_id = ANY(${workers}::uuid[])`;
  await sql`DELETE FROM workers WHERE id = ANY(${workers}::uuid[])`;
}
