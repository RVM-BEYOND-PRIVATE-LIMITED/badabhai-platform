import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, events, jobs, type DbClient, type EventRow } from "@badabhai/db";

/**
 * Alpha swipe-to-apply (ADR-0009 Stream B) end-to-end against a LIVE API + DB.
 * Proves the behavioural-event producer works honestly and the privacy/consent
 * invariants hold:
 *   login (mock OTP) -> consent -> GET /feed (one feed.shown per item, PII-free
 *   shapes) -> apply/skip (VALIDATED application.submitted/skipped, idempotent)
 *   -> ops reads (PII-free projections). Plus: a NON-consented worker is blocked
 *   (403) and an unknown jobId is 404 — and NO PII appears in any emitted payload.
 *
 * Opt-in (same harness as phase1-flow.e2e.test.ts):
 *   1. docker compose up -d postgres redis     # or point at Supabase + Redis
 *   2. pnpm db:migrate && pnpm --filter @badabhai/db db:seed:jobs
 *   3. TEST_LOGIN_ENABLED=true TEST_LOGIN_TOKEN=<32+ chars> INTERNAL_SERVICE_TOKEN=<token>
 *      pnpm --filter @badabhai/api start        # (or `dev`) in another terminal
 *   4. RUN_E2E=1 TEST_LOGIN_TOKEN=<same value> INTERNAL_SERVICE_TOKEN=<token>
 *      pnpm --filter @badabhai/e2e test
 *      (PowerShell:  $env:RUN_E2E=1; ...)
 *
 * The same INTERNAL_SERVICE_TOKEN must be set for the running API (it gates the
 * ops reads). The AI service is NOT required (this surface never calls an LLM).
 */

// D-3 test-login gate secret. Without it the seam answers a neutral 404 and no worker
// session can be minted — see login() for why OTP is not an option here.
const TEST_LOGIN_TOKEN = process.env.TEST_LOGIN_TOKEN ?? "";
const RUN = process.env.RUN_E2E === "1" && TEST_LOGIN_TOKEN.length > 0;
const API_URL = process.env.E2E_API_URL ?? "http://localhost:3001";
const OPS_TOKEN = process.env.INTERNAL_SERVICE_TOKEN ?? "";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";
const CONSENT_VERSION = "2026-06-01";

// A coarse, PII-free shape the feed/ops reads must never exceed.
const PII_KEYS = [
  "full_name",
  "name",
  "phone",
  "phone_e164",
  "employer",
  "employer_name",
  "pay",
  "salary",
  "address",
];

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

/**
 * A phone in the ONLY range the D-3 mint will serve: SYNTHETIC_TEST_PHONE_PATTERN
 * (`/^\+910{5}\d{5}$/`, i.e. `+9100000` + 5 digits). `AuthService.testLogin` refuses
 * anything else before finding or creating a worker.
 */
function syntheticPhone(): string {
  return `+9100000${String(Math.floor(Math.random() * 100_000)).padStart(5, "0")}`;
}

/**
 * Login a fresh worker via the D-3 test-login mint seam and return its id + bearer
 * token. Was OTP request/verify against the console-echoed dev_otp — that echo does
 * not exist at any boundary any more (SMS_PROVIDER is real-only), so the OTP route
 * cannot authenticate a test worker in CI at all. POST /auth/test-login is the seam
 * built for exactly this (gated, prod-boot-blocked) and returns the same
 * { worker_id, access_token } shape OTP verify does.
 */
async function login(): Promise<{ workerId: string; token: string }> {
  const phone = syntheticPhone();
  const r = await req("POST", "/auth/test-login", { body: { phone }, testLogin: true });
  expect(
    r.status,
    "POST /auth/test-login must be armed: set TEST_LOGIN_ENABLED=true and a >=32-char " +
      "TEST_LOGIN_TOKEN on BOTH the API process and this test runner",
  ).toBe(200);
  return { workerId: r.json.worker_id as string, token: r.json.access_token as string };
}

