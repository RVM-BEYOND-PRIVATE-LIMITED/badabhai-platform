import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "@badabhai/db";
import { getMatchSkill, MATCH_SKILLS } from "@badabhai/taxonomy";

import type { EventsService } from "../events/events.service";
import { projectProfile } from "../profiling/answer-map-projector";
import { readWorkerOnlyAnswerMap } from "../profiling/conversation-state";
import { toExtractionOutput } from "../profiles/profile-extraction.processor";
import { MatchConfigRepository } from "./match-config.repository";
import { MatchConfigService } from "./match-config.service";
import { MatchFeedRepository } from "./match-feed.repository";
import { WorkerSkillsRepository } from "./worker-skills.repository";
import { WorkerSkillsService } from "./worker-skills.service";
import {
  answerRecordsFor,
  GENERIC_PACK_CHAT_CASES,
  latestPack,
} from "./form-onboarding.test-support";

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * #2021 — A GENERIC-PACK CHAT REACHES ITS TRADE'S POSTINGS IN THE V1 FEED.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * THE BUG, AS A WORKER MET IT. A worker whose structured chat ran `qp_welding` (not the welder's
 * own role pack) tapped "MIG" and "Arc". The answer has `target_field: skills`, so it went into the
 * draft's `skills` and never into `worker_attributes`. `toExtractionOutput` then wrote
 * `skills: []` and kept the answer only as free-text `skill_labels`. The rebuild had no closed id
 * to bridge, derived no `worker_skill` row, and the V1 feed was empty while a MIG posting was open.
 *
 * WHAT THIS RUNS, END TO END ON POSTGRES:
 *   answer-map records (the real capture shape, via `answerRecordsFor`)
 *     → `projectProfile` → `toExtractionOutput` (THE SEAM THE FIX LIVES IN)
 *     → the `worker_profiles` row the processor writes (`canonical_role_id`, `skills`)
 *     → `WorkerSkillsService.rebuildForWorker` → `worker_skill` + `job_reach` → the V1 feed.
 * Reverting the seam to `skills: []` fails the welding and plumbing cases.
 *
 * #2075 — the PACK-ONLY half. The profile row carries the `ai_job_id` the processor stamps, the job
 * names its session in `input_ref`, and the session's `conversation_state` holds the answer map and
 * the provenance stamp, exactly as persisted in production. The rebuild follows that chain
 * (`PROFILE_SOURCE_SESSION_ANSWERS`) to derive `mskill_industrial_electrician` from a worker-only
 * `qp_electrical` `industrial`/`panel` answer, without touching `worker_profiles.skills`. Dropping
 * `genericPackChatMatchSkills` from `workerSkillDeriveInput` fails the electrical case.
 *
 * THE ORDER IS THE LIVE ORDER: postings are published first, then the worker is profiled.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   pnpm db:up && pnpm db:migrate
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api run test generic-pack-chat-reach.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** A disjoint fixture id block (0x8Dxx/0x8Exx/0x8Fxx) so this file cannot touch another gate's rows. */
const PAYER = uuid(0x8d01);
const chatWorker = (i: number): string => uuid(0x8e00 + i);
const postingFor = (i: number): string => uuid(0x8f00 + i);
/** #2075 — each worker's interview session and extraction job (disjoint 0x18Exx / 0x28Exx). */
const sessionFor = (workerId: string): string => uuid(0x10000 + parseInt(workerId.slice(-12), 16));
const aiJobFor = (workerId: string): string => uuid(0x20000 + parseInt(workerId.slice(-12), 16));
/** One open posting per match skill, so a worker's feed is exactly the postings his skills reach. */
const POSTINGS = MATCH_SKILLS.map((skill, i) => ({ id: postingFor(i), skillId: skill.skillId }));
/** The LLM-led welding chat (#2021 worker-only ruling) — an index no case uses. */
const LLM_LED_WORKER = chatWorker(0x40);
/** #2075 — the same electrical answers in an LLM-led session, and in a legacy (unstamped) one. */
const LLM_LED_ELECTRICIAN = chatWorker(0x41);
const LEGACY_ELECTRICIAN = chatWorker(0x42);
const ALL_WORKERS = [
  ...GENERIC_PACK_CHAT_CASES.map((_, i) => chatWorker(i)),
  LLM_LED_WORKER,
  LLM_LED_ELECTRICIAN,
  LEGACY_ELECTRICIAN,
];

