import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDbClient,
  creditLedger,
  events,
  featurePilotPayers,
  unlocks,
  type DbClient,
} from "@badabhai/db";
import { BRIEF_CONTACT_NOTICE_VERSIONS } from "@badabhai/types";
import { and, eq } from "drizzle-orm";
import { SEED_PACK } from "./helpers/credit-packs";
import { mintPayerSession, type MintedPayerSession } from "./helpers/payer-session";
import { syntheticPhoneMinter } from "./helpers/synthetic-phone";

/**
 * #2747 items 5 and 6 (ADR-0064 §3.3, §3.4, §3.8) — contacts open for good, end to end.
 *
 * The e2e job runs the API with `CONTACT_RULES_ROLLOUT=pilot`, so every OTHER suite keeps the
 * production default (off) and this one puts its own companies on the pilot list
 * (`feature_pilot_payers`), the path a pilot company takes in production.
 *
 *  - Runs now: a worker whose consent is on the 2026-11-04 notice ("14 din tak", initials) keeps
 *    exactly those rules even for a pilot company — no contact read, the dated window. And no
 *    company reads a contact it did not open.
 *  - Arms itself when a notice describing the brief's rules ships (`BRIEF_CONTACT_NOTICE_VERSIONS`
 *    non-empty): open once, read many times — one credit, the full name and phone as often as the
 *    company likes, a free re-open, still open after the stored date has passed, one debit ever.
 *
 * Opt-in, the same harness as contact-unlock.e2e.test.ts (RUN_E2E=1 + E2E_UNLOCK_SUITE=1, both
 * test-login seams armed).
 */
const RULES = process.env.CONTACT_RULES_ROLLOUT ?? "";
const RUN =
  process.env.RUN_E2E === "1" &&
  process.env.E2E_UNLOCK_SUITE === "1" &&
  (RULES === "pilot" || RULES === "on");
