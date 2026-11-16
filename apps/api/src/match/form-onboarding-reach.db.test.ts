import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDbClient,
  loadFormTenureAnswers,
  workerPackAnswers,
  type DbClient,
} from "@badabhai/db";
import { getMatchSkill, MATCH_SKILLS } from "@badabhai/taxonomy";

import type { EventsService } from "../events/events.service";
import { otherAnswerValue, packAnswerRowFor } from "../profiling/pack-answer-row";
import { WorkerAttributesRepository } from "../profiles/worker-attributes.repository";
import { descriptorForKind } from "../profiling/roles/role-registry";
import { MatchConfigRepository } from "./match-config.repository";
import { MatchConfigService } from "./match-config.service";
import { MatchFeedRepository } from "./match-feed.repository";
import { WorkerSkillsRepository } from "./worker-skills.repository";
import { WorkerSkillsService } from "./worker-skills.service";
import {
  answerRecordsFor,
  attributesFor,
  latestPack,
  TRADE_FORM_CASES,
} from "./form-onboarding.test-support";

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
/** #2753 item 2 — the form-tenure workers, inside this file's own 0x7Bxx block. */
const tenureWorker = (i: number): string => uuid(0x7bc0 + i);
const TENURE_WORKERS = Array.from({ length: 8 }, (_, i) => tenureWorker(i));

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

  /**
   * #2753 item 2 — A FORM WORKER'S EXPERIENCE BAND REACHES `worker_skill.months_bucketed`.
   *
   * The issue's check, against the real tables: a form worker who picked the 3–5 years band shows
   * that experience (48 months, through the real bucketing) on his skill row and on the feed's
   * matched skill; with no band he shows as not recorded (0). Answers are written by the SAME
   * builders the form uses (`answerRecordsFor` → `packAnswerRowFor` into `worker_pack_answer`, the
   * projector into `worker_attributes`), and the read is the shared `loadFormTenureAnswers`
   * statement `db:backfill:worker-skills` runs too.
   */
  describe("a trade form's experience band (#2753 item 2)", () => {
    const ON = { FORM_TENURE_MONTHS_ENABLED: true, FORM_TYPED_TENURE_DERIVE_ENABLED: false };
    const BOTH = { FORM_TENURE_MONTHS_ENABLED: true, FORM_TYPED_TENURE_DERIVE_ENABLED: true };
    const serviceWith = (serverConfig: typeof ON): WorkerSkillsService =>
      new WorkerSkillsService(
        repo,
        new MatchConfigService(new MatchConfigRepository(client.db)),
        { emit: async () => undefined } as unknown as EventsService,
        serverConfig,
      );

    /** A form worker: his chips (and, when given, his tenure answer) under each form's pack. */
    async function formWorkerWith(
      workerId: string,
      forms: readonly {
        kind: (typeof TRADE_FORM_CASES)[number]["kind"];
        chips: Readonly<Record<string, readonly string[]>>;
        tenure?: { band: string } | { typed: string };
      }[],
      totalYears?: number,
    ): Promise<void> {
      await client.sql`
        INSERT INTO workers (id, phone_e164, phone_hash, status)
        VALUES (${workerId}::uuid, ${`enc:form-tenure-${workerId}`},
                ${`hash:form-tenure-${workerId}`}, 'active')
      `;
      if (totalYears !== undefined) {
        await client.sql`
          INSERT INTO worker_profiles (worker_id, canonical_role_id, skills, experience,
                                       profile_status)
          VALUES (${workerId}::uuid, NULL, '[]'::jsonb,
                  ${JSON.stringify({ total_years: totalYears })}::jsonb, 'extracted')
        `;
      }
      for (const form of forms) {
        const descriptor = descriptorForKind(form.kind)!;
        const pack = latestPack(descriptor.packId);
        const tenureKey = descriptor.tenureQuestionKey;
        const answers =
          form.tenure !== undefined && "band" in form.tenure
            ? { ...form.chips, [tenureKey]: [form.tenure.band] }
            : form.chips;
        await attributes.upsertMany(
          attributesFor(pack, answers).map((attribute) => ({
            workerId,
            attributeKey: attribute.attributeKey,
            valueKind: attribute.valueKind,
            valueBool: attribute.valueKind === "boolean" ? (attribute.value as boolean) : null,
            valueNumber:
              attribute.valueKind === "number" ? String(attribute.value as number) : null,
            valueText: attribute.valueKind === "text" ? (attribute.value as string) : null,
            valueTextList:
              attribute.valueKind === "text_list"
                ? [...(attribute.value as readonly string[])]
                : null,
            source: attribute.source,
            questionKey: attribute.attributeKey,
            packId: descriptor.packId,
            packVersion: pack.version,
            sessionId: null,
          })),
        );
        const records = answerRecordsFor(pack, answers);
        if (form.tenure !== undefined && "typed" in form.tenure) {
          // "Koi aur — khud likhein": the typed words, as the form's own "other" marker.
          records.push({
            question_key: tenureKey,
            target_field: tenureKey,
            status: "answered",
            value_raw: form.tenure.typed,
            value_normalized: otherAnswerValue(form.tenure.typed),
            evidence: null,
            turn: 0,
            history: [],
          });
        }
        for (const record of records) {
          const row = packAnswerRowFor({
            workerId,
            sessionId: null,
            packId: descriptor.packId,
            packVersion: pack.version,
            record,
            source: "form",
          });
          if (row !== null) await client.db.insert(workerPackAnswers).values(row);
        }
      }
    }

    const monthsOf = async (workerId: string): Promise<Record<string, number>> =>
      Object.fromEntries(
        (await repo.listSkillRows(workerId)).map((row) => [row.skillId, row.monthsBucketed]),
      );
    const SHEET_METAL_CHIPS = { sheet_metal_machine: ["cnc_press_brake"] };
    const WELDER_CHIPS = { welding_process: ["mig_mag"] };

    it("the 3–5 years band: 48 months on his skill, his industry and his V1 feed", async () => {
      const workerId = tenureWorker(0);
      await formWorkerWith(workerId, [
        { kind: "sheet_metal_worker", chips: SHEET_METAL_CHIPS, tenure: { band: "three_to_five" } },
      ]);
      await serviceWith(ON).rebuildForWorker(workerId);
      expect(await monthsOf(workerId)).toEqual({ mskill_sheet_metal_worker: 48 });
      expect(await repo.findIndustryMonths(workerId, "ind_industrial_manufacturing")).toBe(48);
      const served = await feed.listFeed(workerId, 100, {});
      expect(served.map((row) => row.matchedSkillId)).toEqual(["mskill_sheet_metal_worker"]);
    });

    it("OFF: the same worker reads 0 months — today's derivation", async () => {
      const workerId = tenureWorker(1);
      await formWorkerWith(workerId, [
        { kind: "sheet_metal_worker", chips: SHEET_METAL_CHIPS, tenure: { band: "three_to_five" } },
      ]);
      await service.rebuildForWorker(workerId);
      expect(await monthsOf(workerId)).toEqual({ mskill_sheet_metal_worker: 0 });
    });

    it("no band, or a fresher band, shows as not recorded (0)", async () => {
      await formWorkerWith(tenureWorker(2), [
        { kind: "sheet_metal_worker", chips: SHEET_METAL_CHIPS },
      ]);
      await formWorkerWith(tenureWorker(3), [
        { kind: "sheet_metal_worker", chips: SHEET_METAL_CHIPS, tenure: { band: "fresher" } },
      ]);
      for (const workerId of [tenureWorker(2), tenureWorker(3)]) {
        await serviceWith(ON).rebuildForWorker(workerId);
        expect(await monthsOf(workerId)).toEqual({ mskill_sheet_metal_worker: 0 });
      }
    });

    it("a typed tenure counts only with BOTH switches on", async () => {
      const workerId = tenureWorker(4);
      await formWorkerWith(workerId, [
        { kind: "sheet_metal_worker", chips: SHEET_METAL_CHIPS, tenure: { typed: "das saal" } },
      ]);
      await serviceWith(ON).rebuildForWorker(workerId);
      expect(await monthsOf(workerId)).toEqual({ mskill_sheet_metal_worker: 0 });
      await serviceWith(BOTH).rebuildForWorker(workerId);
      expect(await monthsOf(workerId)).toEqual({ mskill_sheet_metal_worker: 120 });
    });

    it("a profile's own total_years is not overridden", async () => {
      const workerId = tenureWorker(5);
      await formWorkerWith(
        workerId,
        [{ kind: "sheet_metal_worker", chips: SHEET_METAL_CHIPS, tenure: { band: "above_ten" } }],
        5,
      );
      await serviceWith(ON).rebuildForWorker(workerId);
      expect(await monthsOf(workerId)).toEqual({ mskill_sheet_metal_worker: 60 });
    });

    it("two forms give two skills, each with its own band", async () => {
      const workerId = tenureWorker(6);
      await formWorkerWith(workerId, [
        { kind: "sheet_metal_worker", chips: SHEET_METAL_CHIPS, tenure: { band: "one_to_three" } },
        { kind: "welder", chips: WELDER_CHIPS, tenure: { band: "above_ten" } },
      ]);
      await serviceWith(ON).rebuildForWorker(workerId);
      expect(await monthsOf(workerId)).toEqual({
        mskill_mig_welder: 144,
        mskill_sheet_metal_worker: 24,
      });
    });

    it("the shared statement reads every worker's tenure answers in ONE call", async () => {
      const rows = await loadFormTenureAnswers(client.db, TENURE_WORKERS);
      const byWorker = new Map<string, string[]>();
      for (const row of rows) {
        byWorker.set(row.workerId, [...(byWorker.get(row.workerId) ?? []), row.packId].sort());
      }
      // Worker 2 answered no tenure question and worker 7 does not exist: neither has a row.
      expect(Object.fromEntries(byWorker)).toEqual({
        [tenureWorker(0)]: ["qp_sheet_metal_fab"],
        [tenureWorker(1)]: ["qp_sheet_metal_fab"],
        [tenureWorker(3)]: ["qp_sheet_metal_fab"],
        [tenureWorker(4)]: ["qp_sheet_metal_fab"],
        [tenureWorker(5)]: ["qp_sheet_metal_fab"],
        [tenureWorker(6)]: ["qp_sheet_metal_fab", "qp_welding_trade"],
      });
      // Only the tenure question: the chips stored beside it never come back from this read.
      expect(new Set(rows.map((row) => row.questionKey))).toEqual(
        new Set(["sheet_metal_experience", "welding_experience"]),
      );
    });
  });

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
  const workers = [...ALL_WORKERS, ...TENURE_WORKERS, uuid(0x7bff)];
  const postings = POSTINGS.map((p) => p.id);
  await sql`DELETE FROM job_reach WHERE worker_id = ANY(${workers}::uuid[])
                                    OR job_posting_id = ANY(${postings}::uuid[])`;
  await sql`DELETE FROM job_postings WHERE id = ANY(${postings}::uuid[])`;
  await sql`DELETE FROM payers WHERE id = ${PAYER}::uuid`;
  await sql`DELETE FROM worker_industry_tenure WHERE worker_id = ANY(${workers}::uuid[])`;
  await sql`DELETE FROM worker_skill WHERE worker_id = ANY(${workers}::uuid[])`;
  await sql`DELETE FROM worker_attributes WHERE worker_id = ANY(${workers}::uuid[])`;
  await sql`DELETE FROM worker_pack_answer WHERE worker_id = ANY(${workers}::uuid[])`;
  await sql`DELETE FROM worker_profiles WHERE worker_id = ANY(${workers}::uuid[])`;
  await sql`DELETE FROM workers WHERE id = ANY(${workers}::uuid[])`;
}