/**
 * The provenance stamp `ChatService.flushInterview` writes into `conversation_state`
 * (`toLlmProvenanceStatePatch`). A fully deterministic chat: the model led no turn, settled nothing.
 */
const WORKER_ONLY_STAMP = { llm_led_turns: 0, llm_draft_settled: false } as const;
/** A chat Phase A led, whose draft `settleFromLlmDraft` turned into the same answer-map record. */
const LLM_LED_STAMP = { llm_led_turns: 3, llm_draft_settled: true } as const;

describe.skipIf(!RUN)(
  "generic-pack chats reach their trade's postings (Matching V1, #2021)",
  () => {
    let client: DbClient;
    let service: WorkerSkillsService;
    let repo: WorkerSkillsRepository;
    let feed: MatchFeedRepository;

    beforeAll(async () => {
      client = createDbClient(DATABASE_URL, { max: 1 });
      await cleanup(client);
      await seedPostings(client);
      repo = new WorkerSkillsRepository(client.db);
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

    /** Profile one worker from a generic-pack chat through the real seam, then rebuild. */
    async function profileFromChat(
      workerId: string,
      packId: string,
      answers: Readonly<Record<string, readonly string[]>>,
      conversationState: Readonly<Record<string, unknown>> = WORKER_ONLY_STAMP,
    ): Promise<void> {
      const answerMap = answerRecordsFor(latestPack(packId), answers);
      const { output } = toExtractionOutput(projectProfile(answerMap), null, {
        pinnedOccupationLabel: null,
        packId,
        answerMap,
        // The processor's own read of the persisted stamp.
        workerOnlyAnswerMap: readWorkerOnlyAnswerMap(conversationState),
      });
      await client.sql`
      INSERT INTO workers (id, phone_e164, phone_hash, status)
      VALUES (${workerId}::uuid, ${`enc:generic-reach-${workerId}`},
              ${`hash:generic-reach-${workerId}`}, 'active')
    `;
      // #2075 — the interview's persisted state, as the flush writes it: the pack pin, the answer
      // map and the provenance stamp, inside `chat_sessions.conversation_state`. Then the
      // extraction job that names the session in `input_ref`, as `ProfilesService.extract` mints it.
      const sessionId = sessionFor(workerId);
      const aiJobId = aiJobFor(workerId);
      await client.sql`
      INSERT INTO chat_sessions (id, worker_id, status, conversation_state)
      VALUES (${sessionId}::uuid, ${workerId}::uuid, 'ended',
              ${JSON.stringify({ pack_id: packId, answer_map: answerMap, ...conversationState })}::jsonb)
    `;
      await client.sql`
      INSERT INTO ai_jobs (id, job_type, status, input_ref)
      VALUES (${aiJobId}::uuid, 'profile_extraction', 'completed',
              ${JSON.stringify({ worker_id: workerId, session_id: sessionId })}::jsonb)
    `;
      // The columns `ProfileExtractionProcessor` writes from `output.profile`, as it writes them,
      // plus the `ai_job_id` it stamps (the link the rebuild follows back to the session).
      await client.sql`
      INSERT INTO worker_profiles (worker_id, ai_job_id, canonical_role_id, skills, experience,
                                   profile_status)
      VALUES (${workerId}::uuid, ${aiJobId}::uuid, ${output.profile.canonical_role_id},
              ${JSON.stringify(output.profile.skills)}::jsonb,
              ${JSON.stringify({ total_years: 5 })}::jsonb, 'extracted')
    `;
      await service.rebuildForWorker(workerId);
    }

    it.each(GENERIC_PACK_CHAT_CASES.map((c, i) => ({ ...c, i })))(
      "$packId chat: worker_skill + V1 feed",
      async ({ packId, answers, expected, i }) => {
        const workerId = chatWorker(i);
        await profileFromChat(workerId, packId, answers);

        const skills = (await repo.listSkillRows(workerId)).map((row) => row.skillId).sort();
        expect(skills, `${packId} chat derived the wrong match skills`).toEqual(
          [...expected].sort(),
        );

        const served = await feed.listFeed(workerId, 100, {});
        if (expected.length === 0) {
          // NO NEAREST-SKILL PROXY: every match skill has an open posting here, and a trade with no
          // match skill must see NONE of them — not the closest one.
          expect(served, `${packId} has no match skill but was served a posting`).toEqual([]);
          return;
        }
        expect(served.length, `${packId} chat got an EMPTY V1 feed`).toBeGreaterThan(0);
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

    // WORKER-ONLY (owner ruling 2026-10-07). The SAME welding answer the first case derives
    // `mskill_mig_welder` from, but in a session the LLM led and whose draft it settled: the record
    // is indistinguishable, so the session stamp is what decides — and it derives nothing.
    it("an LLM-led qp_welding chat derives nothing and sees an empty feed", async () => {
      await profileFromChat(
        LLM_LED_WORKER,
        "qp_welding",
        { welding_process: ["mig", "arc"] },
        LLM_LED_STAMP,
      );
      expect(await repo.listSkillRows(LLM_LED_WORKER)).toEqual([]);
      expect(await feed.listFeed(LLM_LED_WORKER, 100, {})).toEqual([]);
    });

    // #2075 — the pack-only path follows the SAME gate. `industrial` + `panel` derive the
    // industrial electrician in a worker-only session (the qp_electrical case above); here the
    // identical answers sit in a session the model led, and in one finalized before the stamps.
    it.each([
      { workerId: LLM_LED_ELECTRICIAN, stamp: LLM_LED_STAMP, label: "LLM-led" },
      { workerId: LEGACY_ELECTRICIAN, stamp: {}, label: "legacy (unstamped)" },
    ])("a $label qp_electrical chat derives nothing", async ({ workerId, stamp }) => {
      await profileFromChat(
        workerId,
        "qp_electrical",
        { electrical_scope: ["industrial", "panel"] },
        stamp,
      );
      expect(await repo.listSkillRows(workerId)).toEqual([]);
      expect(await feed.listFeed(workerId, 100, {})).toEqual([]);
    });

    it("the electrician's skill is NOT written into worker_profiles.skills (option c)", async () => {
      const i = GENERIC_PACK_CHAT_CASES.findIndex(
        (c) => c.packId === "qp_electrical" && c.expected.length > 0,
      );
      const rows = await client.sql<{ skills: unknown }[]>`
        SELECT skills FROM worker_profiles WHERE worker_id = ${chatWorker(i)}::uuid
      `;
      expect(rows.map((row) => row.skills)).toEqual([[]]);
    });
  },
);

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
    VALUES (${PAYER}::uuid, 'employer', 'enc:generic-reach', 'hash:generic-reach',
            'enc:Generic Reach Fixture Co', 'active')
  `;
  // Exact-only reach sets: tier-2 widening is the publish path's concern, and an exact set makes
  // "his trade's posting reached him" unambiguous.
  for (const { id, skillId } of POSTINGS) {
    await sql`
      INSERT INTO job_postings (id, created_by, payer_id, org_label, role_title, vacancy_band,
                                status, match_skill_ids, reach_skill_ids, published_at)
      VALUES (${id}::uuid, ${PAYER}::uuid, ${PAYER}::uuid, 'Generic Reach Fixture', ${skillId}, '1',
              'open', ${JSON.stringify([skillId])}::jsonb, ${JSON.stringify([skillId])}::jsonb,
              now())
    `;
  }
}

async function cleanup(client: DbClient): Promise<void> {
  const { sql } = client;
  const postings = POSTINGS.map((p) => p.id);
  await sql`DELETE FROM job_reach WHERE worker_id = ANY(${ALL_WORKERS}::uuid[])
                                    OR job_posting_id = ANY(${postings}::uuid[])`;
  await sql`DELETE FROM job_postings WHERE id = ANY(${postings}::uuid[])`;
  await sql`DELETE FROM payers WHERE id = ${PAYER}::uuid`;
  await sql`DELETE FROM worker_industry_tenure WHERE worker_id = ANY(${ALL_WORKERS}::uuid[])`;
  await sql`DELETE FROM worker_skill WHERE worker_id = ANY(${ALL_WORKERS}::uuid[])`;
  await sql`DELETE FROM worker_attributes WHERE worker_id = ANY(${ALL_WORKERS}::uuid[])`;
  await sql`DELETE FROM worker_profiles WHERE worker_id = ANY(${ALL_WORKERS}::uuid[])`;
  await sql`DELETE FROM ai_jobs WHERE id = ANY(${ALL_WORKERS.map(aiJobFor)}::uuid[])`;
  await sql`DELETE FROM chat_sessions WHERE worker_id = ANY(${ALL_WORKERS}::uuid[])`;
  await sql`DELETE FROM workers WHERE id = ANY(${ALL_WORKERS}::uuid[])`;
}
