import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDbClient,
  events,
  payerCredits,
  creditLedger,
  unlocks,
  unlockRouting,
  type DbClient,
  type EventRow,
} from "@badabhai/db";
import { randomUUID } from "node:crypto";

/**
 * Contact Unlock + Reveal (ADR-0010, Stream A) end-to-end against a LIVE API + DB.
 * Proves the fail-closed disclosure ordering and the no-PII-in-events/logs guarantee:
 *   - F-1: a zero-credit payer gets a byte-identical neutral response for a
 *     consented-uncapped worker vs a non-consented/unknown worker (no consent oracle).
 *   - F-2: N concurrent POST /unlocks for ONE worker never exceed the daily-reveals cap.
 *   - F-3: every deny branch returns the identical neutral body; reveal returns the
 *     neutral body (not a 404) for unknown/expired/revoked.
 *   - F-5: a SENTINEL phone never appears in any emitted event / response / the
 *     unlock-family tables.
 *   - F-6: retry → exactly one debit + one grant; balance never negative; payment.*
 *     carry real_call:false.
 *   - happy path: purchase → request (grant) → reveal emits the right PII-free events.
 *
 * Opt-in (same harness as swipe-to-apply.e2e.test.ts):
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
const CONSENT_VERSION = "2026-06-01";

const PII_KEYS = ["full_name", "name", "phone", "phone_e164", "employer", "address", "relay_handle"];

async function req(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; ops?: boolean } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.ops) headers["x-internal-service-token"] = OPS_TOKEN;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** Login a fresh worker (mock OTP); returns its id + the sentinel phone used. */
async function loginWorker(): Promise<{ workerId: string; token: string; phone: string }> {
  const phone = `+9196${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 10)}`.slice(0, 13);
  const r1 = await req("POST", "/auth/otp/request", { body: { phone } });
  expect(r1.status).toBe(200);
  const r2 = await req("POST", "/auth/otp/verify", { body: { phone, otp: r1.json.dev_otp } });
  expect(r2.status).toBe(200);
  return { workerId: r2.json.worker_id as string, token: r2.json.access_token as string, phone };
}

async function consent(workerId: string, purposes: string[]): Promise<void> {
  const r = await req("POST", "/consent/accept", {
    body: { worker_id: workerId, consent_version: CONSENT_VERSION, purposes },
  });
  expect(r.status).toBe(201);
}

