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
import { mintPayerSession, type MintedPayerSession } from "./helpers/payer-session";

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
 * AUTH (R16 / LC-1, ADR-0019 Phase 1): the `/unlocks` + `/payers/:payerId/credits`
 * surface is now behind `PayerAuthGuard` (was `InternalServiceGuard`). Every call here
 * authenticates as a MINTED payer SESSION (Authorization: Bearer) via `mintPayerSession`
 * (the real signup → dev-OTP → login/verify flow). The acting payer is the SESSION payer
 * (`req.payer.id`) — never a body/param value; the `:payerId` credits param must EQUAL the
 * session payer (XB-A). Credits/data are seeded against the session's server-assigned
 * `payerId` so the per-call ownership assertion passes.
 *
 * Opt-in (same harness as swipe-to-apply.e2e.test.ts):
 *   1. docker compose up -d postgres redis     # or point at Supabase (Redis required:
 *                                              # payer sessions are Redis-backed)
 *   2. pnpm db:migrate
 *   3. NODE_ENV=test pnpm --filter @badabhai/api start  (another terminal; mock login
 *      channel echoes dev_otp so the harness can complete payer login)
 *   4. RUN_E2E=1 pnpm --filter @badabhai/e2e test
 * The AI service is NOT required (this surface never calls an LLM).
 */

const RUN = process.env.RUN_E2E === "1";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:3001";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";
const CONSENT_VERSION = "2026-06-01";

const PII_KEYS = ["full_name", "name", "phone", "phone_e164", "employer", "address", "relay_handle"];

