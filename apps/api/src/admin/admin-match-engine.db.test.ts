import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, hashPhone, type DbClient } from "@badabhai/db";

import type { RequestContext } from "../common/request-context";
import { MatchCandidatesService } from "../match/match-candidates.service";
import { MatchConfigRepository } from "../match/match-config.repository";
import { MatchConfigService } from "../match/match-config.service";
import { MatchFeedRepository } from "../match/match-feed.repository";
import { MatchFeedService } from "../match/match-feed.service";
import { WorkerSkillsRepository } from "../match/worker-skills.repository";
import { WorkersRepository } from "../workers/workers.repository";
import { AdminEngineDemoGate } from "./admin-engine-demo-gate";
import { AdminMatchEngineRepository } from "./admin-match-engine.repository";
import { AdminMatchEngineService } from "./admin-match-engine.service";

/**
 * The Engine view against a REAL Postgres, on the two claims the screen makes to an audience:
 *
 *   1. THE FUNNEL ADDS UP — `open = direct + related + hidden`, from one snapshot, with the
 *      fixture's own reach rows counted exactly (best-tier-wins applied by the real
 *      materializer, not by a fake);
 *   2. THE CARDS ARE THE FEED — same ids, same order as `MatchFeedService.getFeed`, the method
 *      the worker app is served from.
 *
 * Reach rows are written by `WorkerSkillsRepository.materializeReachForPosting`, the API's own
 * moment-③ statement, so a change to the reach rule changes this fixture with it.
 *
 *   pnpm db:migrate
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api run test admin-match-engine.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const CTX: RequestContext = { correlationId: uuid(0xe9e10001), requestId: "engine-view-db" };

const WORKER = uuid(0xe9e11001);
/** Inside the deletion grace window: a neutral 404 and never on the picker (ADR-0031 (b)). */
const LEAVING = uuid(0xe9e11002);
/** A REAL worker (not in the demo block, not allow-listed): refused, fail-closed. */
const REAL = uuid(0xe9e11003);
/** The owner's demo handset, named in the allow-list: allowed. */
const ALLOWED = uuid(0xe9e11004);

/** The gate hashes with the server pepper; the fixture hashes its phones with the same one. */
const PEPPER = "engine-view-db-test-pepper-".repeat(2);
const DEMO_PHONE = "+910000026901";
const LEAVING_PHONE = "+910000026902";
/** Reserved synthetic numbers outside the demo block — never a real SIM. */
const REAL_PHONE = "+910000017001";
const ALLOWED_PHONE = "+910000017002";
const PHONES: Record<string, string> = {
  [WORKER]: DEMO_PHONE,
  [LEAVING]: LEAVING_PHONE,
  [REAL]: REAL_PHONE,
  [ALLOWED]: ALLOWED_PHONE,
};
const ALL_WORKERS = [WORKER, LEAVING, REAL, ALLOWED];
const PAYER = uuid(0xe9e12001);

const INDUSTRY = "ind_industrial_manufacturing";
/** Held directly. */
const SKILL_DIRECT = "mskill_vmc_operator";
/** Posted on P_RELATED; the worker holds its curated neighbour instead. */
const SKILL_POSTED = "mskill_cnc_turner";
const SKILL_NEIGHBOUR = "mskill_cnc_grinding_operator";
/** Held but switched OFF — must reach nothing. */
const SKILL_OFF = "mskill_cnc_turner";

const P_DIRECT = uuid(0xe9e13001);
const P_RELATED = uuid(0xe9e13002);
const P_HIDDEN = uuid(0xe9e13003); // reach set the worker does not touch
const P_APPLIED = uuid(0xe9e13004); // reached, but already applied — not on the feed
const P_DIRECT_2 = uuid(0xe9e13005);
const ALL_POSTINGS = [P_DIRECT, P_RELATED, P_HIDDEN, P_APPLIED, P_DIRECT_2];

const SKILLS: readonly (readonly [string, string])[] = [
  [SKILL_DIRECT, "VMC Operator"],
  [SKILL_POSTED, "CNC Turner"],
  [SKILL_NEIGHBOUR, "CNC Grinding Operator"],
];

