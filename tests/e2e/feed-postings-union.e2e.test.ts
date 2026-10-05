import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { applications, createDbClient, events, jobPostings, type DbClient } from "@badabhai/db";
import { mintPayerSession } from "./helpers/payer-session";

/**
 * A COMPANY POSTING REACHES THE WORKER FEED WHILE MATCH_V1 IS OFF (#1823, ADR-0049), against a
 * LIVE API + DB + Redis, with FEED_POSTINGS_UNION_ENABLED ON:
 *
 *   payer creates a posting with every card field -> publishes it with a match skill -> a
 *   FRESH worker (no wanted skills, so the #1240 rule serves him every posting) sees it on
 *   `GET /feed` with every field verbatim on the legacy 17 keys -> applies (200, a
 *   `job_posting_id` row) -> the Applied tab and the ops applicant read both list it -> the
 *   spine carries `feed.shown` and `application.submitted` on subject `job_posting`, and no
 *   `feed.shown_v2`.
 *
 * WHY A DEDICATED, DOUBLE-ARMED GATE. The flag is OFF by default everywhere, and the CI e2e
 * pass that runs every other suite runs the API that way on purpose — prod's default path
 * keeps its coverage. A separate CI step restarts the API with the flag ON and runs ONLY this
 * file. Under a flag-off API this suite would see no posting and prove nothing, so it refuses
 * to run unless BOTH the runner and the API are armed (`E2E_FEED_POSTINGS_UNION=1` and
 * `FEED_POSTINGS_UNION_ENABLED=true`), and the CI step fails a vacuous skip.
 *
 * Opt-in:
 *   1. docker compose up -d postgres redis
 *   2. pnpm db:migrate && pnpm --filter @badabhai/db db:seed:match:vocabulary --apply
 *   3. Start the API with the union armed:
 *      FEED_POSTINGS_UNION_ENABLED=true TEST_LOGIN_ENABLED=true TEST_LOGIN_TOKEN=<32+ chars>
 *      PAYER_TEST_LOGIN_ENABLED=true PAYER_TEST_LOGIN_TOKEN=<32+ chars>
 *      INTERNAL_SERVICE_TOKEN=<token> pnpm --filter @badabhai/api start
 *   4. RUN_E2E=1 E2E_FEED_POSTINGS_UNION=1 FEED_POSTINGS_UNION_ENABLED=true
 *      TEST_LOGIN_TOKEN=<same> PAYER_TEST_LOGIN_TOKEN=<same> INTERNAL_SERVICE_TOKEN=<token>
 *      pnpm --filter @badabhai/e2e test feed-postings-union
 */

const TEST_LOGIN_TOKEN = process.env.TEST_LOGIN_TOKEN ?? "";
const PAYER_TEST_LOGIN_TOKEN = process.env.PAYER_TEST_LOGIN_TOKEN ?? "";
const OPS_TOKEN = process.env.INTERNAL_SERVICE_TOKEN ?? "";
const RUN =
  process.env.RUN_E2E === "1" &&
  process.env.E2E_FEED_POSTINGS_UNION === "1" &&
  // The runner-side half of the arming check; the API process must be started with it too.
  process.env.FEED_POSTINGS_UNION_ENABLED === "true" &&
  TEST_LOGIN_TOKEN.length > 0 &&
  PAYER_TEST_LOGIN_TOKEN.length > 0;

const API_URL = process.env.E2E_API_URL ?? "http://localhost:3001";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";
const CONSENT_VERSION = "2026-06-01";
const MATCH_SKILL = "mskill_vmc_operator";

/** The legacy card's exact key set — the shipped client's contract, unchanged by the union. */
const FEED_ITEM_KEYS = [
  "area",
  "benefits",
  "city",
  "description",
  "job_id",
  "max_experience_years",
  "min_experience_years",
  "needed_by",
  "pay_max",
  "pay_min",
  "pay_type",
  "posted_at",
  "rank",
  "requirements",
  "shift",
  "title",
  "trade_key",
];

/**
 * Every payer-web `CardField` (apps/payer-web/src/lib/job-card-view.ts) plus the description.
 * `role_kind` is sent on purpose: it must NOT reach the worker card (ADR-0024 addendum, O6).
 */
