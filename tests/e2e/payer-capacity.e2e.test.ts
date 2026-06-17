import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDbClient,
  events,
  jobPostings,
  payerCapacity,
  postingPlans,
  type DbClient,
  type EventRow,
  type PostingPlan,
} from "@badabhai/db";
import { randomUUID } from "node:crypto";

/**
 * Per-payer hiring capacity (ADR-0016) end-to-end against a LIVE API + DB. This is the
 * ATOMICITY proof the unit suite cannot give: the unit tests mock `lockPayer`, so the
 * TRUE advisory-lock race (pg_advisory_xact_lock + DERIVED active-vacancy count, one
 * transaction) is only verifiable here, against a real Postgres.
 *
 * Cases:
 *   - ATOMICITY: set a payer's allowance to N, fire M>N concurrent buyPlan (distinct
 *     job_postings) at that ONE payer; assert AT MOST N plans land status='active' and
 *     the rest 'paused' — the cap is NEVER exceeded under concurrency (the lock proof).
 *   - pause-at-limit: a buyPlan that would exceed the cap returns paused=true + emits
 *     posting_plan.paused (reason capacity_exceeded).
 *   - auto-resume: buying MORE capacity (buyCapacity raising the cap) flips the OLDEST
 *     paused plans active up to the new headroom, oldest-paid-first, emitting
 *     posting_plan.resumed (reason capacity_restored).
 *   - faceless / no-PII: the PII sentinel + the PII key set never appear in
 *     payer_capacity / posting_plans rows or in any capacity.* / posting_plan.* /
 *     payment.* event payload (the contact-unlock.e2e PII_KEYS sweep).
 *   - events: capacity.purchased + payment.* on purchase; real_call:false on payment.*.
 *
 * Opt-in (same harness as contact-unlock.e2e.test.ts):
 *   1. docker compose up -d postgres redis     # or point at Supabase
 *   2. pnpm db:migrate
 *   3. INTERNAL_SERVICE_TOKEN=<token> pnpm --filter @badabhai/api start  (another terminal)
 *   4. RUN_E2E=1 INTERNAL_SERVICE_TOKEN=<token> pnpm --filter @badabhai/e2e test
 * The AI service is NOT required (this surface never calls an LLM).
 */

const RUN = process.env.RUN_E2E === "1";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:3001";
const OPS_TOKEN = process.env.INTERNAL_SERVICE_TOKEN ?? "";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

/** A unique sentinel that must NEVER surface in any capacity-family row or event. */
const PII_SENTINEL = `+9198${String(Date.now()).slice(-8)}`;
const PII_KEYS = ["full_name", "name", "phone", "phone_e164", "employer", "address", "relay_handle"];

async function req(
  method: string,
  path: string,
  opts: { body?: unknown; ops?: boolean } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.ops) headers["x-internal-service-token"] = OPS_TOKEN;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

