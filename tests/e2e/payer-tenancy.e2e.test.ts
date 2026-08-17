import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "@badabhai/db";
import { randomUUID } from "node:crypto";
import { mintPayerSession } from "./helpers/payer-session";

/**
 * Payer self-serve HORIZONTAL AUTHORIZATION (e2e, ADR-0019 R16 / XB-A) against a LIVE
 * API + DB + Redis. Proves the tenancy guarantee the `apps/payer-web` client relies on:
 * the `/payer/*` surface (PayerAuthGuard) binds every action to the AUTHENTICATED session
 * payer (`req.payer.id`) — a payer sees and acts on ONLY its own unlocks/credits, and can
 * never list, read, or reveal another payer's unlock (no-oracle: an identical neutral body,
 * never a 403/404 that would confirm the other tenant's row exists).
 *
 * This is the cross-payer blocker harvested from the R16 work (#116) and adapted to main's
 * shipped two-surface state: the self-serve actor uses the Bearer `/payer/*` routes; the
 * interim ops `/payers/:payerId/credits` route (InternalServiceGuard) is used ONLY to seed
 * credits against each session's SERVER-ASSIGNED id.
 *
 * BL-18: both principals this suite drives are minted via a TEST-LOGIN SEAM, not OTP.
 * Worker + payer login are both real-only (Fast2SMS / ZeptoMail, no dev-echo), so the old
 * `dev_otp`-reading helpers can no longer complete either login. `loginWorker()` uses the
 * D-3 worker seam (`POST /auth/test-login`, mirrors contact-unlock.e2e.test.ts /
 * phase1-onboarding.e2e.test.ts); payer sessions come from `mintPayerSession()`
 * (`./helpers/payer-session`), which now drives `POST /payer/test-login`.
 *
 * Opt-in (same harness as contact-unlock.e2e.test.ts; payer sessions are Redis-backed):
 *   1. docker compose up -d postgres redis
 *   2. pnpm db:migrate
 *   3. TEST_LOGIN_ENABLED=true TEST_LOGIN_TOKEN=<32+ chars>
 *      PAYER_TEST_LOGIN_ENABLED=true PAYER_TEST_LOGIN_TOKEN=<32+ chars>
 *      INTERNAL_SERVICE_TOKEN=<token> pnpm --filter @badabhai/api start (NODE_ENV=test/dev)
 *   4. RUN_E2E=1 TEST_LOGIN_TOKEN=<same> PAYER_TEST_LOGIN_TOKEN=<same>
 *      INTERNAL_SERVICE_TOKEN=<token> pnpm --filter @badabhai/e2e test
 */

// D-3 worker test-login gate secret (loginWorker) + the payer analogue (mintPayerSession
// reads PAYER_TEST_LOGIN_TOKEN itself). Both must be armed — this suite mints one of each.
const TEST_LOGIN_TOKEN = process.env.TEST_LOGIN_TOKEN ?? "";
const PAYER_TEST_LOGIN_TOKEN = process.env.PAYER_TEST_LOGIN_TOKEN ?? "";
const RUN =
  process.env.RUN_E2E === "1" && TEST_LOGIN_TOKEN.length > 0 && PAYER_TEST_LOGIN_TOKEN.length > 0;
const API_URL = process.env.E2E_API_URL ?? "http://localhost:3001";
const OPS_TOKEN = process.env.INTERNAL_SERVICE_TOKEN ?? "";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";
const CONSENT_VERSION = "2026-06-01";