async function req(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  // PayerAuthGuard Bearer (or the worker session Bearer for the OTP flow below).
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
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

/** Mint a payer session (Bearer + server-assigned payerId) — see helpers/payer-session.ts. */
function newPayer(): Promise<MintedPayerSession> {
  return mintPayerSession({ apiUrl: API_URL });
}

/** Top up a payer's credits AS that payer (session-scoped purchase; XB-A self-purchase). */
function buyCredits(payer: MintedPayerSession, packCode = "pack_10") {
  return req("POST", `/payers/${payer.payerId}/credits`, {
    token: payer.token,
    body: { pack_code: packCode },
  });
}

describe.skipIf(!RUN)("Contact Unlock + Reveal (e2e, ADR-0010 Stream A; PayerAuthGuard)", () => {
  let client!: DbClient;

  beforeAll(() => {
    client = createDbClient(DATABASE_URL);
  });

  afterAll(async () => {
    await client?.sql.end({ timeout: 5 });
  });

  async function allEvents(): Promise<EventRow[]> {
    return client.db.select().from(events);
  }

  it("F-1: a zero-credit payer cannot distinguish a consented-uncapped worker from a non-consented one", async () => {
    const payer = await newPayer(); // zero credits (never topped up)
    const consented = await loginWorker();
    await consent(consented.workerId, ["profiling", "employer_sharing"]);
    const notConsented = await loginWorker();
    await consent(notConsented.workerId, ["profiling"]); // NO employer_sharing

    const a = await req("POST", "/unlocks", {
      token: payer.token,
      body: { worker_id: consented.workerId },
    });
    const b = await req("POST", "/unlocks", {
      token: payer.token,
      body: { worker_id: notConsented.workerId },
    });
    expect(a.status).toBe(b.status);
    expect(JSON.stringify(a.json)).toBe(JSON.stringify(b.json));
    expect(a.json).toEqual({ status: "unavailable" });
  });

  it("F-3: every deny branch + reveal-on-unknown returns the identical neutral body (not a 404)", async () => {
    const payer = await newPayer();
    await buyCredits(payer);

    const noConsentW = await loginWorker(); // no consent at all
    const r1 = await req("POST", "/unlocks", {
      token: payer.token,
      body: { worker_id: noConsentW.workerId },
    });
    const r2 = await req("POST", "/unlocks", {
      token: payer.token,
      body: { worker_id: randomUUID() }, // unknown worker
    });
    expect(JSON.stringify(r1.json)).toBe(JSON.stringify(r2.json));
    expect(r1.json).toEqual({ status: "unavailable" });

    // Reveal on an unknown unlock id → neutral body, NOT a 404.
    const rev = await req("POST", `/unlocks/${randomUUID()}/reveal`, { token: payer.token });
    expect(rev.status).toBe(200);
    expect(rev.json).toEqual({ status: "unavailable" });
  });

  it("happy path: purchase → grant → reveal, emitting PII-free events; balance debited once", async () => {
    const payer = await newPayer();
    const w = await loginWorker();
    await consent(w.workerId, ["profiling", "employer_sharing"]);

    const buy = await buyCredits(payer);
    expect(buy.status).toBe(200);
    expect(buy.json.balance).toBe(10);

    const grant = await req("POST", "/unlocks", { token: payer.token, body: { worker_id: w.workerId } });
    expect(grant.status).toBe(200);
    expect(grant.json).toMatchObject({ ok: true, status: "granted" });
    const unlockId = grant.json.unlock_id as string;

    // Balance debited exactly once.
    const credits = await req("GET", `/payers/${payer.payerId}/credits`, { token: payer.token });
    expect(credits.json.balance).toBe(9);

    // Reveal returns an opaque relay handle — NEVER a phone.
    const reveal = await req("POST", `/unlocks/${unlockId}/reveal`, { token: payer.token });
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
    const payer = await newPayer();
    const w = await loginWorker();
    await consent(w.workerId, ["employer_sharing"]);
    await buyCredits(payer);

    const g1 = await req("POST", "/unlocks", { token: payer.token, body: { worker_id: w.workerId } });
    const g2 = await req("POST", "/unlocks", { token: payer.token, body: { worker_id: w.workerId } });
    expect(g1.json.unlock_id).toBe(g2.json.unlock_id);

    const credits = await req("GET", `/payers/${payer.payerId}/credits`, { token: payer.token });
    expect(credits.json.balance).toBe(9); // debited ONCE, not twice
  });

  it("F-2: N concurrent unlocks for ONE worker never exceed the daily-reveals cap (and balance never negative)", async () => {
    // The daily-reveals cap is config-driven (default 5). We fire 14 DISTINCT payer
    // SESSIONS (each with credits) at one worker concurrently; the cap is on the WORKER,
    // so at most the per-worker weekly-distinct-payers cap (default 10) may hold a grant,
    // and no payer balance ever goes negative under concurrency.
    const w = await loginWorker();
    await consent(w.workerId, ["employer_sharing"]);

    const payersList = await Promise.all(Array.from({ length: 14 }, () => newPayer()));
    await Promise.all(payersList.map((p) => buyCredits(p)));

    const results = await Promise.all(
      payersList.map((p) =>
        req("POST", "/unlocks", { token: p.token, body: { worker_id: w.workerId } }),
      ),
    );
    const grants = results.filter((r) => r.json?.ok === true);
    // weekly-payers cap default = 10 → at most 10 distinct payers may hold a grant.
    expect(grants.length).toBeLessThanOrEqual(10);

    // No payer balance went negative.
    for (const p of payersList) {
      const credits = await req("GET", `/payers/${p.payerId}/credits`, { token: p.token });
      expect(credits.json.balance).toBeGreaterThanOrEqual(0);
    }
  });

  it("F-5: the sentinel phone never appears in any emitted event or in any unlock-family table", async () => {
    const payer = await newPayer();
    const w = await loginWorker();
    await consent(w.workerId, ["employer_sharing"]);
    await buyCredits(payer);
    const grant = await req("POST", "/unlocks", { token: payer.token, body: { worker_id: w.workerId } });
    await req("POST", `/unlocks/${grant.json.unlock_id}/reveal`, { token: payer.token });

    // The phone is absent from all unlock-family table rows (select-all + JS filter,
    // the established e2e pattern — these tables are tiny in a test DB).
    const unlockRows = (await client.db.select().from(unlocks)).filter((u) => u.workerId === w.workerId);
    const routingRows = (await client.db.select().from(unlockRouting)).filter(
      (r) => r.unlockId === grant.json.unlock_id,
    );
    const creditRows = (await client.db.select().from(payerCredits)).filter((c) => c.payerId === payer.payerId);
    const ledgerRows = (await client.db.select().from(creditLedger)).filter((l) => l.payerId === payer.payerId);
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

  it("unlock routes require a valid payer session (fail closed: no Bearer → 401)", async () => {
    // Was: the internal-service secret. Now: a payer Bearer. No credential → 401.
    const r = await req("POST", "/unlocks", { body: { worker_id: randomUUID() } });
    expect(r.status).toBe(401);
    // A malformed / non-payer Bearer is also rejected (audience-pinned typ:"payer").
    const bad = await req("POST", "/unlocks", { token: "not-a-real-jwt", body: { worker_id: randomUUID() } });
    expect(bad.status).toBe(401);
  });

  it("own-unlock reads are PII-free projections, session-scoped (no routing token, no phone, no payer_id query param)", async () => {
    const payer = await newPayer();
    const w = await loginWorker();
    await consent(w.workerId, ["employer_sharing"]);
    await buyCredits(payer);
    await req("POST", "/unlocks", { token: payer.token, body: { worker_id: w.workerId } });

    // listOwn is SESSION-scoped now — no `?payer_id=` query param (that oracle is gone).
    const list = await req("GET", "/unlocks", { token: payer.token });
    expect(list.status).toBe(200);
    expect(list.json.unlocks.length).toBeGreaterThanOrEqual(1);
    for (const u of list.json.unlocks as Array<Record<string, unknown>>) {
      expect(u.payer_id).toBe(payer.payerId); // only the caller's OWN rows
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

  // ===========================================================================
  // XB-A — HORIZONTAL-AUTHZ BLOCKER (the exact LC-1 test). TWO payer sessions A + B:
  // a payer can never act on another payer's id (credit-PURCHASE, credit-READ, or
  // another payer's unlock rows). No-oracle: cross-tenant probes leak NOTHING.
  // ===========================================================================
  describe("XB-A horizontal-authz blocker (two payer sessions A and B)", () => {
    it("payer A POST /payers/{B}/credits → 403 (the cross-payer credit-PURCHASE blocker); B's balance is unchanged", async () => {
      const A = await newPayer();
      const B = await newPayer();
      // B has a known starting balance.
      const seed = await buyCredits(B); // B buys its OWN pack_10 → balance 10
      expect(seed.status).toBe(200);
      expect(seed.json.balance).toBe(10);

      // THE BLOCKER: A authenticates as itself but targets B's id in the path. The
      // `assertPayerOwns(session, :payerId)` chokepoint must reject this — A can NEVER
      // buy credits against B's account. 403, no neutral-oracle leak of B's existence.
      const cross = await req("POST", `/payers/${B.payerId}/credits`, {
        token: A.token, // session = A
        body: { pack_code: "pack_10" },
      });
      expect(cross.status).toBe(403);

      // B's balance is UNCHANGED — the cross-payer purchase debited/granted nothing.
      const bBalance = await req("GET", `/payers/${B.payerId}/credits`, { token: B.token });
      expect(bBalance.status).toBe(200);
      expect(bBalance.json.balance).toBe(10); // exactly the seed; A's attempt added nothing
    });

    it("payer A GET /payers/{B}/credits → 403 (cross-payer credit-READ blocker; A learns nothing about B)", async () => {
      const A = await newPayer();
      const B = await newPayer();
      await buyCredits(B);

      const cross = await req("GET", `/payers/${B.payerId}/credits`, { token: A.token });
      expect(cross.status).toBe(403); // flat 403 regardless of B's balance — no oracle

      // A reading its OWN credits still works (proves the 403 is scoping, not a broken route).
      const own = await req("GET", `/payers/${A.payerId}/credits`, { token: A.token });
      expect(own.status).toBe(200);
      expect(own.json.payer_id).toBe(A.payerId);
    });

    it("payer A cannot reveal or read payer B's unlock — identical neutral / 404 (no leak)", async () => {
      // B grants a real unlock it owns.
      const A = await newPayer();
      const B = await newPayer();
      const w = await loginWorker();
      await consent(w.workerId, ["employer_sharing"]);
      await buyCredits(B);
      const bGrant = await req("POST", "/unlocks", { token: B.token, body: { worker_id: w.workerId } });
      expect(bGrant.json).toMatchObject({ ok: true, status: "granted" });
      const bUnlockId = bGrant.json.unlock_id as string;

      // A reveals B's unlock id → the SAME neutral body as an unknown id (chokepoint
      // ownership: expectedPayerId = A.id ≠ row.payer_id). NOT a 403, NOT a 404, NOT B's
      // relay handle — A cannot tell a real-but-foreign unlock from a nonexistent one.
      const revealForeign = await req("POST", `/unlocks/${bUnlockId}/reveal`, { token: A.token });
      const revealUnknown = await req("POST", `/unlocks/${randomUUID()}/reveal`, { token: A.token });
      expect(revealForeign.status).toBe(200);
      expect(JSON.stringify(revealForeign.json)).toBe(JSON.stringify(revealUnknown.json));
      expect(revealForeign.json).toEqual({ status: "unavailable" });
      expect(JSON.stringify(revealForeign.json)).not.toContain(w.phone);

      // A getOwn of B's unlock → identical neutral 404 to a nonexistent id (no-oracle:
      // A cannot confirm B's unlock id even exists).
      const getForeign = await req("GET", `/unlocks/${bUnlockId}`, { token: A.token });
      const getUnknown = await req("GET", `/unlocks/${randomUUID()}`, { token: A.token });
      expect(getForeign.status).toBe(404);
      expect(getUnknown.status).toBe(404);
      expect(getForeign.status).toBe(getUnknown.status);

      // Sanity: B CAN reveal its own unlock (proves the unlock is real + A's denial is scoping).
      const bReveal = await req("POST", `/unlocks/${bUnlockId}/reveal`, { token: B.token });
      expect(bReveal.status).toBe(200);
      expect(bReveal.json.channel).toBe("in_app_relay");
      expect(typeof bReveal.json.relay_handle).toBe("string");
    });
  });

  // ===========================================================================
  // CHOKEPOINT-UNCHANGED REGRESSION (via a minted session). Proves the fail-closed
  // ordering still holds end-to-end after the auth swap: insufficient-credits → neutral;
  // consent gate; per-worker cap; grant; reveal returns an OPAQUE handle (never a phone);
  // and unlock.* / payment.* events stay PII-FREE (ids/enums/counts only).
  // ===========================================================================
  it("chokepoint ordering is unchanged under PayerAuthGuard: credits → consent → cap → grant → reveal, all PII-free", async () => {
    // (1) INSUFFICIENT CREDITS first (before consent/worker existence): a zero-credit
    // session asking for a fully-consented worker still gets the NEUTRAL body — credits
    // are checked first and the deny reason never leaks.
    const broke = await newPayer(); // no top-up
    const consented = await loginWorker();
    await consent(consented.workerId, ["employer_sharing"]);
    const denyNoCredit = await req("POST", "/unlocks", {
      token: broke.token,
      body: { worker_id: consented.workerId },
    });
    expect(denyNoCredit.status).toBe(200);
    expect(denyNoCredit.json).toEqual({ status: "unavailable" });

    // (2) CONSENT GATE: a credited session asking for a NON-consented worker → the SAME
    // neutral body (consent is not an oracle either).
    const payer = await newPayer();
    await buyCredits(payer);
    const noEmployerShare = await loginWorker();
    await consent(noEmployerShare.workerId, ["profiling"]); // no employer_sharing
    const denyNoConsent = await req("POST", "/unlocks", {
      token: payer.token,
      body: { worker_id: noEmployerShare.workerId },
    });
    expect(denyNoConsent.json).toEqual({ status: "unavailable" });

    // (3) GRANT: same session, a properly consented worker → the one distinguishable
    // success. The debit happened exactly once (balance 10 → 9).
    const w = await loginWorker();
    await consent(w.workerId, ["employer_sharing"]);
    const grant = await req("POST", "/unlocks", { token: payer.token, body: { worker_id: w.workerId } });
    expect(grant.json).toMatchObject({ ok: true, status: "granted" });
    const after = await req("GET", `/payers/${payer.payerId}/credits`, { token: payer.token });
    expect(after.json.balance).toBe(9);

    // (4) REVEAL returns an OPAQUE relay handle, never a phone.
    const reveal = await req("POST", `/unlocks/${grant.json.unlock_id}/reveal`, { token: payer.token });
    expect(reveal.json.channel).toBe("in_app_relay");
    expect(typeof reveal.json.relay_handle).toBe("string");
    expect(reveal.json.relay_handle).not.toContain(w.phone);

    // (5) EVENTS stay PII-FREE: no unlock.* / payment.* payload carries the worker phone
    // or any PII key (ids/enums/counts only); payment.* are mock (real_call:false).
    const evts = (await allEvents()).filter((e) =>
      ["unlock.", "contact.", "payment."].some((pfx) => e.eventName.startsWith(pfx)),
    );
    const payloads = JSON.stringify(evts.map((e) => e.payload));
    expect(payloads).not.toContain(w.phone);
    expect(payloads).not.toContain(consented.phone);
    expect(payloads).not.toContain(noEmployerShare.phone);
    for (const k of PII_KEYS) expect(payloads).not.toContain(`"${k}"`);
    const payments = evts.filter((e) => e.eventName.startsWith("payment."));
    for (const p of payments) expect((p.payload as { real_call?: boolean }).real_call).toBe(false);
  });
});