async function acceptConsent(token: string): Promise<void> {
  // `POST /consent/accept` is WORKER-AUTHED: the subject is the SESSION worker,
  // never a body id. Sending `worker_id` would be silently stripped by the DTO.
  const r = await req("POST", "/consent/accept", {
    body: {
      consent_version: CONSENT_VERSION,
      purposes: ["profiling", "resume_generation"],
    },
    token,
  });
  expect(r.status).toBe(201);
}

// BL-18: un-gated. Was a bare describe.skip because OTP login requires a real Fast2SMS
// code (no dev echo) — login() now goes through the D-3 test-login mint seam instead,
// the same pattern referral-round-trip.e2e.test.ts and contact-unlock.e2e.test.ts
// already use successfully in CI.
describe.skipIf(!RUN)("Alpha swipe-to-apply (e2e, ADR-0009)", () => {
  let client!: DbClient;
  let worker!: { workerId: string; token: string };

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL);
    // Sanity: the jobs seed must be applied for this surface to have a job source.
    const jobRows = await client.db.select().from(jobs);
    expect(jobRows.length, "run `db:seed:jobs` before the e2e").toBeGreaterThan(0);
    worker = await login();
    await acceptConsent(worker.token);
  });

  afterAll(async () => {
    await client?.sql.end({ timeout: 5 });
  });

  /** Events whose payload.worker_id is this worker's. */
  async function myEvents(name?: string): Promise<EventRow[]> {
    const rows = await client.db.select().from(events);
    return rows.filter((e) => {
      const wid = (e.payload as { worker_id?: string } | null)?.worker_id;
      return wid === worker.workerId && (!name || e.eventName === name);
    });
  }

  it("GET /feed returns PII-free coarse items and emits one feed.shown per item", async () => {
    const r = await req("GET", "/feed?limit=5", { token: worker.token });
    expect(r.status).toBe(200);
    const items = r.json.jobs as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(5);

    // Coarse shape only: job_id/trade_key/title/city/area/rank + the job's
    // experience window — and rank is 1-based. The window is year counts, which
    // the schema classes PII-FREE alongside pay bands (never an employer, never
    // a worker identity); it backs the Jobs-tab Experience filter (ADR-0024
    // addendum 2026-07-15). Still NO employer and NO pay on this path.
    items.forEach((item, i) => {
      expect(Object.keys(item).sort()).toEqual(
        [
          "area",
          "city",
          "job_id",
          "max_experience_years",
          "min_experience_years",
          "rank",
          "title",
          "trade_key",
        ].sort(),
      );
      expect(item.rank).toBe(i + 1);
      for (const k of PII_KEYS) expect(item).not.toHaveProperty(k);
    });

    // One feed.shown per returned item (R-A: per-impression, no dedupe).
    const shown = await myEvents("feed.shown");
    expect(shown.length).toBeGreaterThanOrEqual(items.length);
    const shownForThisFetch = shown.filter((e) =>
      items.some((it) => (e.payload as { job_id?: string }).job_id === it.job_id),
    );
    expect(shownForThisFetch.length).toBeGreaterThanOrEqual(items.length);
    // Honest unranked signals.
    for (const e of shownForThisFetch) {
      const p = e.payload as { score?: number; hot?: boolean };
      expect(p.score).toBe(0);
      expect(p.hot).toBe(false);
    }
  });

  it("POST apply is idempotent (one row) and emits a validated application.submitted", async () => {
    const feed = await req("GET", "/feed?limit=1", { token: worker.token });
    const jobId = feed.json.jobs[0].job_id as string;

    const a1 = await req("POST", `/applications/${jobId}/apply`, {
      token: worker.token,
      body: { rank: 1, source_surface: "feed" },
    });
    expect(a1.status).toBe(200);
    expect(a1.json).toMatchObject({ ok: true, action: "applied" });
    const appId = a1.json.application_id as string;

    // Repeat apply → same row (idempotent), 200.
    const a2 = await req("POST", `/applications/${jobId}/apply`, {
      token: worker.token,
      body: { rank: 1, source_surface: "feed" },
    });
    expect(a2.status).toBe(200);
    expect(a2.json.application_id).toBe(appId);

    // Validated event written; payload PII-free + correctly shaped.
    const submitted = (await myEvents("application.submitted")).filter(
      (e) => (e.payload as { job_id?: string }).job_id === jobId,
    );
    expect(submitted.length).toBeGreaterThanOrEqual(1);
    const p = submitted[0]!.payload as Record<string, unknown>;
    expect(Object.keys(p).sort()).toEqual(["job_id", "rank", "source_surface", "worker_id"].sort());
    expect(p.worker_id).toBe(worker.workerId);
  });

  it("POST skip flips the decision in place and emits a validated application.skipped", async () => {
    const feed = await req("GET", "/feed?limit=2", { token: worker.token });
    const jobId = feed.json.jobs[feed.json.jobs.length - 1].job_id as string;

    const s = await req("POST", `/applications/${jobId}/skip`, {
      token: worker.token,
      body: { reason: "too_far" },
    });
    expect(s.status).toBe(200);
    expect(s.json).toMatchObject({ ok: true, action: "skipped" });

    const skipped = (await myEvents("application.skipped")).filter(
      (e) => (e.payload as { job_id?: string }).job_id === jobId,
    );
    expect(skipped.length).toBeGreaterThanOrEqual(1);
    const p = skipped[0]!.payload as Record<string, unknown>;
    expect(Object.keys(p).sort()).toEqual(["job_id", "reason", "worker_id"].sort());
    expect(p.reason).toBe("too_far");
  });

  it("a NON-consented worker is blocked by the consent gate (403)", async () => {
    const fresh = await login(); // logged in but did NOT accept consent
    const r = await req("GET", "/feed", { token: fresh.token });
    expect(r.status).toBe(403);
  });

  it("an unknown jobId returns 404 (no oracle) on apply and skip", async () => {
    const unknown = "00000000-0000-4000-8000-0000000000ff";
    const a = await req("POST", `/applications/${unknown}/apply`, {
      token: worker.token,
      body: {},
    });
    expect(a.status).toBe(404);
    const s = await req("POST", `/applications/${unknown}/skip`, {
      token: worker.token,
      body: {},
    });
    expect(s.status).toBe(404);
  });

  it("worker routes require auth (401 without a token)", async () => {
    const r = await req("GET", "/feed");
    expect(r.status).toBe(401);
  });

  it("ops reads return PII-free projections", async () => {
    const feed = await req("GET", "/feed?limit=1", { token: worker.token });
    const jobId = feed.json.jobs[0].job_id as string;
    await req("POST", `/applications/${jobId}/apply`, { token: worker.token, body: {} });

    // Applicants per job — worker_id only, no name/phone.
    const applicants = await req("GET", `/jobs/${jobId}/applicants`, { ops: true });
    expect(applicants.status).toBe(200);
    expect(applicants.json.job_id).toBe(jobId);
    for (const a of applicants.json.applicants as Array<Record<string, unknown>>) {
      expect(Object.keys(a).sort()).toEqual(
        [
          "action",
          "created_at",
          "reason",
          "rank",
          "source_surface",
          "updated_at",
          "worker_id",
        ].sort(),
      );
      for (const k of PII_KEYS) expect(a).not.toHaveProperty(k);
    }

    // A worker's applications — coarse job fields, no employer/pay.
    const wapps = await req("GET", `/workers/${worker.workerId}/applications`, { ops: true });
    expect(wapps.status).toBe(200);
    expect(wapps.json.worker_id).toBe(worker.workerId);
    for (const a of wapps.json.applications as Array<Record<string, unknown>>) {
      for (const k of PII_KEYS) expect(a).not.toHaveProperty(k);
      expect(a).toHaveProperty("trade_key");
      expect(a).toHaveProperty("city");
    }
  });

  it("never writes any PII into the swipe-to-apply event payloads", async () => {
    const all = [
      ...(await myEvents("feed.shown")),
      ...(await myEvents("application.submitted")),
      ...(await myEvents("application.skipped")),
    ];
    expect(all.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(all.map((e) => e.payload));
    // No PII-shaped key in any payload.
    for (const k of PII_KEYS) expect(serialized).not.toContain(`"${k}"`);
  });
});
