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

/**
 * ADR-0053 (PAY-DB-01) T0-HTTP — "A invites B; B sees A's postings + credits", over live HTTP,
 * through the real guards. The e2e job runs the api with PAYER_ORG_TENANCY_MODE=on.
 *
 * B's membership is SEEDED through this suite's DB client rather than by the accept route: the
 * invite mailer is the MOCK in CI, and it never lets the raw accept token leave the api process
 * (only its hash is stored). The seeded row is exactly what a successful accept writes — an
 * `active` recruiter row in A's org bound to B's payer id, with B's own encrypted email.
 *
 * THE TEAM STORY IS `it.fails` — RED BY DESIGN IN PHASE 1. P1 ships the resolver but no tenant
 * predicate, so every posting / credit / unlock read is still keyed by the caller and B sees none
 * of A's rows. Flip it to `it` in the PR that lands the second of P2a and P2b.
 *
 * It cannot pass for the wrong reason: the ordinary `it`s before it prove the seeded membership
 * resolves (B's `GET /payer/me` reports A's org as recruiter), that every route the story calls
 * answers 200 for B, and that the same calls made by A see A's posting and credits. The story's
 * first assertion is the tenancy one.
 */
describe.skipIf(!RUN)(
  "Payer ORG tenancy — A invites B; B sees A's postings + credits (e2e, ADR-0053 T0-HTTP)",
  () => {
    let client!: DbClient;
    let A!: Awaited<ReturnType<typeof mintPayerSession>>;
    let B!: Awaited<ReturnType<typeof mintPayerSession>>;
    let orgOfA = "";
    let memberIdOfB = "";
    let postingOfA = "";

    beforeAll(async () => {
      client = createDbClient(DATABASE_URL);
      expect(OPS_TOKEN, "set INTERNAL_SERVICE_TOKEN to seed credits via the ops route").not.toBe(
        "",
      );

      A = await mintPayerSession({ role: "employer" });
      B = await mintPayerSession({ role: "employer" });
      expect(A.payerId).not.toBe(B.payerId);

      // A's solo org (test-login founds it, as signup does).
      const [org] = await client.sql`
      SELECT id FROM payer_orgs WHERE root_payer_id = ${A.payerId}::uuid`;
      orgOfA = String(org?.id ?? "");
      expect(orgOfA, "A has no solo org after test-login").not.toBe("");

      // What a successful accept writes: B, active recruiter in A's org (see the block comment).
      const [member] = await client.sql`
      INSERT INTO payer_members (org_id, member_payer_id, email_enc, email_hash, org_role, status,
                                 invited_by, invited_at, accepted_at)
      SELECT ${orgOfA}::uuid, b.id, b.email_enc, b.email_hash, 'recruiter', 'active',
             ${A.payerId}::uuid, now(), now()
      FROM payers b WHERE b.id = ${B.payerId}::uuid
      RETURNING id`;
      memberIdOfB = String(member?.id ?? "");
      expect(memberIdOfB).not.toBe("");

      // A posts a job and gets credits.
      const created = await req("POST", "/payer/job-postings", {
        token: A.token,
        body: { org_label: "E2E Tenancy Works", role_title: "CNC Turner", vacancy_band: "1" },
      });
      expect(created.status).toBe(201);
      postingOfA = created.json.id as string;
      const seeded = await req("POST", `/payers/${A.payerId}/credits`, {
        ops: true,
        body: { pack_code: "pack_10" },
      });
      expect(seeded.json.balance).toBe(10);
    });

    afterAll(async () => {
      await client?.sql.end({ timeout: 5 });
    });

    it("setup: the seeded membership resolves — B's GET /payer/me reports A's org, as recruiter", async () => {
      const me = await req("GET", "/payer/me", { token: B.token });
      expect(me.status).toBe(200);
      expect(me.json).toMatchObject({ id: B.payerId, orgId: orgOfA, orgRole: "recruiter" });
    });

    it("setup: every route the story calls answers 200 for B (so the story can only fail on content)", async () => {
      for (const path of ["/payer/job-postings", "/payer/credits", "/payer/unlocks"]) {
        expect((await req("GET", path, { token: B.token })).status, path).toBe(200);
      }
    });

    it("control: A, through the same routes, sees A's posting and A's credits", async () => {
      const list = await req("GET", "/payer/job-postings", { token: A.token });
      expect(list.status).toBe(200);
      expect((list.json as { id: string }[]).map((p) => p.id)).toContain(postingOfA);
      const credits = await req("GET", "/payer/credits", { token: A.token });
      expect(credits.json.balance).toBe(10);
    });

    // RED IN PHASE 1 (ADR-0053 / ORG_TENANCY_PLAN §2.5). Flip to `it` with the second of P2a/P2b.
    it.fails(
      "T0-HTTP: B lists A's posting, reads A's wallet, spends it on an unlock A can see — and removal ends it",
      async () => {
        // 1. B lists postings and finds A's. ← THE FIRST TENANCY ASSERTION (fails in P1).
        const listB = await req("GET", "/payer/job-postings", { token: B.token });
        expect((listB.json as { id: string }[]).map((p) => p.id)).toContain(postingOfA);

        // 2. B reads the org wallet (A's balance). `payer_id` echoes the caller (ADR-0053 §10).
        const walletBefore = (await req("GET", "/payer/credits", { token: A.token })).json.balance;
        const creditsB = await req("GET", "/payer/credits", { token: B.token });
        expect(creditsB.json).toMatchObject({ payer_id: B.payerId, balance: walletBefore });

        // 3. B unlocks a worker: A's wallet pays, and A sees the unlock.
        const w = await loginWorker();
        await consent(w.token, ["profiling", "employer_sharing"]);
        const grant = await req("POST", "/payer/unlocks", {
          token: B.token,
          body: { worker_id: w.workerId },
        });
        expect(grant.json).toMatchObject({ ok: true, status: "granted" });
        expect((await req("GET", "/payer/credits", { token: A.token })).json.balance).toBe(
          walletBefore - 1,
        );
        const listA = await req("GET", "/payer/unlocks", { token: A.token });
        expect(JSON.stringify(listA.json)).toContain(grant.json.unlock_id as string);

        // 4. A removes B; on the next request B sees none of A's rows.
        const removed = await req("DELETE", `/payer/org/members/${memberIdOfB}`, {
          token: A.token,
        });
        expect(removed.status).toBe(200);
        const after = await req("GET", "/payer/job-postings", { token: B.token });
        expect((after.json as { id: string }[]).map((p) => p.id)).not.toContain(postingOfA);
        expect((await req("GET", "/payer/credits", { token: B.token })).json.balance).toBe(0);
      },
    );
  },
);

