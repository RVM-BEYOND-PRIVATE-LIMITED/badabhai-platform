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
 * ENFORCEMENT POSTURE (ADR-0016 posture B, D5 — CAPACITY_ENFORCEMENT_ENABLED):
 *   The API DEFAULTS to enforcement OFF (shadow). The flag flips whether an over-cap
 *   buyPlan ACTUALLY pauses. The two postures CONTRADICT on the same running config, so
 *   this suite SPLITS the cases by what the running API must have been started with:
 *
 *   - ENFORCEMENT cases (ATOMICITY / pause-at-limit) assert plans REALLY pause → they
 *     REQUIRE the API started with CAPACITY_ENFORCEMENT_ENABLED=true. They are GUARDED
 *     on E2E_CAPACITY_ENFORCED=1 and SKIP otherwise (so a default-started API does not
 *     red-fail them; you OPT IN once the API is started enforced).
 *   - SHADOW case (the new DEFAULT posture) asserts an over-cap buyPlan stays 'active'
 *     with paused=false + wouldPause=true and emits NO posting_plan.paused. It runs only
 *     when E2E_CAPACITY_ENFORCED is NOT set (i.e. against a default/shadow-started API).
 *
 *   You therefore run the suite TWICE to cover both postures (once per API posture):
 *     A) default-started API (flag OFF) → RUN_E2E=1 ...           → shadow case runs.
 *     B) API started CAPACITY_ENFORCEMENT_ENABLED=true            → enforcement cases run
 *        → RUN_E2E=1 E2E_CAPACITY_ENFORCED=1 ...                     (set BOTH env + flag).
 *   The faceless/no-PII case is posture-agnostic (it never asserts a pause) and runs in BOTH.
 *
 * Cases:
 *   - ATOMICITY [enforced]: set a payer's allowance to N, fire M>N concurrent buyPlan
 *     (distinct job_postings) at that ONE payer; assert AT MOST N plans land status=
 *     'active' and the rest 'paused' — the cap is NEVER exceeded under concurrency.
 *   - pause-at-limit [enforced]: a buyPlan that would exceed the cap returns paused=true
 *     + emits posting_plan.paused (reason capacity_exceeded).
 *   - SHADOW [default]: an over-cap buyPlan returns 201 with paused=false + wouldPause=true,
 *     persists status='active', and emits NO posting_plan.paused for it.
 *   - faceless / no-PII [any posture]: the PII sentinel + the PII key set never appear in
 *     payer_capacity / posting_plans rows or in any posting_plan.* / payment.* event
 *     payload (the contact-unlock.e2e PII_KEYS sweep).
 *
 * #1166 (2026-08-26): the ops `POST /payers/:payerId/capacity` route (`buyCapacity` via
 * `InternalServiceGuard`) was RETIRED — no caller existed anywhere in the repo, and it
 * duplicated the live payer-self `POST /payer/capacity` route. That retired the
 * auto-resume / capacity.purchased+payment.* / fail-closed-auth cases this suite used to
 * assert over HTTP against it (removed below, not ported — the live route has no headless
 * session-mint harness here, see BL-18). `buyCapacity`'s auto-resume + event-emission
 * behaviour remains unit-tested (mocked lockPayer) in `posting-plans.service.test.ts`;
 * only the real-Postgres/advisory-lock proof of THAT path is no longer exercised e2e.
 *
 * Opt-in (same harness as contact-unlock.e2e.test.ts):
 *   1. docker compose up -d postgres redis     # or point at Supabase
 *   2. pnpm db:migrate
 *   3a. SHADOW (default posture):
 *       INTERNAL_SERVICE_TOKEN=<token> pnpm --filter @badabhai/api start  (another terminal)
 *       RUN_E2E=1 INTERNAL_SERVICE_TOKEN=<token> pnpm --filter @badabhai/e2e test
 *   3b. ENFORCEMENT posture (start the API ENFORCED, then opt the enforced cases in):
 *       CAPACITY_ENFORCEMENT_ENABLED=true INTERNAL_SERVICE_TOKEN=<token> \
 *         pnpm --filter @badabhai/api start  (another terminal)
 *       RUN_E2E=1 E2E_CAPACITY_ENFORCED=1 INTERNAL_SERVICE_TOKEN=<token> \
 *         pnpm --filter @badabhai/e2e test
 * The AI service is NOT required (this surface never calls an LLM).
 */

const RUN = process.env.RUN_E2E === "1";
// Set to 1 ONLY when the running API was started with CAPACITY_ENFORCEMENT_ENABLED=true.
// Gates the enforcement cases (which assert real pauses) vs the shadow case (default
// posture) so the two never contradict on the same running config (ADR-0016 D5).
const ENFORCED = process.env.E2E_CAPACITY_ENFORCED === "1";
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