const CARD = {
  role_title: "VMC Operator (union e2e)",
  role_kind: "vmc_milling",
  city: "Pune",
  area: "Chakan",
  pay_min: 18000,
  pay_max: 24000,
  pay_type: "in_hand",
  min_experience_years: 2,
  max_experience_years: 5,
  shift: "day",
  needed_by: "immediate",
  requirements: ["Fanuc control"],
  benefits: ["PF + ESI"],
  description: "Fanuc VMC chalana aana chahiye.",
} as const;

async function req(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; ops?: boolean; testLogin?: boolean } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.ops) headers["x-internal-service-token"] = OPS_TOKEN;
  if (opts.testLogin) headers["x-test-login-token"] = TEST_LOGIN_TOKEN;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** A phone in the ONLY range the D-3 mint serves (`+9100000` + five digits). */
function syntheticPhone(): string {
  return `+9100000${String(Math.floor(Math.random() * 100_000)).padStart(5, "0")}`;
}

describe.skipIf(!RUN)("Company postings on the legacy feed (e2e, #1823 interim union)", () => {
  let client!: DbClient;
  let payer!: { payerId: string; token: string };
  let worker!: { workerId: string; token: string };
  let postingId = "";

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL);
  });

  afterAll(async () => {
    if (!client) return;
    // CHILDREN BEFORE PARENTS; the suite owns the posting and its decisions. The minted worker
    // is left, as swipe-to-apply.e2e leaves its own: the seam find-or-creates by phone, and a
    // stray synthetic worker on an ephemeral CI database is harmless.
    if (postingId) {
      await client.db.delete(applications).where(eq(applications.jobPostingId, postingId));
      await client.db.delete(jobPostings).where(eq(jobPostings.id, postingId));
    }
    await client.sql.end({ timeout: 5 });
  });

  it("a payer creates a posting with every card field and publishes it with a match skill", async () => {
    payer = await mintPayerSession({ role: "employer" });
    const created = await req("POST", "/payer/job-postings", {
      token: payer.token,
      body: { org_label: "E2E Union Works", vacancy_band: "1", ...CARD },
    });
    expect(created.status).toBe(201);
    postingId = created.json.id as string;
    expect(postingId).toBeTruthy();

    const published = await req("PATCH", `/payer/job-postings/${postingId}`, {
      token: payer.token,
      body: { status: "open", match_skill_ids: [MATCH_SKILL] },
    });
    expect(published.status).toBe(200);

    const row = (
      await client.db.select().from(jobPostings).where(eq(jobPostings.id, postingId))
    )[0]!;
    expect(row.status).toBe("open");
    // The posting arm requires it: an unpublished posting has no honest `posted_at`.
    expect(row.publishedAt).not.toBeNull();
  });

  it("a FRESH worker sees it on GET /feed — every field verbatim, on exactly the 17 legacy keys", async () => {
    const login = await req("POST", "/auth/test-login", {
      body: { phone: syntheticPhone() },
      testLogin: true,
    });
    expect(login.status).toBe(200);
    worker = { workerId: login.json.worker_id as string, token: login.json.access_token as string };
    const consent = await req("POST", "/consent/accept", {
      token: worker.token,
      body: { consent_version: CONSENT_VERSION, purposes: ["profiling", "resume_generation"] },
    });
    expect(consent.status).toBe(201);

    const feed = await req("GET", "/feed?limit=50", { token: worker.token });
    expect(feed.status).toBe(200);
    const items = feed.json.jobs as Array<Record<string, unknown>>;
    for (const item of items) expect(Object.keys(item).sort()).toEqual(FEED_ITEM_KEYS);

    const card = items.find((j) => j.job_id === postingId);
    expect(card, "the freshly published posting must be on the worker's deck").toBeTruthy();
    // The newest thing on the platform leads a newest-first deck.
    expect(card!.rank).toBe(1);
    expect(card).toMatchObject({
      title: CARD.role_title,
      city: CARD.city,
      area: CARD.area,
      pay_min: CARD.pay_min,
      pay_max: CARD.pay_max,
      pay_type: CARD.pay_type,
      min_experience_years: CARD.min_experience_years,
      max_experience_years: CARD.max_experience_years,
      shift: CARD.shift,
      needed_by: CARD.needed_by,
      requirements: CARD.requirements,
      benefits: CARD.benefits,
      description: CARD.description,
      // No trade column on a posting; never the role, never a skill id.
      trade_key: "",
    });
    expect(typeof card!.posted_at).toBe("string");
    expect(JSON.stringify(card)).not.toContain(CARD.role_kind);
    expect(JSON.stringify(card)).not.toContain("E2E Union Works");
  });

  it("the impression is a feed.shown v1 on subject job_posting — never feed.shown_v2", async () => {
    const shown = await client.db
      .select({ name: events.eventName, subjectType: events.subjectType, payload: events.payload })
      .from(events)
      .where(
        and(
          eq(events.subjectId, postingId),
          inArray(events.eventName, ["feed.shown", "feed.shown_v2"]),
        ),
      );
    const mine = shown.filter(
      (e) => (e.payload as { worker_id?: string }).worker_id === worker.workerId,
    );
    expect(mine.length).toBeGreaterThanOrEqual(1);
    for (const e of mine) {
      expect(e.name).toBe("feed.shown");
      expect(e.subjectType).toBe("job_posting");
      expect(Object.keys(e.payload as object).sort()).toEqual([
        "hot",
        "job_id",
        "rank",
        "score",
        "worker_id",
      ]);
    }
  });

  it("APPLY returns 200 and writes job_posting_id with job_id NULL, once", async () => {
    const first = await req("POST", `/applications/${postingId}/apply`, {
      token: worker.token,
      body: { rank: 1, source_surface: "feed" },
    });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ ok: true, action: "applied" });
    const again = await req("POST", `/applications/${postingId}/apply`, {
      token: worker.token,
      body: { rank: 1, source_surface: "feed" },
    });
    expect(again.status).toBe(200);
    expect(again.json.application_id).toBe(first.json.application_id);

    const rows = await client.db
      .select({
        jobId: applications.jobId,
        jobPostingId: applications.jobPostingId,
        action: applications.action,
      })
      .from(applications)
      .where(
        and(eq(applications.workerId, worker.workerId), eq(applications.jobPostingId, postingId)),
      );
    expect(rows).toEqual([{ jobId: null, jobPostingId: postingId, action: "applied" }]);

    const submitted = await client.db
      .select({ subjectType: events.subjectType })
      .from(events)
      .where(eq(events.idempotencyKey, `application.submitted:${worker.workerId}:${postingId}`));
    expect(submitted).toEqual([{ subjectType: "job_posting" }]);

    // Applied — so it leaves his deck (the applied anti-join).
    const feed = await req("GET", "/feed?limit=50", { token: worker.token });
    expect((feed.json.jobs as Array<{ job_id: string }>).map((j) => j.job_id)).not.toContain(
      postingId,
    );
  });

  it("the worker's Applied tab lists it", async () => {
    const r = await req("GET", "/workers/me/applications", { token: worker.token });
    expect(r.status).toBe(200);
    const row = (r.json.applications as Array<Record<string, unknown>>).find(
      (a) => a.job_id === postingId,
    );
    expect(row, "the posting application must be on the Applied tab").toBeTruthy();
    expect(row!.title).toBe(CARD.role_title);
    expect(row!.action).toBe("applied");
  });

  it("the ops applicant read lists the worker under the POSTING id", async () => {
    const r = await req("GET", `/jobs/${postingId}/applicants`, { ops: true });
    expect(r.status).toBe(200);
    const ids = (r.json.applicants as Array<{ worker_id: string }>).map((a) => a.worker_id);
    expect(ids).toContain(worker.workerId);
  });

  // NOT YET HERE, ON PURPOSE: the two legs that close the company loop land in their own
  // changes and are appended to this suite with them — the payer's
  // `/payer/reach/jobs/:id/applicants` serving a posting while V1 is off (the payer
  // posting-applicants change), and the unlock storing a NULL job context for a posting id
  // instead of a 500 (#1903). Not `it.todo`: vitest reports a todo as SKIPPED on the file
  // line, which the CI step's vacuous-skip guard would rightly fail. Both legs are a PRE-ARM
  // gate: FEED_POSTINGS_UNION_ENABLED is not armed in production until they pass here.
});
