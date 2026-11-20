import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Queue, QueueEvents } from "bullmq";
import {
  contactReachCases,
  createDbClient,
  creditLedger,
  events,
  featurePilotPayers,
  unlocks,
  type DbClient,
} from "@badabhai/db";
import { and, eq, sql } from "drizzle-orm";
import { SEED_PACK } from "./helpers/credit-packs";
import { mintPayerSession, type MintedPayerSession } from "./helpers/payer-session";
import { syntheticPhoneMinter } from "./helpers/synthetic-phone";

/**
 * #2750 items 7 and 13 — the working-number guarantee, end to end against the running API.
 *
 * A pilot company opens a worker's contact, reports that it could not reach him, and the case runs
 * out its desk window. The REAL deadline sweep then closes it "not reached" and gives the credits
 * back once. Also: a report is idempotent, only the company that opened the contact can report it,
 * a case before its deadline is left alone, and a report after the window is refused.
 *
 * WHY THE SWEEP AND NOT THE DESK. The desk's "not reached" close and the deadline close share one
 * code path (`ReachDeskService.close`). The e2e stack has no way to sign an admin in (that needs an
 * emailed code), so this suite drives the deadline path: it moves the case's deadline into the past
 * and adds one job to the sweep's own BullMQ queue, which the API's worker processes exactly as it
 * processes the 15-minute tick (the job's data is ignored). The desk routes' "reached, declined"
 * branch is covered against Postgres in apps/api/src/credit-rules/credit-rules.db.test.ts.
 *
 * The e2e job runs the API with `CREDIT_RULES_ROLLOUT=pilot`; this suite puts its own companies on
 * `feature_pilot_payers` (the production pilot path), so every other suite keeps the rules off.
 * Opt-in, the same harness as contact-unlock.e2e.test.ts (RUN_E2E=1 + E2E_UNLOCK_SUITE=1).
 */
const RULES = process.env.CREDIT_RULES_ROLLOUT ?? "";
const RUN =
  process.env.RUN_E2E === "1" &&
  process.env.E2E_UNLOCK_SUITE === "1" &&
  (RULES === "pilot" || RULES === "on");
const API_URL = process.env.E2E_API_URL ?? "http://localhost:3001";
const OPS_TOKEN = process.env.INTERNAL_SERVICE_TOKEN ?? "";
const TEST_LOGIN_TOKEN = process.env.TEST_LOGIN_TOKEN ?? "";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
/** apps/api/src/queue/queue.constants.ts `REACH_DESK_DEADLINE_QUEUE`. */
const REACH_DESK_DEADLINE_QUEUE = "reach-desk-deadline";
/** The approved 2026-11-04 notice, the one every unlock suite consents on. */
const NOTICE = "2026-11-04";
const DAY_MS = 24 * 60 * 60 * 1000;

const syntheticPhone = syntheticPhoneMinter(71);

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

function redisConnection(url: string): { host: string; port: number; db?: number } {
  const u = new URL(url);
  const db = u.pathname && u.pathname !== "/" ? Number(u.pathname.slice(1)) : undefined;
  return { host: u.hostname, port: u.port ? Number(u.port) : 6379, ...(db ? { db } : {}) };
}