/**
 * ADR-0053 (PAY-DB-01) P2a — T2 over live HTTP and the real guards: company postings, the
 * per-posting applicant list and the Candidates inbox are the ORG's. Needs the api in
 * PAYER_ORG_TENANCY_MODE=on, which the CI `e2e` job sets for the api and this runner alike; the
 * block refuses to run against anything else rather than pass or skip vacuously.
 *
 * A anchors a team, B is A's active recruiter (seeded exactly as T0-HTTP seeds it), C is an
 * outsider. One worker applies to A's posting (the application row is seeded through the suite's
 * DB client, as the applicant-list suites do). Agency jobs are covered against Postgres in
 * `payer-org-tenancy.db.test.ts`: the payer test-login seam mints employers only.
 */
describe.skipIf(!RUN)(
  "Payer ORG tenancy P2a — postings, applicant list and inbox are the org's over HTTP (e2e, ADR-0053 T2)",
  () => {
    let client!: DbClient;
    let A!: Awaited<ReturnType<typeof mintPayerSession>>;
    let B!: Awaited<ReturnType<typeof mintPayerSession>>;
    let C!: Awaited<ReturnType<typeof mintPayerSession>>;
    let posting = "";
    let workerId = "";

    beforeAll(async () => {
      expect(
        process.env.PAYER_ORG_TENANCY_MODE,
        "this block asserts org tenancy: run the api AND this runner with PAYER_ORG_TENANCY_MODE=on",
      ).toBe("on");
      client = createDbClient(DATABASE_URL);
      A = await mintPayerSession({ role: "employer" });
      B = await mintPayerSession({ role: "employer" });
      C = await mintPayerSession({ role: "employer" });
      const [org] = await client.sql`
      SELECT id FROM payer_orgs WHERE root_payer_id = ${A.payerId}::uuid`;
      expect(org?.id, "A has no solo org after test-login").toBeTruthy();
      await client.sql`
      INSERT INTO payer_members (org_id, member_payer_id, email_enc, email_hash, org_role, status,
                                 invited_by, invited_at, accepted_at)
      SELECT ${String(org!.id)}::uuid, b.id, b.email_enc, b.email_hash, 'recruiter', 'active',
             ${A.payerId}::uuid, now(), now()
      FROM payers b WHERE b.id = ${B.payerId}::uuid`;

      const created = await req("POST", "/payer/job-postings", {
        token: A.token,
        body: { org_label: "E2E Tenancy Works", role_title: "CNC Turner", vacancy_band: "1" },
      });
      expect(created.status).toBe(201);
      posting = created.json.id as string;

      const w = await loginWorker();
      workerId = w.workerId;
      await client.sql`
      INSERT INTO applications (id, worker_id, job_posting_id, action, source_surface, match_tier,
                                engine_version)
      VALUES (gen_random_uuid(), ${workerId}::uuid, ${posting}::uuid, 'applied', 'feed', 1, 'v1.0')`;
    });

    afterAll(async () => {
      await client?.sql.end({ timeout: 5 });
    });

    it("postings: B lists and reads A's posting; C's list lacks it and C's read is the unknown-id 404", async () => {
      const listB = await req("GET", "/payer/job-postings", { token: B.token });
      expect(listB.status).toBe(200);
      expect((listB.json as { id: string }[]).map((p) => p.id)).toContain(posting);
      const getB = await req("GET", `/payer/job-postings/${posting}`, { token: B.token });
      expect(getB.status).toBe(200);
      expect(getB.json).toMatchObject({ id: posting, payer_id: A.payerId });

      const listC = await req("GET", "/payer/job-postings", { token: C.token });
      expect((listC.json as { id: string }[]).map((p) => p.id)).not.toContain(posting);
      const foreign = await req("GET", `/payer/job-postings/${posting}`, { token: C.token });
      const unknown = await req("GET", `/payer/job-postings/${randomUUID()}`, { token: C.token });
      expect(foreign.status).toBe(404);
      expect(foreign.json?.error ?? foreign.json).toEqual(unknown.json?.error ?? unknown.json);
    });

    it("postings: B's edit lands on A's posting; C's edit is the unknown-id 404 and changes nothing", async () => {
      const edit = await req("PATCH", `/payer/job-postings/${posting}`, {
        token: B.token,
        body: { role_title: "VMC Operator" },
      });
      expect(edit.status).toBe(200);
      expect(edit.json).toMatchObject({ role_title: "VMC Operator", payer_id: A.payerId });
      const foreign = await req("PATCH", `/payer/job-postings/${posting}`, {
        token: C.token,
        body: { role_title: "Fitter" },
      });
      const unknown = await req("PATCH", `/payer/job-postings/${randomUUID()}`, {
        token: C.token,
        body: { role_title: "Fitter" },
      });
      expect(foreign.status).toBe(404);
      expect(foreign.json?.error ?? foreign.json).toEqual(unknown.json?.error ?? unknown.json);
      const read = await req("GET", `/payer/job-postings/${posting}`, { token: A.token });
      expect(read.json.role_title).toBe("VMC Operator");
    });

    it("postings: B's create is the org's — A lists it; payer_id is A, created_by is B", async () => {
      const created = await req("POST", "/payer/job-postings", {
        token: B.token,
        body: { org_label: "E2E Tenancy Works", role_title: "Fitter", vacancy_band: "1" },
      });
      expect(created.status).toBe(201);
      expect(created.json).toMatchObject({ payer_id: A.payerId, created_by: B.payerId });
      const listA = await req("GET", "/payer/job-postings", { token: A.token });
      expect((listA.json as { id: string }[]).map((p) => p.id)).toContain(created.json.id);
    });

    it("applicant list: B's list for A's posting is A's; C's is the unknown-id 404", async () => {
      const asA = await req("GET", `/payer/reach/jobs/${posting}/applicants`, { token: A.token });
      expect(asA.status).toBe(200);
      expect((asA.json.applicants as { workerId: string }[]).map((r) => r.workerId)).toEqual([
        workerId,
      ]);
      const asB = await req("GET", `/payer/reach/jobs/${posting}/applicants`, { token: B.token });
      expect(asB.status).toBe(200);
      expect(asB.json).toEqual(asA.json);
      const foreign = await req("GET", `/payer/reach/jobs/${posting}/applicants`, {
        token: C.token,
      });
      const unknown = await req("GET", `/payer/reach/jobs/${randomUUID()}/applicants`, {
        token: C.token,
      });
      expect(foreign.status).toBe(404);
      expect(foreign.json?.error ?? foreign.json).toEqual(unknown.json?.error ?? unknown.json);
    });

    it("Candidates inbox: B's inbox is A's; C's is empty", async () => {
      const asA = await req("GET", "/payer/reach/applicants", { token: A.token });
      expect(asA.status).toBe(200);
      expect((asA.json.applicants as { workerId: string }[]).map((r) => r.workerId)).toEqual([
        workerId,
      ]);
      const asB = await req("GET", "/payer/reach/applicants", { token: B.token });
      expect(asB.json).toEqual(asA.json);
      const asC = await req("GET", "/payer/reach/applicants", { token: C.token });
      expect(asC.json).toMatchObject({ applicants: [], nextCursor: null });
    });
  },
);
