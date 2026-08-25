import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applications,
  createDbClient,
  events,
  jobPostings,
  jobReach,
  skills,
  workerIndustryTenure,
  workers,
  workerSkills,
  type DbClient,
} from "@badabhai/db";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { mintPayerSession } from "./helpers/payer-session";

/**
 * THE CORE MATCHING-V1 JOB JOURNEY (e2e, ADR-0036 moments ③④⑤⑥) against a LIVE API +
 * DB + Redis. This is the end-to-end path the whole product depends on and no other
 * suite exercised (docs/payer-agent/BUSINESS_FLOWS.md: "no test exercises 'create a
 * posting, then open its applicants'"):
 *
 *   payer creates posting -> publishes with match_skill_ids -> `job_reach` MATERIALIZES
 *   SYNCHRONOUSLY -> a supplied worker SEES the posting on /feed (`feed.shown_v2`) ->
 *   APPLIES through the reach gate (`application.submitted`, exactly once) -> the payer's
 *   applicant list ranks him off the frozen snapshot -> the full event chain reads back
 *   in order from the spine, PII-free.
 *
 * SUPPLY IS SEEDED VIA SQL (the apply-freeze.test.ts fixture pattern), NOT through the
 * async profile-extraction pipeline: publish-time materialization only sees EXISTING
 * `worker_skill AND wants` rows, so supply must exist BEFORE the publish PATCH. Seeding
 * directly also makes the tier split deterministic: worker A holds the POSTED skill
 * (tier 1); worker B holds only a RELATED skill (tier 2).
 *
 * Opt-in (superset of payer-tenancy.e2e.test.ts):
 *   1. docker compose up -d postgres redis
 *   2. pnpm db:migrate && pnpm db:seed:jobs (not needed here) && db:seed:match:vocabulary --apply
 *   3. Start the API WITH MATCHING ARMED:
 *      MATCH_V1_ENABLED=true TEST_LOGIN_ENABLED=true TEST_LOGIN_TOKEN=<32+ chars>
 *      PAYER_TEST_LOGIN_ENABLED=true PAYER_TEST_LOGIN_TOKEN=<32+ chars>
 *      INTERNAL_SERVICE_TOKEN=<token> pnpm --filter @badabhai/api start (NODE_ENV=test/dev)
 *   4. RUN_E2E=1 E2E_MATCH_V1=1 MATCH_V1_ENABLED=true TEST_LOGIN_TOKEN=<same>
 *      PAYER_TEST_LOGIN_TOKEN=<same> INTERNAL_SERVICE_TOKEN=<token>
 *      pnpm --filter @badabhai/e2e test
 *
 * WHY THE DEDICATED `E2E_MATCH_V1` GATE: `MATCH_V1_ENABLED` is OFF by default everywhere
 * (packages/config server.ts) — including the CI e2e job today. Under a flag-off API this
 * suite would hit the LEGACY paths and silently prove the wrong system (feed.shown v1, the
 * weighted reach pool). The suite therefore refuses to run unless BOTH the runner and the
 * API are explicitly armed; a vacuous pass is treated as a defect (ci.yml doctrine).
 */

const RUN_E2E = process.env.RUN_E2E === "1";
const TEST_LOGIN_TOKEN = process.env.TEST_LOGIN_TOKEN ?? "";
const PAYER_TEST_LOGIN_TOKEN = process.env.PAYER_TEST_LOGIN_TOKEN ?? "";
// The runner-side half of the flag arming check: the API process must ALSO be started
// with MATCH_V1_ENABLED=true for the V1 branches to serve. Both halves read the same env
// var name; the dedicated opt-in below keeps the suite inert where the flag culture has
// not landed yet.
const MATCH_V1 = process.env.MATCH_V1_ENABLED === "true";
const E2E_MATCH_V1 = process.env.E2E_MATCH_V1 === "1";
const RUN =
  RUN_E2E &&
  MATCH_V1 &&
  E2E_MATCH_V1 &&
  TEST_LOGIN_TOKEN.length > 0 &&
  PAYER_TEST_LOGIN_TOKEN.length > 0;

const API_URL = process.env.E2E_API_URL ?? "http://localhost:3001";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";
const CONSENT_VERSION = "2026-06-01";

// The closed-vocabulary pair from `RELATED_MATCH_SKILLS` (@badabhai/taxonomy):
// mskill_cnc_turner <-> mskill_vmc_operator. The posting asks ONLY for VMC, so A
// qualifies tier 1 directly and B qualifies tier 2 through the curated relation.
const SKILL_POSTED = "mskill_vmc_operator";
const SKILL_RELATED = "mskill_cnc_turner";
const INDUSTRY = "ind_industrial_manufacturing";
const CITY = "Pune";