describe.skipIf(!RUN)("Engine view — funnel and feed order against Postgres", () => {
  let client!: DbClient;
  let engine!: AdminMatchEngineService;
  let feed!: MatchFeedService;

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 1 });
    await cleanup(client);
    await seed(client);

    const config = new MatchConfigService(new MatchConfigRepository(client.db));
    const feedRepo = new MatchFeedRepository(client.db);
    // Impressions are not under test; a no-op sink keeps the spine clean.
    feed = new MatchFeedService(feedRepo, config, { emitMany: async () => [] } as never);
    engine = new AdminMatchEngineService(
      new AdminMatchEngineRepository(client.db),
      feed,
      new MatchCandidatesService(feedRepo, config),
      config,
      new AdminEngineDemoGate(
        { ADMIN_ENGINE_VIEW_ALLOW_PHONES: [ALLOWED_PHONE] } as never,
        { hashPhone: (p: string) => hashPhone(p, PEPPER) } as never,
        new WorkersRepository(client.db),
      ),
    );
  }, 60_000);

  afterAll(async () => {
    if (client !== undefined) {
      await cleanup(client);
      await client.sql.end({ timeout: 5 });
    }
  });

  it("the funnel adds up, with this worker's reach counted exactly", async () => {
    const { funnel } = await engine.getWorkerView(WORKER);
    expect(funnel.open_postings).toBe(
      funnel.reached_direct + funnel.reached_related + funnel.hidden,
    );
    // Reach is per-worker, so these are exact even on a shared database.
    expect(funnel.reached_direct).toBe(3); // P_DIRECT, P_DIRECT_2, P_APPLIED
    expect(funnel.reached_related).toBe(1); // P_RELATED
    expect(funnel.already_actioned).toBe(1); // P_APPLIED
    expect(funnel.open_postings).toBeGreaterThanOrEqual(ALL_POSTINGS.length);
  });

  it("the cards are the real feed: same postings, same order", async () => {
    const view = await engine.getWorkerView(WORKER);
    const served = await feed.getFeed(WORKER, view.card_cap, {}, CTX);
    expect(view.cards.map((c) => c.job_posting_id)).toEqual(served.jobs.map((j) => j.job_id));
    expect(new Set(view.cards.map((c) => c.job_posting_id))).toEqual(
      new Set([P_DIRECT, P_DIRECT_2, P_RELATED]),
    );
    expect(view.cards.map((c) => c.rank)).toEqual([1, 2, 3]);
  });

  it("explains each card in the materializer's terms", async () => {
    const { cards } = await engine.getWorkerView(WORKER);
    const byId = new Map(cards.map((c) => [c.job_posting_id, c]));
    expect(byId.get(P_DIRECT)!.match_tier).toBe(1);
    expect(byId.get(P_DIRECT)!.why).toBe("direct: VMC Operator");
    expect(byId.get(P_RELATED)!.match_tier).toBe(2);
    expect(byId.get(P_RELATED)!.why).toBe("related: CNC Grinding Operator → CNC Turner");
  });

  it("shows skills with their switch state, and the off skill reaches nothing", async () => {
    const { skills } = await engine.getWorkerView(WORKER);
    expect(skills.find((s) => s.skill_id === SKILL_DIRECT)).toMatchObject({
      wants: true,
      months_bucketed: 36,
    });
    expect(skills.find((s) => s.skill_id === SKILL_OFF)).toMatchObject({ wants: false });
  });

  it("the posting view splits reach by tier and lists the applicant", async () => {
    const view = await engine.getPostingView(P_RELATED);
    expect(view.posted_skills.map((s) => s.skill_id)).toEqual([SKILL_POSTED]);
    expect(view.related_skills.map((s) => s.skill_id)).toEqual([SKILL_NEIGHBOUR]);
    expect(view.reach.tier2).toBeGreaterThanOrEqual(1);
    expect(view.reach.total).toBe(view.reach.tier1 + view.reach.tier2);

    const applied = await engine.getPostingView(P_APPLIED);
    expect(applied.candidates.map((c) => c.worker_id)).toContain(WORKER);
  });

  it("DEMO WORKERS ONLY: a real worker is refused with the neutral 404 and is never on the picker", async () => {
    await expect(engine.getWorkerView(REAL)).rejects.toMatchObject({ status: 404 });
    const { workers } = await engine.listRecentWorkers(50);
    expect(workers.map((w) => w.worker_id)).not.toContain(REAL);
  });

  it("a demo-block worker and an allow-listed handset are both allowed", async () => {
    expect((await engine.getWorkerView(WORKER)).worker_id).toBe(WORKER);
    expect((await engine.getWorkerView(ALLOWED)).worker_id).toBe(ALLOWED);
    const ids = (await engine.listRecentWorkers(50)).workers.map((w) => w.worker_id);
    expect(ids).toEqual(expect.arrayContaining([WORKER, ALLOWED]));
  });

  it("a posting's ranked applicants show demo workers only, renumbered from 1", async () => {
    const view = await engine.getPostingView(P_APPLIED);
    // REAL (48 skill months) out-ranks WORKER (36) on the payer's list; on this screen he is
    // absent, and WORKER is rank 1 — no gap betrays him.
    expect(view.candidates.map((c) => [c.worker_id, c.rank])).toEqual([[WORKER, 1]]);
  });

  it("a posting's reach counts DEMO workers only", async () => {
    // P_DIRECT reaches every holder of SKILL_DIRECT: WORKER, REAL and ALLOWED (LEAVING too, but
    // he is pending deletion). Only the two demo workers are counted.
    const view = await engine.getPostingView(P_DIRECT);
    expect(view.reach).toEqual({ total: 2, tier1: 2, tier2: 0 });
  });

  it("a worker pending deletion is a neutral 404 and is never on the picker", async () => {
    await expect(engine.getWorkerView(LEAVING)).rejects.toMatchObject({ status: 404 });
    const { workers } = await engine.listRecentWorkers(50);
    expect(workers.map((w) => w.worker_id)).not.toContain(LEAVING);
  });

  it("the recent-worker picker lists the fixture worker by short ref only", async () => {
    const { workers } = await engine.listRecentWorkers(50);
    const me = workers.find((w) => w.worker_id === WORKER);
    if (me) {
      expect(Object.keys(me).sort()).toEqual([
        "created_at",
        "short_ref",
        "trade_label",
        "worker_id",
      ]);
    }
  });
});