describe.skipIf(!RUN)("The working-number guarantee (e2e, #2750)", () => {
  let client!: DbClient;
  let queue!: Queue;
  let queueEvents!: QueueEvents;

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL);
    expect(OPS_TOKEN, "set INTERNAL_SERVICE_TOKEN for the ops credit route").not.toBe("");
    expect(TEST_LOGIN_TOKEN, "set TEST_LOGIN_TOKEN (>=32 chars)").not.toBe("");
    const connection = redisConnection(REDIS_URL);
    queue = new Queue(REACH_DESK_DEADLINE_QUEUE, { connection });
    queueEvents = new QueueEvents(REACH_DESK_DEADLINE_QUEUE, { connection });
    await queueEvents.waitUntilReady();
  });

  afterAll(async () => {
    await queueEvents?.close();
    await queue?.close();
    await client?.sql.end({ timeout: 5 });
  });

  /** A consenting worker. */
  async function worker(): Promise<string> {
    const login = await req("POST", "/auth/test-login", {
      body: { phone: syntheticPhone() },
      testLogin: true,
    });
    expect(login.status).toBe(200);
    const consented = await req("POST", "/consent/accept", {
      body: { consent_version: NOTICE, purposes: ["profiling", "employer_sharing"] },
      token: login.json.access_token as string,
    });
    expect(consented.status).toBe(201);
    return login.json.worker_id as string;
  }

  /** A company with {@link SEED_PACK}'s credits, on the `credit_rules` pilot list. */
  async function pilotCompany(): Promise<MintedPayerSession> {
    const company = await mintPayerSession();
    const buy = await req("POST", `/payers/${company.payerId}/credits`, {
      ops: true,
      body: { pack_code: SEED_PACK.code },
    });
    expect(buy.json.balance).toBe(SEED_PACK.credits);
    await client.db.insert(featurePilotPayers).values({
      feature: "credit_rules",
      payerId: company.payerId,
      addedBy: "e2e",
      reason: "#2750 e2e pilot company",
    });
    return company;
  }

  async function balance(payerId: string): Promise<number> {
    const [row] = await client.db
      .select({ sum: sql<number>`coalesce(sum(${creditLedger.delta}), 0)::int` })
      .from(creditLedger)
      .where(eq(creditLedger.payerId, payerId));
    return row!.sum;
  }

  async function open(company: MintedPayerSession, workerId: string): Promise<string> {
    const grant = await req("POST", "/payer/unlocks", {
      token: company.token,
      body: { worker_id: workerId },
    });
    expect(grant.json).toMatchObject({ ok: true, status: "granted" });
    return grant.json.unlock_id as string;
  }

  /** One tick of the real deadline sweep, processed by the API's worker; its result. */
  async function sweepTick(): Promise<{ skipped: boolean; due: number; closed: number }> {
    const job = await queue.add("e2e-tick", {}, { removeOnComplete: true, removeOnFail: true });
    return (await job.waitUntilFinished(queueEvents, 30_000)) as {
      skipped: boolean;
      due: number;
      closed: number;
    };
  }

  it("not reached by the deadline: the case closes and the credits come back, once", async () => {
    const workerId = await worker();
    const company = await pilotCompany();
    const unlockId = await open(company, workerId);
    const afterOpen = await balance(company.payerId);
    const cost = SEED_PACK.credits - afterOpen;
    expect(cost).toBeGreaterThan(0);

    // The report opens one case with the 48-hour desk deadline.
    const before = Date.now();
    const reported = await req("POST", `/payer/unlocks/${unlockId}/couldnt-reach`, {
      token: company.token,
    });
    expect(reported.status).toBe(200);
    expect(reported.json).toMatchObject({
      unlock_id: unlockId,
      status: "open",
      resolved_at: null,
      credits_returned: 0,
    });
    const deadline = new Date(reported.json.deadline_at as string).getTime();
    expect(deadline - before).toBeGreaterThan(47 * 60 * 60 * 1000);
    expect(deadline - before).toBeLessThanOrEqual(48 * 60 * 60 * 1000 + 60_000);

    // A second report is the same case, not a new one.
    const again = await req("POST", `/payer/unlocks/${unlockId}/couldnt-reach`, {
      token: company.token,
    });
    expect(again.json.case_id).toBe(reported.json.case_id);
    const cases = await client.db
      .select({ id: contactReachCases.id })
      .from(contactReachCases)
      .where(eq(contactReachCases.unlockId, unlockId));
    expect(cases).toHaveLength(1);

    // Before its deadline the sweep leaves the case alone.
    const early = await sweepTick();
    expect(early.skipped).toBe(false);
    const stillOpen = await req("GET", `/payer/unlocks/${unlockId}/couldnt-reach`, {
      token: company.token,
    });
    expect(stillOpen.json.status).toBe("open");
    expect(await balance(company.payerId)).toBe(afterOpen);

    // The desk window runs out with nobody reaching him.
    await client.db
      .update(contactReachCases)
      .set({ deadlineAt: new Date(Date.now() - 60_000) })
      .where(eq(contactReachCases.unlockId, unlockId));
    const due = await sweepTick();
    expect(due.closed).toBeGreaterThanOrEqual(1);

    const closed = await req("GET", `/payer/unlocks/${unlockId}/couldnt-reach`, {
      token: company.token,
    });
    expect(closed.json).toMatchObject({ status: "not_reached", credits_returned: cost });
    expect(closed.json.resolved_at).not.toBeNull();
    expect(await balance(company.payerId)).toBe(SEED_PACK.credits);

    const returned = await client.db
      .select({ delta: creditLedger.delta })
      .from(creditLedger)
      .where(and(eq(creditLedger.unlockId, unlockId), eq(creditLedger.reason, "returned")));
    expect(returned.reduce((s, r) => s + r.delta, 0)).toBe(cost);

    const [resolvedEvent] = await client.db
      .select({ payload: events.payload, actorType: events.actorType })
      .from(events)
      .where(
        and(
          eq(events.eventName, "payer.contact_reach_resolved"),
          sql`${events.payload}->>'unlock_id' = ${unlockId}`,
        ),
      );
    expect(resolvedEvent).toBeDefined();
    expect(resolvedEvent!.actorType).toBe("system");
    expect(resolvedEvent!.payload).toMatchObject({
      status: "not_reached",
      credits_returned: cost,
      resolved_by: "deadline",
    });

    // Another tick, or another report, never returns the credits a second time.
    await sweepTick();
    const reportAfterClose = await req("POST", `/payer/unlocks/${unlockId}/couldnt-reach`, {
      token: company.token,
    });
    expect(reportAfterClose.json.status).toBe("not_reached");
    expect(await balance(company.payerId)).toBe(SEED_PACK.credits);
  });

  it("only the company that opened the contact can report it", async () => {
    const workerId = await worker();
    const owner = await pilotCompany();
    const other = await pilotCompany();
    const unlockId = await open(owner, workerId);

    const foreign = await req("POST", `/payer/unlocks/${unlockId}/couldnt-reach`, {
      token: other.token,
    });
    expect(foreign.status).toBe(404);
    const cases = await client.db
      .select({ id: contactReachCases.id })
      .from(contactReachCases)
      .where(eq(contactReachCases.unlockId, unlockId));
    expect(cases).toHaveLength(0);
  });

  it("a company NOT on the pilot list gets no guarantee route", async () => {
    const workerId = await worker();
    const company = await mintPayerSession();
    const buy = await req("POST", `/payers/${company.payerId}/credits`, {
      ops: true,
      body: { pack_code: SEED_PACK.code },
    });
    expect(buy.json.balance).toBe(SEED_PACK.credits);
    const unlockId = await open(company, workerId);
    const report = await req("POST", `/payer/unlocks/${unlockId}/couldnt-reach`, {
      token: company.token,
    });
    expect(report.status).toBe(404);
  });

  it("a report after the window is refused, and opens no case", async () => {
    const workerId = await worker();
    const company = await pilotCompany();
    const unlockId = await open(company, workerId);
    // Opened eight days ago: past the 7-day report window.
    await client.db
      .update(unlocks)
      .set({ grantedAt: new Date(Date.now() - 8 * DAY_MS) })
      .where(eq(unlocks.id, unlockId));

    const late = await req("POST", `/payer/unlocks/${unlockId}/couldnt-reach`, {
      token: company.token,
    });
    expect(late.status).toBe(409);
    expect(late.json.error).toMatchObject({ code: "REPORT_WINDOW_CLOSED" });
    const cases = await client.db
      .select({ id: contactReachCases.id })
      .from(contactReachCases)
      .where(eq(contactReachCases.unlockId, unlockId));
    expect(cases).toHaveLength(0);
  });
});