// Keys that must NEVER surface in a cross-payer (denied) response.
const PII_KEYS = [
  "full_name",
  "name",
  "phone",
  "phone_e164",
  "employer",
  "address",
  "relay_handle",
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
 * A phone in the ONLY range the D-3 mint will serve: `SYNTHETIC_TEST_PHONE_PATTERN`
 * (`/^\+910{5}\d{5}$/`, i.e. `+9100000` + 5 digits) — the reserved, unassignable block.
 * `AuthService.testLogin` refuses anything else, mirrors contact-unlock.e2e.test.ts.
 */
let phoneSeq = Math.floor(Math.random() * 90_000);
function syntheticPhone(): string {
  phoneSeq = (phoneSeq + 1) % 100_000;
  return `+9100000${String(phoneSeq).padStart(5, "0")}`;
}

/**
 * Login a fresh worker via the D-3 test-login mint seam (`POST /auth/test-login`); returns
 * its id + the synthetic phone used. Worker OTP is real-only (Fast2SMS, no `dev_otp` echo),
 * so this is the only way to authenticate a worker in CI — see contact-unlock.e2e.test.ts's
 * `loginWorker` for the full rationale.
 */
async function loginWorker(): Promise<{ workerId: string; token: string; phone: string }> {
  const phone = syntheticPhone();
  const r = await req("POST", "/auth/test-login", { body: { phone }, testLogin: true });
  expect(
    r.status,
    "POST /auth/test-login must be armed for this suite: set TEST_LOGIN_ENABLED=true and a " +
      ">=32-char TEST_LOGIN_TOKEN on BOTH the API process and this test runner",
  ).toBe(200);
  return { workerId: r.json.worker_id as string, token: r.json.access_token as string, phone };
}

async function consent(token: string, purposes: string[]): Promise<void> {
  // `POST /consent/accept` is WORKER-AUTHED: the subject is the SESSION worker,
  // never a body id. Sending `worker_id` would be silently stripped by the DTO.
  const r = await req("POST", "/consent/accept", {
    body: { consent_version: CONSENT_VERSION, purposes },
    token,
  });
  expect(r.status).toBe(201);
}

// BL-18: the OLD blocker (both logins needed a real OTP round-trip) is gone. `loginWorker`
// mints via the D-3 worker test-login seam and `mintPayerSession` mints via the payer
// analogue (`POST /payer/test-login`) — neither touches OTP. Opt-in via `RUN` (RUN_E2E +
// both test-login tokens present); `describe.skipIf` rather than a hard skip so the suite
// runs wherever the seams are armed (CI included) and stays a disclosed, not silent, gap
// everywhere else.
describe.skipIf(!RUN)("Payer self-serve horizontal authz (e2e, ADR-0019 R16 / XB-A)", () => {
  let client!: DbClient;

  beforeAll(() => {
    client = createDbClient(DATABASE_URL);
    expect(OPS_TOKEN, "set INTERNAL_SERVICE_TOKEN to seed credits via the ops route").not.toBe("");
  });

  afterAll(async () => {
    await client?.sql.end({ timeout: 5 });
  });

  it("a payer sees ONLY its own unlocks/credits and cannot list, read, or reveal another payer's unlock", async () => {
    const A = await mintPayerSession({ role: "employer" });
    const B = await mintPayerSession({ role: "employer" });
    expect(A.payerId).not.toBe(B.payerId);

    // Seed credits for BOTH, against their SERVER-ASSIGNED ids (ops route).
    const seedA = await req("POST", `/payers/${A.payerId}/credits`, {
      ops: true,
      body: { pack_code: "pack_10" },
    });
    const seedB = await req("POST", `/payers/${B.payerId}/credits`, {
      ops: true,
      body: { pack_code: "pack_10" },
    });
    expect(seedA.json.balance).toBe(10);
    expect(seedB.json.balance).toBe(10);

    // A worker B will unlock (consented for employer_sharing).
    const w = await loginWorker();
    await consent(w.token, ["profiling", "employer_sharing"]);

    // B unlocks through B's OWN session — no payer_id in the body, identity is the session.
    const bGrant = await req("POST", "/payer/unlocks", {
      token: B.token,
      body: { worker_id: w.workerId },
    });
    expect(bGrant.status).toBe(200);
    expect(bGrant.json).toMatchObject({ ok: true, status: "granted" });
    const bUnlockId = bGrant.json.unlock_id as string;
    expect(bUnlockId).toBeTruthy();

    // Positive control: B can see + reveal its OWN unlock (so the A-denials below are meaningful).
    const bList = await req("GET", "/payer/unlocks", { token: B.token });
    expect(bList.status).toBe(200);
    expect(JSON.stringify(bList.json)).toContain(bUnlockId);
    const bReveal = await req("POST", `/payer/unlocks/${bUnlockId}/reveal`, { token: B.token });
    expect(bReveal.status).toBe(200);
    expect(bReveal.json.channel).toBe("in_app_relay");
    expect(typeof bReveal.json.relay_handle).toBe("string");
    expect(bReveal.json.relay_handle).not.toContain(w.phone);

    // --- TENANCY: A must NOT see or act on B's data ---

    // 1. A's unlock list never contains B's unlock.
    const aList = await req("GET", "/payer/unlocks", { token: A.token });
    expect(aList.status).toBe(200);
    expect(JSON.stringify(aList.json)).not.toContain(bUnlockId);

    // 2. A's credits reflect ONLY A — own id, own (undebited) balance, no leak of B's id.
    const aCredits = await req("GET", "/payer/credits", { token: A.token });
    expect(aCredits.status).toBe(200);
    expect(aCredits.json.payer_id).toBe(A.payerId);
    expect(aCredits.json.balance).toBe(10);
    expect(JSON.stringify(aCredits.json)).not.toContain(B.payerId);

    // 3. A cannot reveal B's unlock — identical NEUTRAL body, no relay_handle, no PII (no-oracle).
    const aReveal = await req("POST", `/payer/unlocks/${bUnlockId}/reveal`, { token: A.token });
    expect(aReveal.status).toBe(200);
    expect(aReveal.json).toEqual({ status: "unavailable" });
    const aRevealStr = JSON.stringify(aReveal.json);
    for (const k of PII_KEYS) expect(aRevealStr).not.toContain(k);
    expect(aRevealStr).not.toContain(w.phone);

    // 4. The debit bound to B (its own reveal/grant), never A.
    const bCredits = await req("GET", "/payer/credits", { token: B.token });
    expect(bCredits.json.payer_id).toBe(B.payerId);
    expect(bCredits.json.balance).toBe(9);
  });

  it("the self-serve unlock surface ignores a forged body payer_id — only the session is charged", async () => {
    const A = await mintPayerSession({ role: "employer" });
    await req("POST", `/payers/${A.payerId}/credits`, {
      ops: true,
      body: { pack_code: "pack_10" },
    });
    const w = await loginWorker();
    await consent(w.token, ["profiling", "employer_sharing"]);

    // A forged `payer_id` in the body must be IGNORED (the DTO carries none; identity is the
    // session). The debit hits A, never the forged victim id.
    const forgedVictim = randomUUID();
    const grant = await req("POST", "/payer/unlocks", {
      token: A.token,
      body: { worker_id: w.workerId, payer_id: forgedVictim },
    });
    expect(grant.status).toBe(200);
    expect(grant.json).toMatchObject({ ok: true, status: "granted" });

    const aCredits = await req("GET", "/payer/credits", { token: A.token });
    expect(aCredits.json.payer_id).toBe(A.payerId);
    expect(aCredits.json.balance).toBe(9);
  });
});