const BRIEF_NOTICE = BRIEF_CONTACT_NOTICE_VERSIONS.at(-1);
const API_URL = process.env.E2E_API_URL ?? "http://localhost:3001";
const OPS_TOKEN = process.env.INTERNAL_SERVICE_TOKEN ?? "";
const TEST_LOGIN_TOKEN = process.env.TEST_LOGIN_TOKEN ?? "";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";
/** The approved 2026-11-04 notice: 14 days, initials, no name before an unlock. */
const OLD_NOTICE = "2026-11-04";
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

  /** A consenting worker with a name on file, his consent given on `noticeVersion`. */
  async function worker(noticeVersion: string): Promise<{ workerId: string; phone: string }> {
    const phone = syntheticPhone();
    const login = await req("POST", "/auth/test-login", { body: { phone }, testLogin: true });
    expect(login.status).toBe(200);
    const token = login.json.access_token as string;
    const consented = await req("POST", "/consent/accept", {
      body: { consent_version: noticeVersion, purposes: ["profiling", "employer_sharing"] },
      token,
    });
    expect(consented.status).toBe(201);
    const named = await req("PATCH", "/workers/me/name", { body: { full_name: FULL_NAME }, token });
    expect(named.status).toBe(200);
    return { workerId: login.json.worker_id as string, phone };
  }

  /** A company with {@link SEED_PACK}'s credits, on the `contact_rules` pilot list. */
  async function pilotCompany(): Promise<MintedPayerSession> {
    const company = await mintPayerSession();
    const buy = await req("POST", `/payers/${company.payerId}/credits`, {
      ops: true,
      body: { pack_code: SEED_PACK.code },
    });
    expect(buy.json.balance).toBe(SEED_PACK.credits);
    await client.db.insert(featurePilotPayers).values({
      feature: "contact_rules",
      payerId: company.payerId,
      addedBy: "e2e",
      reason: "#2747 e2e pilot company",
    });
    return company;
  }

  it("a worker on the 2026-11-04 notice keeps its rules, even for a pilot company: the dated window and no contact read", async () => {
    const w = await worker(OLD_NOTICE);
    const company = await pilotCompany();
    const grant = await req("POST", "/payer/unlocks", {
      token: company.token,
      body: { worker_id: w.workerId },
    });
    expect(grant.json).toMatchObject({ ok: true, status: "granted" });
    expect(grant.json.open_until).not.toBeNull();
    const read = await req("GET", `/payer/unlocks/${grant.json.unlock_id}/contact`, {
      token: company.token,
    });
    expect(read.status).toBe(200);
    expect(read.json).toEqual({ status: "unavailable" });
    expect(JSON.stringify(read.json)).not.toContain(w.phone);
  });

  it("a company NOT on the pilot list: the contact route is not there", async () => {
    const w = await worker(OLD_NOTICE);
    const company = await mintPayerSession();
    const buy = await req("POST", `/payers/${company.payerId}/credits`, {
      ops: true,
      body: { pack_code: SEED_PACK.code },
    });
    expect(buy.json.balance).toBe(SEED_PACK.credits);
    const grant = await req("POST", "/payer/unlocks", {
      token: company.token,
      body: { worker_id: w.workerId },
    });
    // The contact route is only reached with a REAL unlock id: without one the request is
    // `/payer/unlocks/undefined/contact`, which fails the id check (400) before the pilot gate.
    expect(grant.json).toMatchObject({ ok: true, status: "granted" });
    const read = await req("GET", `/payer/unlocks/${grant.json.unlock_id}/contact`, {
      token: company.token,
    });
    expect(read.status).toBe(404);
  });

  it.skipIf(BRIEF_NOTICE === undefined)(
    "one credit opens him for good: read many times, re-open free, still open long after",
    async () => {
      const w = await worker(BRIEF_NOTICE!);
      const company = await pilotCompany();

      const grant = await req("POST", "/payer/unlocks", {
        token: company.token,
        body: { worker_id: w.workerId },
      });
      expect(grant.json).toMatchObject({ ok: true, status: "granted", open_until: null });
      const unlockId = grant.json.unlock_id as string;

      for (let i = 0; i < 3; i += 1) {
        const read = await req("GET", `/payer/unlocks/${unlockId}/contact`, {
          token: company.token,
        });
        expect(read.json).toMatchObject({ ok: true, full_name: FULL_NAME, phone: w.phone });
        expect(read.headers.get("cache-control")).toBe("no-store");
      }

      const again = await req("POST", "/payer/unlocks", {
        token: company.token,
        body: { worker_id: w.workerId },
      });
      expect(again.json).toMatchObject({ unlock_id: unlockId, open_until: null });

      await client.db
        .update(unlocks)
        .set({ expiresAt: new Date("2025-01-01T00:00:00.000Z") })
        .where(eq(unlocks.id, unlockId));
      const later = await req("GET", `/payer/unlocks/${unlockId}/contact`, {
        token: company.token,
      });
      expect(later.json).toMatchObject({ ok: true, full_name: FULL_NAME, phone: w.phone });

      const debits = await client.db
        .select()
        .from(creditLedger)
        .where(
          and(eq(creditLedger.payerId, company.payerId), eq(creditLedger.reason, "unlock_debit")),
        );
      expect(debits).toHaveLength(1);

      const viewed = (
        await client.db.select().from(events).where(eq(events.eventName, "contact.viewed"))
      ).filter((e) => (e.payload as { unlock_id?: string }).unlock_id === unlockId);
      expect(viewed).toHaveLength(4);
      for (const e of viewed) {
        expect(JSON.stringify(e.payload)).not.toContain(w.phone);
        expect(JSON.stringify(e.payload)).not.toContain("Ramesh");
      }
    },
  );

  // Meaningful only once the OWNER can read him (a worker on a brief notice): before that every
  // read is neutral and a stranger's neutral body would prove nothing about tenancy.
  it.skipIf(BRIEF_NOTICE === undefined)("no company reads a contact it did not open", async () => {
    const w = await worker(BRIEF_NOTICE!);
    const owner = await pilotCompany();
    const grant = await req("POST", "/payer/unlocks", {
      token: owner.token,
      body: { worker_id: w.workerId },
    });
    const own = await req("GET", `/payer/unlocks/${grant.json.unlock_id}/contact`, {
      token: owner.token,
    });
    expect(own.json).toMatchObject({ ok: true, phone: w.phone });
    const stranger = await pilotCompany();
    const read = await req("GET", `/payer/unlocks/${grant.json.unlock_id}/contact`, {
      token: stranger.token,
    });
    expect(read.status).toBe(200);
    expect(read.json).toEqual({ status: "unavailable" });
    expect(JSON.stringify(read.json)).not.toContain(w.phone);
  });
});
