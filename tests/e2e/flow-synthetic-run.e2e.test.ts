import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "@badabhai/db";

/**
 * #2967 — THE DAILY SYNTHETIC RUN, against a LIVE API + Postgres + Redis.
 *
 * The run walks the whole flow through the api's real services (a company posts and publishes, an
 * admin opens the job to RVM students too, reach is built, the Campus feed lists it approved, a
 * worker applies in the app, an RVM student applies from Campus, the company lists both applicants
 * and opens the student's contact), all inside ONE transaction that is always rolled back. This
 * suite triggers it through the ops route and proves two things:
 *
 *   1. every step passes on a correctly configured stack;
 *   2. nothing the run made is kept: no posting, payer, worker, application, unlock, credit line or
 *      flow event it wrote survives; only its own counts-only record does.
 *
 * The vocabulary the walk needs, seeded here only when absent (and removed only if seeded here):
 * the trade's match skill `mskill_cnc_turner`, and `cnc_turner` on the Campus trade list.
 *
 * Opt-in, armed in CI's MATCH_V1 step (the V1 apply gate is production's):
 *   1. docker compose up -d postgres redis; pnpm db:migrate
 *   2. MATCH_V1_ENABLED=true FLOW_SYNTHETIC_RUN_ENABLED=true INTERNAL_SERVICE_TOKEN=<token>
 *      pnpm --filter @badabhai/api start
 *   3. RUN_E2E=1 E2E_MATCH_V1=1 MATCH_V1_ENABLED=true FLOW_SYNTHETIC_RUN_ENABLED=true
 *      INTERNAL_SERVICE_TOKEN=<same> pnpm --filter @badabhai/e2e test flow-synthetic-run
 */

const RUN =
  process.env.RUN_E2E === "1" &&
  process.env.E2E_MATCH_V1 === "1" &&
  process.env.MATCH_V1_ENABLED === "true" &&
  process.env.FLOW_SYNTHETIC_RUN_ENABLED === "true" &&
  (process.env.INTERNAL_SERVICE_TOKEN ?? "").length > 0;

const API_URL = process.env.E2E_API_URL ?? "http://localhost:3001";
const OPS_TOKEN = process.env.INTERNAL_SERVICE_TOKEN ?? "";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

const TRADE = "cnc_turner";
const SKILL = "mskill_cnc_turner";
const SEED_ADMIN = "00000000-0000-4000-8000-0000000e2e67";

/** Row counts the run must leave exactly as it found them. */
async function footprint(client: DbClient): Promise<Record<string, number>> {
  const [row] = await client.sql<Array<Record<string, string>>>`
    SELECT
      (SELECT count(*) FROM job_postings WHERE role_title = 'Synthetic flow check') AS postings,
      (SELECT count(*) FROM payers) AS payers,
      (SELECT count(*) FROM workers) AS workers,
      (SELECT count(*) FROM applications) AS applications,
      (SELECT count(*) FROM institute_applications WHERE external_ref LIKE 'synthetic:%') AS campus_applications,
      (SELECT count(*) FROM unlocks) AS unlocks,
      (SELECT count(*) FROM credit_ledger) AS ledger,
      (SELECT count(*) FROM job_posting_audience_decisions) AS audience_decisions,
      (SELECT count(*) FROM events WHERE event_name IN
        ('job_posting.created', 'application.submitted', 'unlock.granted', 'worker.institute_applied'))
        AS flow_events`;
  return Object.fromEntries(Object.entries(row ?? {}).map(([k, v]) => [k, Number(v)]));
}

describe.skipIf(!RUN)("#2967 the daily synthetic run (live API)", () => {
  let client: DbClient;
  let seededSkill = false;
  let seededTrade = false;

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL);
    const skill = await client.sql`
      INSERT INTO skill (skill_id, label_en, source, status, kind, industry_id)
      VALUES (${SKILL}, 'CNC Turner', 'rvm', 'active', 'match_skill', 'ind_industrial_manufacturing')
      ON CONFLICT DO NOTHING RETURNING skill_id`;
    seededSkill = skill.length === 1;
    const trade = await client.sql`
      INSERT INTO campus_trades (trade_key, added_by_admin_id)
      VALUES (${TRADE}, ${SEED_ADMIN}::uuid)
      ON CONFLICT DO NOTHING RETURNING trade_key`;
    seededTrade = trade.length === 1;
  });

  afterAll(async () => {
    if (!client) return;
    if (seededTrade) await client.sql`DELETE FROM campus_trades WHERE trade_key = ${TRADE}`;
    if (seededSkill) await client.sql`DELETE FROM skill WHERE skill_id = ${SKILL}`;
    await client.sql.end({ timeout: 5 });
  });

  async function runNow(token: string | null) {
    const res = await fetch(`${API_URL}/flow-check/synthetic-run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { "x-internal-service-token": token }),
      },
      body: "{}",
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("is behind the ops token", async () => {
    expect((await runNow(null)).status).toBe(401);
  });

  it("walks every step, and keeps nothing but its own record", async () => {
    const before = await footprint(client);
    const startedAt = new Date();

    const { status, body } = await runNow(OPS_TOKEN);

    expect(status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({
      armed: true,
      passed: true,
      stepsPassed: 10,
      failedStep: null,
      failure: null,
    });
    expect(await footprint(client)).toEqual(before);

    const records = await client.sql<Array<{ payload: Record<string, unknown> }>>`
      SELECT payload FROM events
      WHERE event_name = 'flow_check.synthetic_run_recorded' AND occurred_at >= ${startedAt.toISOString()}::timestamptz
      ORDER BY occurred_at DESC LIMIT 1`;
    expect(records[0]?.payload).toMatchObject({
      trigger: "ops",
      passed: true,
      steps_passed: 10,
      failed_step: null,
    });
  });

  it("a Campus trade list without a postable trade fails at rvm_audience, and still keeps nothing", async () => {
    // Take the trade off the list for this run only (put back below).
    await client.sql`UPDATE campus_trades SET removed_at = now(), removed_by_admin_id = ${SEED_ADMIN}::uuid
      WHERE trade_key = ${TRADE} AND removed_at IS NULL`;
    const listed = await client.sql<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM campus_trades WHERE removed_at IS NULL`;
    try {
      if (Number(listed[0]?.n ?? 0) > 0) return; // another trade is listed: this case cannot be staged
      const before = await footprint(client);
      const { body } = await runNow(OPS_TOKEN);
      expect(body).toMatchObject({
        armed: true,
        passed: false,
        stepsPassed: 3,
        failedStep: "rvm_audience",
        failure: "no_campus_trade",
      });
      expect(await footprint(client)).toEqual(before);
    } finally {
      await client.sql`UPDATE campus_trades SET removed_at = NULL, removed_by_admin_id = NULL
        WHERE trade_key = ${TRADE}`;
    }
  });
});