/** Deterministic uuids so cleanup removes exactly what this suite created. */
function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}
const WORKER_A = uuid(0xa001); // holds the POSTED skill -> tier 1
const WORKER_B = uuid(0xa002); // holds only the RELATED skill -> tier 2

async function req(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; testLogin?: boolean } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.testLogin) headers["x-test-login-token"] = TEST_LOGIN_TOKEN;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

let phoneSeq = Math.floor(Math.random() * 90_000);
function syntheticPhone(): string {
  phoneSeq = (phoneSeq + 1) % 100_000;
  return `+9100000${String(phoneSeq).padStart(5, "0")}`;
}

describe.skipIf(!RUN)("Matching V1 job journey (e2e, ADR-0036 moments ③-⑥)", () => {
  let client!: DbClient;
  let payer!: { payerId: string; token: string };
  let postingId = "";
  /** Minted (seam-created) worker ids — cleanup must remove their rows too. */
  const mintedWorkerIds: string[] = [];

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL);
  });

  afterAll(async () => {
    // CHILDREN BEFORE PARENTS. The suite owns its rows; everything keys off the two
    // seeded workers, the minted workers, or the posting it created.
    if (client) {
      const allWorkerIds = [WORKER_A, WORKER_B, ...mintedWorkerIds];
      if (postingId) {
        await client.db.delete(applications).where(inArray(applications.jobPostingId, [postingId]));
        await client.db.delete(jobReach).where(inArray(jobReach.jobPostingId, [postingId]));
        await client.db.delete(jobPostings).where(inArray(jobPostings.id, [postingId]));
      }
      await client.db.delete(workerIndustryTenure).where(inArray(workerIndustryTenure.workerId, allWorkerIds));
      await client.db.delete(workerSkills).where(inArray(workerSkills.workerId, allWorkerIds));
      // Minted workers were CREATED by the seam in this run — remove them; the seeded
      // fixture ids are deleted the same way.
      await client.db.delete(workers).where(inArray(workers.id, allWorkerIds));
      await client.sql.end({ timeout: 5 });
    }
  });

  /** Seed SUPPLY first: the skills, two workers, their skills and industry tenure. */
  it("supply exists BEFORE publish — publish-time materialization sees only existing wants", async () => {
    // ON CONFLICT DO NOTHING: these vocabulary ids may already exist (D1 seed); the
    // suite only needs them PRESENT, never rewritten.
    await client.db
      .insert(skills)
      .values([
        {
          skillId: SKILL_POSTED,
          labelEn: "VMC Operator",
          source: "rvm",
          status: "active",
          kind: "match_skill",
          industryId: INDUSTRY,
        },
        {
          skillId: SKILL_RELATED,
          labelEn: "CNC Turner",
          source: "rvm",
          status: "active",
          kind: "match_skill",
          industryId: INDUSTRY,
        },
      ])
      .onConflictDoNothing();

    // NO PII: synthetic encrypted-phone markers, exactly like every other gate file.
    await client.db
      .insert(workers)
      .values([
        {
          id: WORKER_A,
          phoneE164: "enc:e2e-journey-a",
          phoneHash: `hash:e2e-journey-a:${randomUUID()}`,
          status: "active" as const,
        },
        {
          id: WORKER_B,
          phoneE164: "enc:e2e-journey-b",
          phoneHash: `hash:e2e-journey-b:${randomUUID()}`,
          status: "active" as const,
        },
      ])
      .onConflictDoNothing();

    // A holds the posted skill with 60 bucketed months (past the 36-month tier floor);
    // B holds ONLY the related skill with fewer months. `wants` is the worker-intent
    // half of the hard visibility gate.
    await client.db
      .insert(workerSkills)
      .values([
        {
          workerId: WORKER_A,
          skillId: SKILL_POSTED,
          industryId: INDUSTRY,
          monthsBucketed: 60,
          wants: true,
          source: "derived_coarse",
        },
        {
          workerId: WORKER_B,
          skillId: SKILL_RELATED,
          industryId: INDUSTRY,
          monthsBucketed: 12,
          wants: true,
          source: "derived_coarse",
        },
      ])
      .onConflictDoNothing();

    await client.db
      .insert(workerIndustryTenure)
      .values([
        { workerId: WORKER_A, industryId: INDUSTRY, calendarMonths: 60 },
        { workerId: WORKER_B, industryId: INDUSTRY, calendarMonths: 12 },
      ])
      .onConflictDoNothing();
  });

  it("payer CREATES a posting self-serve and job_posting.created lands on the spine", async () => {
    payer = await mintPayerSession({ role: "employer" });
    const r = await req("POST", "/payer/job-postings", {
      token: payer.token,
      body: {
        org_label: "E2E Journey Works",
        role_title: "VMC Operator (journey e2e)",
        vacancy_band: "1",
        description: "Journey fixture. Fanuc VMC operate karna.",
      },
    });
    expect(r.status).toBe(201);
    expect(r.json.id).toBeTruthy();
    postingId = r.json.id as string;
  });

  it("PUBLISH with match_skill_ids materializes job_reach synchronously — A tier 1, B tier 2", async () => {
    const r = await req("PATCH", `/payer/job-postings/${postingId}`, {
      token: payer.token,
      body: {
        status: "open",
        match_skill_ids: [SKILL_POSTED],
        city: CITY,
        pay_min: 18000,
        pay_max: 24000,
        shift: "day",
      },
    });
    expect(r.status).toBe(200);

    // Reach is computed ON WRITE — no polling, no queue. Read the rows back.
    const reach = await client.db
      .select()
      .from(jobReach)
      .where(inArray(jobReach.jobPostingId, [postingId]));

    const byWorker = new Map(reach.map((row) => [row.workerId, row]));
    expect(byWorker.get(WORKER_A)?.matchTier).toBe(1);
    expect(byWorker.get(WORKER_A)?.matchedSkillId).toBe(SKILL_POSTED);
    // Tier 2 through the curated relation — the "via related" economy working live.
    expect(byWorker.get(WORKER_B)?.matchTier).toBe(2);
    expect(byWorker.get(WORKER_B)?.matchedSkillId).toBe(SKILL_RELATED);

    const posting = (
      await client.db.select().from(jobPostings).where(inArray(jobPostings.id, [postingId]))
    )[0]!;
    // published_at is FIRST-OPEN stamped; the reach set is posted ∪ related.
    expect(posting.publishedAt).not.toBeNull();
    expect([...posting.reachSkillIds].sort()).toEqual([SKILL_RELATED, SKILL_POSTED].sort());
  });

  it("WORKER FEED shows the posting to the tier-1 worker with V1 card fields + feed.shown_v2", async () => {
    const login = await req("POST", "/auth/test-login", {
      body: { phone: syntheticPhone() },
      testLogin: true,
    });
    expect(login.status).toBe(200);
    const token = login.json.access_token as string;

    // Consent is mandatory before any feed read (ConsentGuard).
    const c = await req("POST", "/consent/accept", {
      token,
      body: { consent_version: CONSENT_VERSION, purposes: ["profiling", "resume_generation"] },
    });
    expect(c.status).toBe(201);

    const feed = await req("GET", "/feed?limit=50", { token });
    expect(feed.status).toBe(200);
    const card = (feed.json.jobs as any[]).find((j) => j.job_id === postingId);
    expect(card, "the freshly published posting must appear in the worker's feed").toBeTruthy();
    expect(card.match_tier).toBe(1);
    expect(card.via_related).toBe(false);
    expect(card.matched_skill_label).toBeTruthy();

    const shown = await client.db.select().from(events).where(inArray(events.eventName, ["feed.shown_v2"]));
    const mine = shown.filter((e) => (e.payload as any)?.job_posting_id === postingId);
    expect(mine.length, "one feed.shown_v2 per served card").toBeGreaterThanOrEqual(1);
    expect(mine.some((e) => (e.payload as any)?.worker_id === (login.json.worker_id as string))).toBe(true);
  });

  it("APPLY passes the reach gate, is idempotent, and emits application.submitted exactly once", async () => {
    // ── The gate is CLOSED by default: a minted worker with NO reach row gets the
    // neutral 404 — visibility is the materialized set, fail-closed.
    const outsider = await req("POST", "/auth/test-login", {
      body: { phone: syntheticPhone() },
      testLogin: true,
    });
    const outsiderToken = outsider.json.access_token as string;
    mintedWorkerIds.push(outsider.json.worker_id as string);
    await req("POST", "/consent/accept", {
      token: outsiderToken,
      body: { consent_version: CONSENT_VERSION, purposes: ["profiling", "resume_generation"] },
    });
    const blocked = await req("POST", `/applications/${postingId}/apply`, {
      token: outsiderToken,
      body: { source_surface: "feed" },
    });
    expect(blocked.status).toBe(404);

    // ── The happy path: mint the APPLIER first, then attach the supply + reach row the
    // per-worker reconciliation would have written had he been profiled before publish
    // (the seam always mints a NEW worker, so attaching to the MINTED id is the honest
    // e2e shape — it drives the exact public route + the exact reach-row shape the
    // pipeline writes, minus only the async extraction).
    const mint = await req("POST", "/auth/test-login", {
      body: { phone: syntheticPhone() },
      testLogin: true,
    });
    const applierId = mint.json.worker_id as string;
    const applierToken = mint.json.access_token as string;
    mintedWorkerIds.push(applierId);
    await req("POST", "/consent/accept", {
      token: applierToken,
      body: { consent_version: CONSENT_VERSION, purposes: ["profiling", "resume_generation"] },
    });

    // The worker ROW already exists (the seam's mint created it) — only SUPPLY and
    // REACH are attached here.
    await client.db
      .insert(workerSkills)
      .values({
        workerId: applierId,
        skillId: SKILL_POSTED,
        industryId: INDUSTRY,
        monthsBucketed: 48,
        wants: true,
        source: "derived_coarse",
      })
      .onConflictDoNothing();
    await client.db
      .insert(workerIndustryTenure)
      .values({ workerId: applierId, industryId: INDUSTRY, calendarMonths: 48 })
      .onConflictDoNothing();
    await client.db
      .insert(jobReach)
      .values({
        jobPostingId: postingId,
        workerId: applierId,
        matchTier: 1,
        matchedSkillId: SKILL_POSTED,
      })
      .onConflictDoNothing();

    const a1 = await req("POST", `/applications/${postingId}/apply`, {
      token: applierToken,
      body: { rank: 1, source_surface: "feed" },
    });
    expect(a1.status).toBe(200);
    expect(a1.json.action).toBe("applied");

    // IDEMPOTENT: the second apply resolves to the SAME application row, and the spine
    // holds exactly ONE application.submitted for the pair (keyed emit).
    const a2 = await req("POST", `/applications/${postingId}/apply`, {
      token: applierToken,
      body: { rank: 1, source_surface: "feed" },
    });
    expect(a2.status).toBe(200);
    expect(a2.json.application_id ?? a2.json.applicationId).toBe(
      a1.json.application_id ?? a1.json.applicationId,
    );

    const subs = await client.db
      .select()
      .from(events)
      .where(inArray(events.eventName, ["application.submitted"]));
    const mine = subs.filter((e) => (e.payload as any)?.worker_id === applierId);
    expect(mine.length, "exactly one application.submitted for this (worker, posting)").toBe(1);
    if (mine[0]?.idempotencyKey) expect(mine[0]?.idempotencyKey).toContain(applierId);
  });

  it("APPLICANTS list ranks the applied worker with engine provenance", async () => {
    const r = await req("GET", `/payer/reach/jobs/${postingId}/applicants`, {
      token: payer.token,
    });
    expect(r.status).toBe(200);
    expect(r.json.jobId).toBe(postingId);
    const list = r.json.applicants as any[];
    expect(list.length).toBeGreaterThanOrEqual(1);
    const top = list[0];
    // camelCase snapshot projection + the frozen engine version (V1 contract).
    expect(top.engineVersion).toBe("v1.0");
    expect(top.applicationId).toBeTruthy();
    expect(top.matchTier).toBe(1);
  });

  it("EVENT CHAIN — created -> updated -> reach_materialized -> shown_v2 -> submitted, PII-free", async () => {
    const rows = await client.db
      .select()
      .from(events)
      .where(inArray(events.subjectId, [postingId]));
    const names = rows.map((e) => e.eventName);

    const indexOf = (name: string) => names.indexOf(name);
    expect(indexOf("job_posting.created")).toBeGreaterThanOrEqual(0);
    expect(indexOf("job_posting.updated")).toBeGreaterThan(indexOf("job_posting.created"));
    expect(indexOf("job_posting.reach_materialized")).toBeGreaterThan(
      indexOf("job_posting.updated"),
    );
    expect(names).toContain("feed.shown_v2");
    expect(names).toContain("application.submitted");

    // The materialized event carries the trigger + counts (E13 audit shape).
    const mat = rows.find((e) => e.eventName === "job_posting.reach_materialized");
    expect((mat!.payload as any).trigger).toBe("publish");

    // PII sweep over EVERY payload this journey produced: ids/enums/counts only.
    const forbidden = ["full_name", "phone", "phone_e164", "employer", "address", "org"];
    for (const row of rows) {
      const flat = JSON.stringify(row.payload).toLowerCase();
      for (const key of forbidden) expect(flat, `${row.eventName} leaked "${key}"`).not.toContain(key);
    }
  });
});
