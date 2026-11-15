import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, creditLedger, events, unlocks, type DbClient } from "@badabhai/db";
import { and, eq } from "drizzle-orm";
import { mintPayerSession } from "./helpers/payer-session";
import { syntheticPhoneMinter } from "./helpers/synthetic-phone";

/**
 * #2747 items 5 and 6 (ADR-0064 §3.3–3.4) — OPEN ONCE, READ MANY TIMES, end to end.
 *
 * Against the running API with `CONTACT_RULES_ROLLOUT=on` (the e2e job's env): a company opens a
 * worker with one credit, reads his full name and phone on screen as often as it likes, re-opens
 * him for nothing, and still reads him after his grant's stored date has passed (a contact opened
 * long ago). One debit, ever. Every read writes `contact.viewed`, which never carries the number.
 *
 * Opt-in, same harness as contact-unlock.e2e.test.ts (RUN_E2E=1 + E2E_UNLOCK_SUITE=1, the worker
 * and payer test-login seams armed). Skipped unless the API runs with the rule on.
 */
const RUN =
  process.env.RUN_E2E === "1" &&
  process.env.E2E_UNLOCK_SUITE === "1" &&
  process.env.CONTACT_RULES_ROLLOUT === "on";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:3001";
const OPS_TOKEN = process.env.INTERNAL_SERVICE_TOKEN ?? "";
const TEST_LOGIN_TOKEN = process.env.TEST_LOGIN_TOKEN ?? "";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";
const CONSENT_VERSION = "2026-11-04";
const FULL_NAME = "Ramesh Kumar Testcase";

const syntheticPhone = syntheticPhoneMinter(70);

async function req(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; ops?: boolean; testLogin?: boolean } = {},
): Promise<{ status: number; json: any; headers: Headers }> {
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
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
}

describe.skipIf(!RUN)("Contacts open for good (e2e, #2747)", () => {
  let client!: DbClient;

  beforeAll(() => {
    client = createDbClient(DATABASE_URL);
    expect(OPS_TOKEN, "set INTERNAL_SERVICE_TOKEN for the ops credit route").not.toBe("");
    expect(TEST_LOGIN_TOKEN, "set TEST_LOGIN_TOKEN (>=32 chars)").not.toBe("");
  });

  afterAll(async () => {
    await client?.sql.end({ timeout: 5 });
  });

  it("one credit opens him for good: read many times, re-open free, still open long after", async () => {
    // A consenting worker with a name on file.
    const phone = syntheticPhone();
    const login = await req("POST", "/auth/test-login", { body: { phone }, testLogin: true });
    expect(login.status).toBe(200);
    const workerId = login.json.worker_id as string;
    const workerToken = login.json.access_token as string;
    const consented = await req("POST", "/consent/accept", {
      body: { consent_version: CONSENT_VERSION, purposes: ["profiling", "employer_sharing"] },
      token: workerToken,
    });
    expect(consented.status).toBe(201);
    const named = await req("PATCH", "/workers/me/name", {
      body: { full_name: FULL_NAME },
      token: workerToken,
    });
    expect(named.status).toBe(200);

    // A company with credits.
    const company = await mintPayerSession();
    const buy = await req("POST", `/payers/${company.payerId}/credits`, {
      ops: true,
      body: { pack_code: "pack_10" },
    });
    expect(buy.json.balance).toBe(10);

    // Open once: one debit, open for good.
    const grant = await req("POST", "/payer/unlocks", {
      token: company.token,
      body: { worker_id: workerId },
    });
    expect(grant.status).toBe(200);
    expect(grant.json).toMatchObject({ ok: true, status: "granted", open_until: null });
    expect(Number.isNaN(Date.parse(grant.json.expires_at))).toBe(false);
    const unlockId = grant.json.unlock_id as string;

    // Read many times: the full name and the number, never cached.
    for (let i = 0; i < 3; i += 1) {
      const read = await req("GET", `/payer/unlocks/${unlockId}/contact`, { token: company.token });
      expect(read.status).toBe(200);
      expect(read.json).toMatchObject({ ok: true, full_name: FULL_NAME, phone });
      expect(read.headers.get("cache-control")).toBe("no-store");
    }

    // Re-open: the same grant, nothing charged.
    const again = await req("POST", "/payer/unlocks", {
      token: company.token,
      body: { worker_id: workerId },
    });
    expect(again.json).toMatchObject({ unlock_id: unlockId, open_until: null });

    // Long after: push the stored date into the past (a contact opened under the old window).
    await client.db
      .update(unlocks)
      .set({ expiresAt: new Date("2025-01-01T00:00:00.000Z") })
      .where(eq(unlocks.id, unlockId));
    const later = await req("GET", `/payer/unlocks/${unlockId}/contact`, { token: company.token });
    expect(later.json).toMatchObject({ ok: true, full_name: FULL_NAME, phone });

    // One debit, ever.
    const debits = await client.db
      .select()
      .from(creditLedger)
      .where(
        and(eq(creditLedger.payerId, company.payerId), eq(creditLedger.reason, "unlock_debit")),
      );
    expect(debits).toHaveLength(1);
    const credits = await req("GET", "/payer/credits", { token: company.token });
    expect(credits.json.balance).toBe(9);

    // Every read audited by id, never with the number or the name.
    const viewed = (
      await client.db.select().from(events).where(eq(events.eventName, "contact.viewed"))
    ).filter((e) => (e.payload as { unlock_id?: string }).unlock_id === unlockId);
    expect(viewed).toHaveLength(4);
    for (const e of viewed) {
      expect(JSON.stringify(e.payload)).not.toContain(phone);
      expect(JSON.stringify(e.payload)).not.toContain("Ramesh");
    }
  });

  it("another company cannot read a contact it did not open", async () => {
    const phone = syntheticPhone();
    const login = await req("POST", "/auth/test-login", { body: { phone }, testLogin: true });
    const consented = await req("POST", "/consent/accept", {
      body: { consent_version: CONSENT_VERSION, purposes: ["profiling", "employer_sharing"] },
      token: login.json.access_token,
    });
    expect(consented.status).toBe(201);
    const owner = await mintPayerSession();
    await req("POST", `/payers/${owner.payerId}/credits`, {
      ops: true,
      body: { pack_code: "pack_10" },
    });
    const grant = await req("POST", "/payer/unlocks", {
      token: owner.token,
      body: { worker_id: login.json.worker_id },
    });
    const stranger = await mintPayerSession();
    const read = await req("GET", `/payer/unlocks/${grant.json.unlock_id}/contact`, {
      token: stranger.token,
    });
    expect(read.status).toBe(200);
    expect(read.json).toEqual({ status: "unavailable" });
    expect(JSON.stringify(read.json)).not.toContain(phone);
  });
});