async function seed(client: DbClient): Promise<void> {
  const { sql } = client;

  for (const [skillId, label] of SKILLS) {
    await sql`
      INSERT INTO skill (skill_id, label_en, domain_id, source, status, kind, industry_id)
      VALUES (${skillId}, ${label}, 'cnc-machining', 'rvm', 'active', 'match_skill', ${INDUSTRY})
      ON CONFLICT (skill_id) DO NOTHING
    `;
  }

  // Synthetic markers only — no real phone number exists in this fixture.
  for (const id of [WORKER, REAL, ALLOWED]) {
    await sql`
      INSERT INTO workers (id, phone_e164, phone_hash, status)
      VALUES (${id}::uuid, ${`enc:engine-view-${id.slice(-4)}`}, ${hashPhone(PHONES[id]!, PEPPER)},
              'active')
      ON CONFLICT (id) DO NOTHING
    `;
  }
  for (const id of [REAL, ALLOWED]) {
    await sql`
      INSERT INTO worker_skill (worker_id, skill_id, industry_id, months_bucketed, wants, source)
      VALUES (${id}::uuid, ${SKILL_DIRECT}, ${INDUSTRY}, 24, true, 'interview')
    `;
  }
  await sql`
    INSERT INTO workers (id, phone_e164, phone_hash, status, deletion_scheduled_at, created_at)
    VALUES (${LEAVING}::uuid, 'enc:engine-view-leaving', ${hashPhone(LEAVING_PHONE, PEPPER)}, 'active',
            now(), now() + interval '1 day')
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO worker_skill (worker_id, skill_id, industry_id, months_bucketed, wants, source)
    VALUES (${LEAVING}::uuid, ${SKILL_DIRECT}, ${INDUSTRY}, 24, true, 'interview')
  `;
  for (const [skill, months, wants] of [
    [SKILL_DIRECT, 36, true],
    [SKILL_NEIGHBOUR, 12, true],
    [SKILL_OFF, 60, false],
  ] as const) {
    await sql`
      INSERT INTO worker_skill (worker_id, skill_id, industry_id, months_bucketed, wants, source)
      VALUES (${WORKER}::uuid, ${skill}, ${INDUSTRY}, ${months}, ${wants}, 'interview')
    `;
  }
  await sql`
    INSERT INTO worker_industry_tenure (worker_id, industry_id, calendar_months)
    VALUES (${WORKER}::uuid, ${INDUSTRY}, 60)
  `;

  const postings: { id: string; posted: string[]; reach: string[]; published: string }[] = [
    {
      id: P_DIRECT,
      posted: [SKILL_DIRECT],
      reach: [SKILL_DIRECT],
      published: "2099-01-05T00:00:00Z",
    },
    {
      id: P_RELATED,
      posted: [SKILL_POSTED],
      reach: [SKILL_POSTED, SKILL_NEIGHBOUR],
      published: "2099-01-04T00:00:00Z",
    },
    {
      id: P_HIDDEN,
      posted: ["mskill_cnc_programmer"],
      reach: ["mskill_cnc_programmer"],
      published: "2099-01-03T00:00:00Z",
    },
    {
      id: P_APPLIED,
      posted: [SKILL_DIRECT],
      reach: [SKILL_DIRECT],
      published: "2099-01-02T00:00:00Z",
    },
    {
      id: P_DIRECT_2,
      posted: [SKILL_DIRECT],
      reach: [SKILL_DIRECT],
      published: "2099-01-06T00:00:00Z",
    },
  ];
  const skills = new WorkerSkillsRepository(client.db);
  for (const p of postings) {
    await sql`
      INSERT INTO job_postings (id, created_by, payer_id, org_label, role_title, vacancy_band,
                                status, match_skill_ids, reach_skill_ids, published_at, city)
      VALUES (${p.id}::uuid, ${PAYER}::uuid, ${PAYER}::uuid, 'Engine View Fixture',
              'Engine View Role', '1', 'open', ${JSON.stringify(p.posted)}::jsonb,
              ${JSON.stringify(p.reach)}::jsonb, ${p.published}::timestamptz, 'Pune')
    `;
    await skills.materializeReachForPosting(p.id, p.posted, p.reach);
  }

  // The applied posting: a snapshot row exactly as moment ⑤ writes one (tier 1, his months).
  await sql`
    INSERT INTO applications (worker_id, job_posting_id, action, match_tier, skill_months,
                              industry_months, engine_version)
    VALUES (${WORKER}::uuid, ${P_APPLIED}::uuid, 'applied', 1, 36, 60, 'v1')
  `;
  await sql`
    INSERT INTO applications (worker_id, job_posting_id, action, match_tier, skill_months,
                              industry_months, engine_version)
    VALUES (${REAL}::uuid, ${P_APPLIED}::uuid, 'applied', 1, 48, 60, 'v1')
  `;
}

async function cleanup(client: DbClient): Promise<void> {
  const { sql } = client;
  for (const id of ALL_WORKERS) {
    await sql`DELETE FROM applications WHERE worker_id = ${id}::uuid`;
    await sql`DELETE FROM job_reach WHERE worker_id = ${id}::uuid`;
  }
  for (const id of ALL_POSTINGS) {
    await sql`DELETE FROM job_reach WHERE job_posting_id = ${id}::uuid`;
    await sql`DELETE FROM job_postings WHERE id = ${id}::uuid`;
  }
  await sql`DELETE FROM worker_skill WHERE worker_id = ${WORKER}::uuid`;
  await sql`DELETE FROM worker_industry_tenure WHERE worker_id = ${WORKER}::uuid`;
  for (const id of ALL_WORKERS) {
    await sql`DELETE FROM worker_skill WHERE worker_id = ${id}::uuid`;
    await sql`DELETE FROM workers WHERE id = ${id}::uuid`;
  }
}
