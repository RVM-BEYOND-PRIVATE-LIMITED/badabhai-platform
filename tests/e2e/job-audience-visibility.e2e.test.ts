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
import { and, eq, inArray } from "drizzle-orm";
import { mintPayerSession } from "./helpers/payer-session";

/**
 * #2746 — AN RVM-ONLY JOB NEVER REACHES A BADABHAI WORKER, end to end against a LIVE API + DB +
 * Redis: publish -> `job_reach` -> /feed -> detail -> search -> apply.
 *
 *   A company publishes two postings on the same skill: one for RVM students only, one for both.
 *   A supplied BadaBhai worker is reached by `both` at publish and NEVER by the RVM-only one — not
 *   at publish (the reach lock), not when his own skills are reconciled, and not through a reach
 *   row that exists anyway (planted here as a row left over from before an audience change): the
 *   feed, detail, search and apply all refuse it (the read lock), and no `feed.shown_v2` or
 *   `application.submitted` ever names it.
 *
 * THE AUDIENCE IS SET BY SQL, BETWEEN CREATE AND PUBLISH. The payer route that accepts `audience`
 * ships in a sibling PR of #2746; this suite proves the worker side, which must hold whatever
 * writes the column. Supply is seeded by SQL before the publish PATCH for the reason
 * match-v1-job-journey.e2e.test.ts gives: publish-time materialization sees only existing rows.
 *
 * Opt-in, the same arming as match-v1-job-journey.e2e.test.ts (the V1 feed and apply gate are the
 * production paths — MATCH_V1 is on in production):
 *   1. docker compose up -d postgres redis; pnpm db:migrate
 *   2. Start the API: MATCH_V1_ENABLED=true TEST_LOGIN_ENABLED=true TEST_LOGIN_TOKEN=<32+ chars>
 *      PAYER_TEST_LOGIN_ENABLED=true PAYER_TEST_LOGIN_TOKEN=<32+ chars> pnpm --filter @badabhai/api start
 *   3. RUN_E2E=1 E2E_MATCH_V1=1 MATCH_V1_ENABLED=true TEST_LOGIN_TOKEN=<same>
 *      PAYER_TEST_LOGIN_TOKEN=<same> pnpm --filter @badabhai/e2e test job-audience-visibility
 */

const RUN_E2E = process.env.RUN_E2E === "1";
const TEST_LOGIN_TOKEN = process.env.TEST_LOGIN_TOKEN ?? "";
const PAYER_TEST_LOGIN_TOKEN = process.env.PAYER_TEST_LOGIN_TOKEN ?? "";
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

const SKILL = "mskill_vmc_operator";
const INDUSTRY = "ind_industrial_manufacturing";
/** One search token no other posting carries. */
const TOKEN = "aud2746e2e";

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

/** Inside the test-login seam's reserved range (`RESERVED_TEST_PHONE_PATTERN`: +91 00000 NNNNN). */
function syntheticPhone(): string {
  return `+9100000${String(Math.floor(Math.random() * 100_000)).padStart(5, "0")}`;
}