// BL-18: this suite was hard-`describe.skip`ped as "mints an authenticated payer session
// via OTP login" — that claim was STALE even before OTP went real-only. Read the whole file:
// every case drives `POST /job-postings/:id/plan` through `InternalServiceGuard` (the ops
// `x-internal-service-token` header) against a bare `randomUUID()` `payer_id`, never a
// Bearer payer session. That is by design — `payer_capacity` and `posting_plans` are the
// deliberately FK-less "opaque rail" (see packages/db/src/schema/payer.ts's own comment on
// `payerCapacity`/`postingPlans`): no `payers` row is required to exercise this surface at
// all, so there was never a payer login to unblock here. Opt-in via `RUN` (RUN_E2E) same as
// every other e2e file; `describe.skipIf` (not a hard skip) so the suite actually executes
// wherever RUN is set, CI included. (#1166: the ops `/payers/:payerId/capacity` route this
// comment used to also name was retired — see the file header.)
describe.skipIf(!RUN)("Per-payer hiring capacity (e2e, ADR-0016)", () => {
  let client!: DbClient;

  beforeAll(() => {
    client = createDbClient(DATABASE_URL);
    expect(OPS_TOKEN, "set INTERNAL_SERVICE_TOKEN for the ops job-postings/plan route").not.toBe("");
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

  // ENFORCED-ONLY: these assert plans REALLY pause, so they require the API started with
  // CAPACITY_ENFORCEMENT_ENABLED=true. They SKIP against a default/shadow API (E2E_CAPACITY_ENFORCED unset).
  it.skipIf(!ENFORCED)("ATOMICITY: M>N concurrent buyPlan for ONE payer never exceed the cap (advisory-lock proof)", async () => {
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

  it.skipIf(!ENFORCED)("pause-at-limit: a buyPlan over the cap returns paused=true and emits posting_plan.paused", async () => {
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

  // #1166: an "auto-resume" case (buying more capacity via the ops route to flip the
  // oldest paused plans active) used to live here. It drove `POST /payers/:payerId/capacity`,
  // which is retired — see the file header. `PostingPlansService.buyCapacity`'s auto-resume
  // ordering + event emission stays unit-tested in `posting-plans.service.test.ts`.

  // SHADOW-ONLY (the new DEFAULT posture, ADR-0016 D5): runs against a default-started API
  // (E2E_CAPACITY_ENFORCED unset). An over-cap buyPlan does NOT pause — it persists 'active'
  // with paused=false + wouldPause=true, and emits NO posting_plan.paused. This is the
  // counterpart to pause-at-limit; the two are mutually gated so they never contradict on
  // one running config.
  it.skipIf(ENFORCED)("SHADOW (enforcement OFF, default): over-cap buyPlan stays active (paused=false, wouldPause=true) and emits no posting_plan.paused", async () => {
    const payer = randomUUID();
    await setCapacity(payer, 1);

    // First plan: within cap (0+1 ≤ 1) → active, not a would-pause.
    const first = await req("POST", `/job-postings/${await seedPosting()}/plan`, {
      ops: true,
      body: { payer_id: payer, tier: "standard" },
    });
    expect(first.status).toBe(201);
    expect(first.json.paused).toBe(false);
    expect(first.json.wouldPause).toBe(false);

    // Second plan: over cap (1+1 > 1). In shadow mode it is NOT paused: 201, paused=false,
    // but the would-pause decision is surfaced (wouldPause=true).
    const second = await req("POST", `/job-postings/${await seedPosting()}/plan`, {
      ops: true,
      body: { payer_id: payer, tier: "standard" },
    });
    expect(second.status).toBe(201);
    expect(second.json.paused).toBe(false); // nothing actually paused in shadow
    expect(second.json.wouldPause).toBe(true); // but the over-cap decision is surfaced
    const overCapPlanId = second.json.plan.id as string;

    // The plan PERSISTS as status='active' in the DB (shadow does not pause).
    const plans = await plansForPayer(payer);
    expect(plans.length).toBe(2);
    expect(plans.every((p) => p.status === "active")).toBe(true);
    const overCapPlan = plans.find((p) => p.id === overCapPlanId);
    expect(overCapPlan?.status).toBe("active");

    // NO posting_plan.paused was emitted for the over-cap plan (pausing nothing must not
    // emit a pause — event↔state honesty; the would-pause is a PII-free LOG line only).
    const pausedForPlan = (await allEvents()).filter(
      (e) => e.eventName === "posting_plan.paused" && (e.payload as { plan_id?: string }).plan_id === overCapPlanId,
    );
    expect(pausedForPlan.length).toBe(0);

    // The receipt is still real: both plans emit payment.* + job_posting.purchased.
    const purchased = (await allEvents()).filter(
      (e) => e.eventName === "job_posting.purchased" && (e.payload as { plan_id?: string }).plan_id === overCapPlanId,
    );
    expect(purchased.length).toBe(1);
  });

  // #1166: "emits capacity.purchased + payment.*" and "the capacity route requires the
  // internal secret (fail closed)" used to live here, both driving the now-retired ops
  // `POST /payers/:payerId/capacity` route directly. Removed, not ported — see the file
  // header. The live payer-self `POST /payer/capacity` route (payer-portal) has its own
  // unit coverage for the same event emission + auth posture.

  it("faceless: the PII sentinel + PII keys never appear in capacity rows or in posting_plan.* / payment.* events", async () => {
    // A purchase + pause cycle, with the PII sentinel attached only to the (PII-bearing)
    // job_posting org label — it must NOT leak into the faceless rails.
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

    // The faceless rails (capacity + plan rows) never carry the sentinel or any PII key.
    const capRows = (await client.db.select().from(payerCapacity)).filter((c) => c.payerId === payer);
    const planRows = await plansForPayer(payer);
    const rowsSerialized = JSON.stringify([capRows, planRows]);
    expect(rowsSerialized).not.toContain(PII_SENTINEL);
    for (const k of PII_KEYS) expect(rowsSerialized).not.toContain(`"${k}"`);

    // No posting_plan.*/payment.* event payload carries the sentinel or a PII key.
    const evtPayloads = JSON.stringify(
      (await allEvents())
        .filter((e) => ["posting_plan.", "payment."].some((pfx) => e.eventName.startsWith(pfx)))
        .map((e) => e.payload),
    );
    expect(evtPayloads).not.toContain(PII_SENTINEL);
    for (const k of PII_KEYS) expect(evtPayloads).not.toContain(`"${k}"`);
  });
});