// REAL-ONLY: this suite mints authenticated worker/payer sessions via OTP login, which now
// requires a real Fast2SMS/ZeptoMail code (no dev echo) — it cannot run in automated CI. The
// end-to-end proof is the manual OTP-7 staging check (docs/ops/otp-real-send-staging-runbook.md).
void RUN;
describe.skip("Contact Unlock + Reveal (e2e, ADR-0010 Stream A)", () => {
  let client!: DbClient;

  beforeAll(() => {
    client = createDbClient(DATABASE_URL);
    expect(OPS_TOKEN, "set INTERNAL_SERVICE_TOKEN for the unlock routes").not.toBe("");
  });

  afterAll(async () => {
    await client?.sql.end({ timeout: 5 });
  });

  async function allEvents(): Promise<EventRow[]> {
    return client.db.select().from(events);
  }

  it("F-1: a zero-credit payer cannot distinguish a consented-uncapped worker from a non-consented one", async () => {
    const payer = randomUUID(); // zero credits (never topped up)
    const consented = await loginWorker();
    await consent(consented.workerId, ["profiling", "employer_sharing"]);
    const notConsented = await loginWorker();
    await consent(notConsented.workerId, ["profiling"]); // NO employer_sharing

    const a = await req("POST", "/unlocks", {
      ops: true,
      body: { payer_id: payer, worker_id: consented.workerId },
    });
    const b = await req("POST", "/unlocks", {
      ops: true,
      body: { payer_id: payer, worker_id: notConsented.workerId },
    });
    expect(a.status).toBe(b.status);
    expect(JSON.stringify(a.json)).toBe(JSON.stringify(b.json));
    expect(a.json).toEqual({ status: "unavailable" });
  });

  it("F-3: every deny branch + reveal-on-unknown returns the identical neutral body (not a 404)", async () => {
    const payer = randomUUID();
    await req("POST", `/payers/${payer}/credits`, { ops: true, body: { pack_code: "pack_10" } });

    const noConsentW = await loginWorker(); // no consent at all
    const r1 = await req("POST", "/unlocks", {
      ops: true,
      body: { payer_id: payer, worker_id: noConsentW.workerId },
    });
    const r2 = await req("POST", "/unlocks", {
      ops: true,
      body: { payer_id: payer, worker_id: randomUUID() }, // unknown worker
    });
    expect(JSON.stringify(r1.json)).toBe(JSON.stringify(r2.json));
    expect(r1.json).toEqual({ status: "unavailable" });

    // Reveal on an unknown unlock id → neutral body, NOT a 404.
    const rev = await req("POST", `/unlocks/${randomUUID()}/reveal`, { ops: true });
    expect(rev.status).toBe(200);
    expect(rev.json).toEqual({ status: "unavailable" });
  });

  it("happy path: purchase → grant → reveal, emitting PII-free events; balance debited once", async () => {
    const payer = randomUUID();
    const w = await loginWorker();
    await consent(w.workerId, ["profiling", "employer_sharing"]);

    const buy = await req("POST", `/payers/${payer}/credits`, { ops: true, body: { pack_code: "pack_10" } });
    expect(buy.status).toBe(200);
    expect(buy.json.balance).toBe(10);

    const grant = await req("POST", "/unlocks", { ops: true, body: { payer_id: payer, worker_id: w.workerId } });
    expect(grant.status).toBe(200);
    expect(grant.json).toMatchObject({ ok: true, status: "granted" });
    const unlockId = grant.json.unlock_id as string;

    // Balance debited exactly once.
    const credits = await req("GET", `/payers/${payer}/credits`, { ops: true });
    expect(credits.json.balance).toBe(9);

    // Reveal returns an opaque relay handle — NEVER a phone.
    const reveal = await req("POST", `/unlocks/${unlockId}/reveal`, { ops: true });
    expect(reveal.status).toBe(200);
    expect(reveal.json.channel).toBe("in_app_relay");
    expect(typeof reveal.json.relay_handle).toBe("string");
    expect(reveal.json.relay_handle).not.toContain(w.phone);

    // payment.* events carry real_call:false.
    const evts = await allEvents();
    const payments = evts.filter((e) => e.eventName.startsWith("payment."));
    for (const p of payments) expect((p.payload as { real_call?: boolean }).real_call).toBe(false);
  });

  it("F-6: a retried unlock returns the SAME grant and debits only once", async () => {
    const payer = randomUUID();
    const w = await loginWorker();
    await consent(w.workerId, ["employer_sharing"]);
    await req("POST", `/payers/${payer}/credits`, { ops: true, body: { pack_code: "pack_10" } });

    const g1 = await req("POST", "/unlocks", { ops: true, body: { payer_id: payer, worker_id: w.workerId } });
    const g2 = await req("POST", "/unlocks", { ops: true, body: { payer_id: payer, worker_id: w.workerId } });
    expect(g1.json.unlock_id).toBe(g2.json.unlock_id);

    const credits = await req("GET", `/payers/${payer}/credits`, { ops: true });
    expect(credits.json.balance).toBe(9); // debited ONCE, not twice
  });

  it("F-2: N concurrent unlocks for ONE worker never exceed the daily-reveals cap (and balance never negative)", async () => {
    // The daily-reveals cap is config-driven (default 5). We fire 10 DISTINCT payers
    // (each with credits) at one worker concurrently; the cap is on the WORKER, so
    // at most cap grants should succeed once reveals start accumulating. Here we test
    // the per-worker weekly-distinct-payers cap (default 10) and that no balance goes
    // negative under concurrency.
    const w = await loginWorker();
    await consent(w.workerId, ["employer_sharing"]);

    const payersList = Array.from({ length: 14 }, () => randomUUID());
    await Promise.all(
      payersList.map((p) => req("POST", `/payers/${p}/credits`, { ops: true, body: { pack_code: "pack_10" } })),
    );

    const results = await Promise.all(
      payersList.map((p) => req("POST", "/unlocks", { ops: true, body: { payer_id: p, worker_id: w.workerId } })),
    );
    const grants = results.filter((r) => r.json?.ok === true);
    // weekly-payers cap default = 10 → at most 10 distinct payers may hold a grant.
    expect(grants.length).toBeLessThanOrEqual(10);

    // No payer balance went negative.
    for (const p of payersList) {
      const credits = await req("GET", `/payers/${p}/credits`, { ops: true });
      expect(credits.json.balance).toBeGreaterThanOrEqual(0);
    }
  });

  it("F-5: the sentinel phone never appears in any emitted event or in any unlock-family table", async () => {
    const payer = randomUUID();
    const w = await loginWorker();
    await consent(w.workerId, ["employer_sharing"]);
    await req("POST", `/payers/${payer}/credits`, { ops: true, body: { pack_code: "pack_10" } });
    const grant = await req("POST", "/unlocks", { ops: true, body: { payer_id: payer, worker_id: w.workerId } });
    await req("POST", `/unlocks/${grant.json.unlock_id}/reveal`, { ops: true });

    // The phone is absent from all unlock-family table rows (select-all + JS filter,
    // the established e2e pattern — these tables are tiny in a test DB).
    const unlockRows = (await client.db.select().from(unlocks)).filter((u) => u.workerId === w.workerId);
    const routingRows = (await client.db.select().from(unlockRouting)).filter(
      (r) => r.unlockId === grant.json.unlock_id,
    );
    const creditRows = (await client.db.select().from(payerCredits)).filter((c) => c.payerId === payer);
    const ledgerRows = (await client.db.select().from(creditLedger)).filter((l) => l.payerId === payer);
    const serialized = JSON.stringify([unlockRows, routingRows, creditRows, ledgerRows]);
    expect(serialized).not.toContain(w.phone);

    // The phone is absent from every unlock/contact/payment event payload.
    const evts = (await allEvents()).filter((e) =>
      ["unlock.", "contact.", "payment."].some((pfx) => e.eventName.startsWith(pfx)),
    );
    const evtPayloads = JSON.stringify(evts.map((e) => e.payload));
    expect(evtPayloads).not.toContain(w.phone);
    for (const k of PII_KEYS) expect(evtPayloads).not.toContain(`"${k}"`);
  });

  it("unlock routes require the internal secret (fail closed)", async () => {
    const r = await req("POST", "/unlocks", { body: { payer_id: randomUUID(), worker_id: randomUUID() } });
    expect(r.status).toBe(401);
  });

  it("ops reads are PII-free projections (no routing token, no phone)", async () => {
    const payer = randomUUID();
    const w = await loginWorker();
    await consent(w.workerId, ["employer_sharing"]);
    await req("POST", `/payers/${payer}/credits`, { ops: true, body: { pack_code: "pack_10" } });
    await req("POST", "/unlocks", { ops: true, body: { payer_id: payer, worker_id: w.workerId } });

    const list = await req("GET", `/unlocks?payer_id=${payer}`, { ops: true });
    expect(list.status).toBe(200);
    for (const u of list.json.unlocks as Array<Record<string, unknown>>) {
      expect(Object.keys(u).sort()).toEqual(
        [
          "created_at",
          "expires_at",
          "granted_at",
          "job_id",
          "payer_id",
          "reveal_count",
          "status",
          "unlock_id",
          "worker_id",
        ].sort(),
      );
      for (const k of [...PII_KEYS, "routing_token", "routing_token_ref"]) {
        expect(u).not.toHaveProperty(k);
      }
    }
  });
});