describe.skipIf(!RUN)("#2746 an RVM-only job never reaches a BadaBhai worker (e2e)", () => {
  let client!: DbClient;
  let payerToken = "";
  let rvmId = "";
  let bothId = "";
  let workerId = "";
  let workerToken = "";

  const reachOf = async (postingId: string): Promise<string[]> =>
    (
      await client.db
        .select({ workerId: jobReach.workerId })
        .from(jobReach)
        .where(eq(jobReach.jobPostingId, postingId))
    ).map((r) => r.workerId);

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL);
  });

  afterAll(async () => {
    if (!client) return;
    const postingIds = [rvmId, bothId].filter((id) => id !== "");
    if (postingIds.length > 0) {
      await client.db.delete(applications).where(inArray(applications.jobPostingId, postingIds));
      await client.db.delete(jobReach).where(inArray(jobReach.jobPostingId, postingIds));
      await client.db.delete(jobPostings).where(inArray(jobPostings.id, postingIds));
    }
    if (workerId) {
      await client.db
        .delete(workerIndustryTenure)
        .where(eq(workerIndustryTenure.workerId, workerId));
      await client.db.delete(workerSkills).where(eq(workerSkills.workerId, workerId));
      await client.db.delete(workers).where(eq(workers.id, workerId));
    }
    await client.sql.end({ timeout: 5 });
  });

  it("a supplied BadaBhai worker exists before publish", async () => {
    await client.db
      .insert(skills)
      .values({
        skillId: SKILL,
        labelEn: "VMC Operator",
        source: "rvm",
        status: "active",
        kind: "match_skill",
        industryId: INDUSTRY,
      })
      .onConflictDoNothing();

    const login = await req("POST", "/auth/test-login", {
      body: { phone: syntheticPhone() },
      testLogin: true,
    });
    expect(login.status).toBe(200);
    workerToken = login.json.access_token as string;
    workerId = login.json.worker_id as string;
    const consent = await req("POST", "/consent/accept", {
      token: workerToken,
      body: { consent_version: CONSENT_VERSION, purposes: ["profiling", "resume_generation"] },
    });
    expect(consent.status).toBe(201);

    await client.db.insert(workerSkills).values({
      workerId,
      skillId: SKILL,
      industryId: INDUSTRY,
      monthsBucketed: 48,
      wants: true,
      source: "derived_coarse",
    });
    await client.db
      .insert(workerIndustryTenure)
      .values({ workerId, industryId: INDUSTRY, calendarMonths: 48 });
  });

  it("the company creates two postings; one is set to RVM students only, one to both", async () => {
    const payer = await mintPayerSession({ role: "employer" });
    payerToken = payer.token;
    const create = async (title: string): Promise<string> => {
      const r = await req("POST", "/payer/job-postings", {
        token: payerToken,
        body: {
          org_label: "E2E Audience Works",
          role_title: title,
          vacancy_band: "1",
          description: "Audience fixture. Fanuc VMC operate karna.",
          role_kind: "vmc_milling",
        },
      });
      expect(r.status).toBe(201);
      return r.json.id as string;
    };
    rvmId = await create(`VMC Operator ${TOKEN} rvm`);
    bothId = await create(`VMC Operator ${TOKEN} both`);

    await client.db
      .update(jobPostings)
      .set({ audience: "rvm_students" })
      .where(eq(jobPostings.id, rvmId));
    await client.db.update(jobPostings).set({ audience: "both" }).where(eq(jobPostings.id, bothId));
  });

  it("PUBLISH materializes reach for `both` and ZERO rows for the RVM-only posting", async () => {
    for (const id of [rvmId, bothId]) {
      const r = await req("PATCH", `/payer/job-postings/${id}`, {
        token: payerToken,
        body: { status: "open", match_skill_ids: [SKILL], city: "Pune" },
      });
      expect(r.status).toBe(200);
    }
    expect(await reachOf(bothId)).toContain(workerId);
    expect(await reachOf(rvmId)).toEqual([]);
  });

  it("the worker's own skill reconcile never hands him the RVM-only posting", async () => {
    const r = await req("PUT", `/workers/me/match-skills/${SKILL}/wants`, {
      token: workerToken,
      body: { wants: true },
    });
    expect(r.status).toBe(200);
    expect(await reachOf(rvmId)).toEqual([]);
    expect(await reachOf(bothId)).toContain(workerId);
  });

  it("FEED, DETAIL and SEARCH show `both` and never the RVM-only posting — even with a reach row planted", async () => {
    // The read lock: a row left over from before an audience change opens nothing.
    await client.db
      .insert(jobReach)
      .values({ jobPostingId: rvmId, workerId, matchTier: 1, matchedSkillId: SKILL })
      .onConflictDoNothing();

    const feed = await req("GET", "/feed?limit=50", { token: workerToken });
    expect(feed.status).toBe(200);
    const fed = (feed.json.jobs as any[]).map((j) => j.job_id);
    expect(fed).toContain(bothId);
    expect(fed).not.toContain(rvmId);

    expect((await req("GET", `/jobs/${rvmId}`, { token: workerToken })).status).toBe(404);
    expect((await req("GET", `/jobs/${bothId}`, { token: workerToken })).status).toBe(200);

    const search = await req("GET", `/jobs/search?q=${TOKEN}&limit=50`, { token: workerToken });
    expect(search.status).toBe(200);
    const found = (search.json.jobs as any[]).map((j) => j.job_id);
    expect(found).toContain(bothId);
    expect(found).not.toContain(rvmId);
  });

  it("APPLY on the RVM-only posting is the neutral 404 and writes nothing; `both` takes the apply", async () => {
    const blocked = await req("POST", `/applications/${rvmId}/apply`, {
      token: workerToken,
      body: { rank: 1, source_surface: "feed" },
    });
    expect(blocked.status).toBe(404);
    const written = await client.db
      .select({ id: applications.id })
      .from(applications)
      .where(and(eq(applications.workerId, workerId), eq(applications.jobPostingId, rvmId)));
    expect(written).toEqual([]);

    const applied = await req("POST", `/applications/${bothId}/apply`, {
      token: workerToken,
      body: { rank: 1, source_surface: "feed" },
    });
    expect(applied.status).toBe(200);
    expect(applied.json.action).toBe("applied");
  });

  it("the spine never shows or applies the RVM-only posting to him", async () => {
    const rows = await client.db
      .select()
      .from(events)
      .where(inArray(events.eventName, ["feed.shown_v2", "application.submitted"]));
    const touching = rows.filter((e) => {
      const p = e.payload as Record<string, unknown>;
      return p.worker_id === workerId && (p.job_posting_id === rvmId || p.job_id === rvmId);
    });
    expect(touching).toEqual([]);
    expect(
      rows.some((e) => {
        const p = e.payload as Record<string, unknown>;
        return p.worker_id === workerId && (p.job_posting_id === bothId || p.job_id === bothId);
      }),
    ).toBe(true);
  });
});