describe.skipIf(!RUN)("Per-payer hiring capacity (e2e, ADR-0016)", () => {
  let client!: DbClient;

  beforeAll(() => {
    client = createDbClient(DATABASE_URL);
    expect(OPS_TOKEN, "set INTERNAL_SERVICE_TOKEN for the capacity route").not.toBe("");
  });

  afterAll(async () => {
    await client?.sql.end({ timeout: 5 });
  });

  /** Seed a banded, PII-free job_posting (the buyPlan FK target) and return its id. */
  async function seedPosting(): Promise<string> {
    const rows = await client.db
      .insert(jobPostings)
      .values({ createdBy: randomUUID(), orgLabel: "ops-org", roleTitle: "CNC Operator", vacancyBand: "1", status: "open" })
      .returning({ id: jobPostings.id });
    return rows[0]!.id;
  }

  /** Directly set a payer's allowance (deterministic N; no dependency on tier grants). */
  async function setCapacity(payerId: string, n: number): Promise<void> {
    await client.db.insert(payerCapacity).values({ payerId, maxActiveVacancies: n, sourceTier: null, expiresAt: null });
  }

  async function plansForPayer(payerId: string): Promise<PostingPlan[]> {
    return (await client.db.select().from(postingPlans)).filter((p) => p.payerId === payerId);
  }

  async function allEvents(): Promise<EventRow[]> {
    return client.db.select().from(events);
  }

  it("ATOMICITY: M>N concurrent buyPlan for ONE payer never exceed the cap (advisory-lock proof)", async () => {
    const payer = randomUUID();
    const N = 3;
    // M is deliberately > the postgres.js pool max (default 10, client.ts) AND > N. The
    // > N part proves the cap; the > pool-size part guards the in-lock deadlock fix
    // (ADR-0016 / F-2): every in-lock read (incl. getCapacity) must ride the locked tx's
    // OWN connection. If any in-lock read grabbed a SECOND pool connection, ≥10 same-payer
    // buys would exhaust the pool while one holds the lock → it could never get an 11th
    // connection → deadlock. M=12 forces that failure mode to surface here, not in prod.
    const M = 12;
    await setCapacity(payer, N);
    const postings = await Promise.all(Array.from({ length: M }, () => seedPosting()));

    // Fire all M plan purchases at the SAME payer concurrently. The count-and-write runs
    // under pg_advisory_xact_lock keyed on payer_id, so the cap can never be exceeded
    // even if every request reads the active count "before" the others commit.
    const results = await Promise.all(
      postings.map((id) => req("POST", `/job-postings/${id}/plan`, { ops: true, body: { payer_id: payer, tier: "standard" } })),
    );
    for (const r of results) expect(r.status).toBe(201);

    // Source of truth is the DB, not the API responses: exactly N active, the rest paused.
    const plans = await plansForPayer(payer);
    expect(plans.length).toBe(M);
    const active = plans.filter((p) => p.status === "active");
    const paused = plans.filter((p) => p.status === "paused");
    expect(active.length).toBe(N); // NEVER more than the cap
    expect(active.length).toBeLessThanOrEqual(N);
    expect(paused.length).toBe(M - N);

    // The API's `paused` flags agree with the persisted statuses (no over-report).
    const apiPaused = results.filter((r) => r.json?.paused === true).length;
    expect(apiPaused).toBe(M - N);
  });

  it("pause-at-limit: a buyPlan over the cap returns paused=true and emits posting_plan.paused", async () => {
    const payer = randomUUID();
    await setCapacity(payer, 1);
    const first = await req("POST", `/job-postings/${await seedPosting()}/plan`, {
      ops: true,
      body: { payer_id: payer, tier: "standard" },
    });
    expect(first.json.paused).toBe(false); // 0+1 ≤ 1 → active

    const second = await req("POST", `/job-postings/${await seedPosting()}/plan`, {
      ops: true,
      body: { payer_id: payer, tier: "standard" },
    });
    expect(second.json.paused).toBe(true); // 1+1 > 1 → paused
    const pausedPlanId = second.json.plan.id as string;

    const pausedEvents = (await allEvents()).filter(
      (e) => e.eventName === "posting_plan.paused" && (e.payload as { plan_id?: string }).plan_id === pausedPlanId,
    );
    expect(pausedEvents.length).toBe(1);
    expect((pausedEvents[0]!.payload as { reason?: string }).reason).toBe("capacity_exceeded");
  });

  it("auto-resume: buying more capacity flips the oldest paused plans active (oldest-paid-first) and emits posting_plan.resumed", async () => {
    const payer = randomUUID();
    await setCapacity(payer, 1);

    // One active + two paused (the over-cap ones), each a distinct posting.
    const r1 = await req("POST", `/job-postings/${await seedPosting()}/plan`, { ops: true, body: { payer_id: payer, tier: "standard" } });
    expect(r1.json.paused).toBe(false);
    const r2 = await req("POST", `/job-postings/${await seedPosting()}/plan`, { ops: true, body: { payer_id: payer, tier: "standard" } });
    const r3 = await req("POST", `/job-postings/${await seedPosting()}/plan`, { ops: true, body: { payer_id: payer, tier: "standard" } });
    expect(r2.json.paused).toBe(true);
    expect(r3.json.paused).toBe(true);
    const pausedFirst = r2.json.plan.id as string; // paid earlier → resumes first
    const pausedSecond = r3.json.plan.id as string;

    // Raise the cap to cap_5 (allowance 5) → 1 active + headroom for both paused.
    const cap = await req("POST", `/payers/${payer}/capacity`, { ops: true, body: { tier: "cap_5" } });
    expect(cap.status).toBe(201);
    expect(cap.json.max_active_vacancies).toBe(5);
    // Deterministic oldest-paid-first order.
    expect(cap.json.resumed_plan_ids).toEqual([pausedFirst, pausedSecond]);

    // The DB reflects the resume: all three plans now active.
    const plans = await plansForPayer(payer);
    expect(plans.filter((p) => p.status === "active").length).toBe(3);
    expect(plans.filter((p) => p.status === "paused").length).toBe(0);

    // A posting_plan.resumed (reason capacity_restored) was emitted for each resumed plan.
    const resumed = (await allEvents()).filter((e) => e.eventName === "posting_plan.resumed");
    const resumedForPayer = resumed.filter((e) =>
      [pausedFirst, pausedSecond].includes((e.payload as { plan_id?: string }).plan_id ?? ""),
    );
    expect(resumedForPayer.length).toBe(2);
    for (const e of resumedForPayer) expect((e.payload as { reason?: string }).reason).toBe("capacity_restored");
  });

  it("emits capacity.purchased + payment.* on purchase; payment.* carry real_call:false (mock payments)", async () => {
    const payer = randomUUID();
    const cap = await req("POST", `/payers/${payer}/capacity`, { ops: true, body: { tier: "cap_5" } });
    expect(cap.status).toBe(201);

    const evts = await allEvents();
    const purchased = evts.filter(
      (e) => e.eventName === "capacity.purchased" && (e.payload as { payer_id?: string }).payer_id === payer,
    );
    expect(purchased.length).toBe(1);
    expect(purchased[0]!.payload).toMatchObject({ tier: "cap_5", max_active_vacancies: 5, real_call: false });

    // payment.authorized + payment.captured for this payer, both real_call:false.
    const payments = evts.filter(
      (e) => e.eventName.startsWith("payment.") && (e.payload as { payer_id?: string }).payer_id === payer,
    );
    expect(payments.map((p) => p.eventName).sort()).toEqual(["payment.authorized", "payment.captured"]);
    for (const p of payments) expect((p.payload as { real_call?: boolean }).real_call).toBe(false);
  });

  it("the capacity route requires the internal secret (fail closed)", async () => {
    const r = await req("POST", `/payers/${randomUUID()}/capacity`, { body: { tier: "cap_5" } });
    expect(r.status).toBe(401);
  });

  it("faceless: the PII sentinel + PII keys never appear in capacity rows or in capacity.* / posting_plan.* / payment.* events", async () => {
    // A full purchase + pause + resume cycle, with the PII sentinel attached only to
    // the (PII-bearing) job_posting org label — it must NOT leak into the faceless rails.
    const payer = randomUUID();
    await setCapacity(payer, 1);
    const p1 = (
      await client.db
        .insert(jobPostings)
        .values({ createdBy: randomUUID(), orgLabel: PII_SENTINEL, roleTitle: "CNC Operator", vacancyBand: "1", status: "open" })
        .returning({ id: jobPostings.id })
    )[0]!.id;
    const p2 = (
      await client.db
        .insert(jobPostings)
        .values({ createdBy: randomUUID(), orgLabel: PII_SENTINEL, roleTitle: "VMC Operator", vacancyBand: "1", status: "open" })
        .returning({ id: jobPostings.id })
    )[0]!.id;
    await req("POST", `/job-postings/${p1}/plan`, { ops: true, body: { payer_id: payer, tier: "standard" } });
    await req("POST", `/job-postings/${p2}/plan`, { ops: true, body: { payer_id: payer, tier: "standard" } }); // paused
    await req("POST", `/payers/${payer}/capacity`, { ops: true, body: { tier: "cap_5" } }); // resume

    // The faceless rails (capacity + plan rows) never carry the sentinel or any PII key.
    const capRows = (await client.db.select().from(payerCapacity)).filter((c) => c.payerId === payer);
    const planRows = await plansForPayer(payer);
    const rowsSerialized = JSON.stringify([capRows, planRows]);
    expect(rowsSerialized).not.toContain(PII_SENTINEL);
    for (const k of PII_KEYS) expect(rowsSerialized).not.toContain(`"${k}"`);

    // No capacity-family event payload carries the sentinel or a PII key.
    const evtPayloads = JSON.stringify(
      (await allEvents())
        .filter((e) => ["capacity.", "posting_plan.", "payment."].some((pfx) => e.eventName.startsWith(pfx)))
        .map((e) => e.payload),
    );
    expect(evtPayloads).not.toContain(PII_SENTINEL);
    for (const k of PII_KEYS) expect(evtPayloads).not.toContain(`"${k}"`);
  });
});
