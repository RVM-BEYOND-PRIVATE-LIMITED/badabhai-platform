#!/usr/bin/env node
// Production POSTURE CANARY — run after P2 (dormant deploy) and after every P4 flag flip.
//
// Zero-dependency: global fetch (Node 22). READ-ONLY and WRITE-FREE by construction —
// every request it makes is either a GET or an intentionally-unauthenticated call it
// EXPECTS to be rejected. It creates no worker, no posting, no payment, and it is safe to
// run against production as often as you like.
//
// WHAT THIS IS NOT. It does not walk the product loop. That loop needs a real OTP to a
// team-held handset and a real card, and `TEST_LOGIN_ENABLED` cannot be armed in
// production (`assertAuthConfig` refuses to boot), so there is no honest way to automate
// it. Pretending to would be worse than useless — it would report PASS on a flow it never
// exercised. The human steps are printed at the end as a checklist, and the runbook's
// "Canary smoke" section is the authority on them.
//
// WHAT IT DOES PROVE, and why it is worth running:
//
//   STAGE 1 — liveness.   GET /health is 200 and reports status "ok" (db + redis up).
//
//   STAGE 2 — THE GUARDS HOLD.  Every ops-internal route is called with NO credential and
//     MUST be rejected. Until 2026-07-31 these were open to the whole internet: an
//     anonymous caller could create a job posting, publish it, mark it "Verified", and put
//     it in real workers' feeds — plus read the entire audit spine. That is now closed in
//     code, and this stage is what proves it stayed closed in the deployed artifact rather
//     than only in the repo. A 200 here is a CRITICAL failure, not a warning.
//
//   STAGE 3 — THE DPDP GATE HOLDS.  POST /consent/accept with no bearer must be rejected.
//     Consent is invariant #6, and it used to accept whatever `worker_id` the body named.
//
//   STAGE 4 (ONLY when PROD_CANARY_OPS_TOKEN is set) — the ops console will actually work.
//     The same routes, WITH the token, must NOT 401. This catches the P0-10 failure mode:
//     the guard fails CLOSED, so a token that is missing or mismatched between the API and
//     apps/web presents as a total ops-console outage. Better to learn that here.
//
// PRIVACY (CLAUDE.md §2): prints route + status code only. It never prints a response
// body, never prints the ops token, and never sends worker data.
//
// Env:
//   PROD_API_BASE_URL       (required)  https:// base URL of the production API
//   PROD_CANARY_OPS_TOKEN   (optional)  the API's INTERNAL_SERVICE_TOKEN; absent =>
//                                       stage 4 is skipped (stages 1-3 still run and are
//                                       the ones that matter for safety)
//
//   node scripts/prod-canary.mjs

import { pathToFileURL } from "node:url";

const BASE_URL_RAW = process.env.PROD_API_BASE_URL;
const OPS_TOKEN = process.env.PROD_CANARY_OPS_TOKEN;

/** Header carrying the shared internal-service secret (mirrors the API guard). */
const OPS_TOKEN_HEADER = "x-internal-service-token";

/**
 * A uuid that does not exist, for routes with a path parameter.
 *
 * DEFENCE IN DEPTH FOR THE FAILURE CASE. These probes only matter when a guard is MISSING —
 * that is the whole point — and in that case the request reaches the handler. A nonexistent
 * id means the handler then 404s instead of acting on a real worker, payer, or posting.
 * Combined with the invalid bodies below, a guard regression is discovered without touching
 * a single production row.
 */
const ABSENT_ID = "00000000-0000-4000-8000-000000000000";

/**
 * EVERY route behind `InternalServiceGuard`, as (method, path[, body]).
 *
 * THIS LIST IS THE CLOSURE CLAIM, and it must stay complete. It was measured against Nest's
 * own route metadata on 2026-07-31 (43 routes) rather than assembled by hand — an earlier
 * version of this file listed 6 and still described itself as the closure claim, which meant
 * the canary reported PASS while 37 guarded routes were never probed at all. An unprobed
 * route is precisely how the original hole survived: nothing was watching it.
 *
 * WRITE ROUTES ARE PROBED TOO, and that is safe precisely BECAUSE the guard rejects them
 * before any handler runs — which is the property under test. If a guard were ever removed,
 * the probe would get past it, which is exactly when we want to find out. To keep that
 * discovery harmless every write body below is deliberately INVALID (`{}` fails the route's
 * Zod schema, which requires real fields), so even in that failure case the request dies in
 * validation rather than creating, mutating, or sending anything.
 */
export const OPS_ROUTES = [
  // ── audit spine + worker/AI reads (the original leak) ──
  ["GET", "/events?limit=1"],
  ["GET", "/workers?limit=1"],
  ["GET", `/workers/${ABSENT_ID}/profile`],
  ["PUT", `/workers/${ABSENT_ID}/name`, {}],
  ["GET", `/workers/${ABSENT_ID}/applications`],
  ["GET", "/ai-jobs?limit=1"],
  ["GET", `/ai-jobs/${ABSENT_ID}`],

  // ── job postings: the create -> publish -> "Verified" chain ──
  ["GET", "/job-postings?limit=1"],
  ["POST", "/job-postings", {}],
  ["GET", `/job-postings/${ABSENT_ID}`],
  ["PATCH", `/job-postings/${ABSENT_ID}`, {}],
  ["POST", `/job-postings/${ABSENT_ID}/verify`, {}],
  ["POST", `/job-postings/${ABSENT_ID}/reject`, {}],
  ["POST", `/job-postings/${ABSENT_ID}/close`, {}],
  ["POST", `/job-postings/${ABSENT_ID}/reach/widen`, {}],
  ["POST", `/job-postings/${ABSENT_ID}/plan`, {}],
  ["POST", `/job-postings/${ABSENT_ID}/boost`, {}],

  // ── ranking / feed reads ──
  ["GET", `/reach/jobs/${ABSENT_ID}/applicants`],
  ["GET", `/reach/workers/${ABSENT_ID}/feed`],
  ["GET", `/jobs/${ABSENT_ID}/applicants`],

  // ── PACE supply-widening (ADR-0021), guarded 2026-08-01 ──
  // `alerts` is the one that was live-and-open: it is NOT covered by `PACE_ENABLED`.
  ["GET", "/pace/alerts"],
  ["POST", `/pace/jobs/${ABSENT_ID}/start`, {}],

  // ── contact unlock + disclosure (the money-and-PII surface) ──
  ["GET", "/unlocks?limit=1"],
  ["POST", "/unlocks", {}],
  ["GET", `/unlocks/${ABSENT_ID}`],
  ["POST", `/unlocks/${ABSENT_ID}/reveal`, {}],
  ["GET", `/payers/${ABSENT_ID}/credits`],
  ["POST", `/payers/${ABSENT_ID}/credits`, {}],
  // #1166 (2026-08-26): `POST /payers/:payerId/capacity` was retired outright (no caller,
  // duplicated the live payer-self `/payer/capacity` route) — do not re-add it here.
  ["GET", "/resume-disclosures?limit=1"],
  ["POST", "/resume-disclosures", {}],

  // ── resume artifacts ──
  ["GET", `/resume/${ABSENT_ID}`],
  // R16 §5.1 — REMOVED. `POST /resume/:id/share` is no longer an InternalServiceGuard route;
  // it is worker-authed and consent-gated, so it belongs to the worker surface rather than the
  // ops one. `canary-coverage.test.ts` derives this list from the guards, so leaving it here
  // would assert an internal route that no longer exists.
  ["POST", `/resume/${ABSENT_ID}/regenerate`, {}],

  // ── pricing (an unauthenticated PUT here repriced the whole catalog) ──
  ["GET", "/pricing/catalog"],
  ["PUT", "/pricing/catalog", {}],
  ["GET", "/pricing/quote"],

  // ── agency KYC ops (financial PII) ──
  ["GET", "/ops/agency-kyc/pending"],
  ["POST", `/ops/agency-kyc/${ABSENT_ID}/verify`, {}],
  ["POST", `/ops/agency-kyc/${ABSENT_ID}/reject`, {}],

  // ── referral bonus ledger + outbound messaging ──
  ["GET", "/referrals/bonus/summary"],
  ["POST", "/referrals/bonus/evaluate", {}],
  ["POST", "/messaging/reengage", {}],

  // ── raw event ingestion ──
  ["POST", "/actions", {}],
  ["POST", "/actions/batch", {}],
];

/**
 * Routes that must reject an UNAUTHENTICATED caller but are not ops-token routes.
 *
 * NOTE this list is hand-maintained and NOTHING enforces it: `canary-coverage.test.ts`
 * diffs `OPS_ROUTES` against the routes carrying `InternalServiceGuard` (:117) and is
 * blind to worker-authed ones. So a worker-data route omitted here is never probed in
 * production and no test complains. Add worker routes that expose per-worker data.
 */
const WORKER_AUTHED_ROUTES = [
  // Invariant #6 — the DPDP consent gate. No bearer => rejected.
  ["POST", "/consent/accept", { consent_version: "0000-00-00", purposes: ["profiling"] }],
  ["GET", "/feed?limit=1"],
  // The worker AI-job poll — the only route by which a worker's ai_jobs rows leave the
  // DB. It is ownership-scoped in the query, so the guard is the ONLY thing standing
  // between an anonymous caller and a job-status read by uuid. An ABSENT id is used so a
  // pass is the guard rejecting, never a 404 that would mask a missing guard.
  ["GET", `/workers/me/ai-jobs/${ABSENT_ID}`],
  // ── Agency SUPPLY-MONEY surface (ADR-0022 Amdt 2, #1129 item 6) — five agent-only routes ──
  //
  // ASSERTS 401/403, NOT 404, AND THAT IS DELIBERATE. `AgencyPayoutsEnabledGuard`'s neutral 404
  // is what an AUTHENTICATED agent sees while AGENCY_PAYOUTS_ENABLED is OFF. This caller is
  // anonymous, and PayerAuthGuard runs FIRST in the @UseGuards array, so it rejects before the
  // flag gate is ever consulted.
  //
  // That makes these probes FLAG-INDEPENDENT: they read the same before and after any flip, so
  // they encode no temporary state anybody has to remember to update. A canary asserting 404
  // here would have to be rewritten on the day the flag flips — which is the day you least want
  // to be editing the thing that watches it.
  //
  // Worth probing precisely because this is financial PII (PAN + bank) plus a money ledger: if
  // these ever answered an anonymous caller, the submit body is a raw-PAN write sink. They live
  // here rather than in OPS_ROUTES because that list asserts every entry sits behind
  // InternalServiceGuard, and these do not.
  //
  // The `{}` bodies follow this file's existing rule: deliberately invalid, so even in the
  // failure case the request dies in validation rather than writing a KYC row.
  ["POST", "/payer/agency/kyc", {}],
  ["GET", "/payer/agency/kyc"],
  ["GET", "/payer/agency/earnings"],
  ["POST", "/payer/agency/payouts", {}],
  ["GET", "/payer/agency/payouts"],
];

/** An auth failure. 401 and 403 are both "the guard rejected me" and both pass. */
const REJECTED = new Set([401, 403]);

class CanaryFailure extends Error {}

function fail(msg) {
  throw new CanaryFailure(msg);
}

/** Trim a single trailing slash so `${base}/health` never doubles up. */
function normalizeBase(u) {
  return u.replace(/\/+$/, "");
}

/**
 * TLS gate for stage 4 (mirrors staging-smoke). The ops token rides a header, so an
 * `http://` base would put a PRODUCTION secret on the wire in plaintext. Loopback is
 * exempt (no network hop) so the script stays runnable locally.
 */
function assertTransportSafeForSecrets(base) {
  let url;
  try {
    url = new URL(base);
  } catch {
    fail(`PROD_API_BASE_URL is not a valid URL: ${base}`);
  }
  if (url.protocol === "https:") return;
  const host = url.hostname;
  if (
    url.protocol === "http:" &&
    (host === "localhost" || host === "127.0.0.1" || host === "::1")
  ) {
    return;
  }
  fail(
    `refusing to send the ops token over ${url.protocol}// to a non-loopback host — the ` +
      "PRODUCTION secret would travel in PLAINTEXT. Use an https:// PROD_API_BASE_URL, or " +
      "unset PROD_CANARY_OPS_TOKEN to run stages 1-3 only.",
  );
}

async function call(base, method, path, body, token) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers[OPS_TOKEN_HEADER] = token;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res;
}

async function main() {
  if (!BASE_URL_RAW || !BASE_URL_RAW.trim()) {
    fail("PROD_API_BASE_URL is not set (the public HTTPS URL of the production API).");
  }
  const base = normalizeBase(BASE_URL_RAW.trim());
  const opsStage = Boolean(OPS_TOKEN && OPS_TOKEN.trim());
  if (opsStage) assertTransportSafeForSecrets(base);

  console.log("[prod-canary] START");
  console.log(`[prod-canary]   target : ${base}`);
  console.log(
    `[prod-canary]   stages : health + guards + consent${
      opsStage
        ? " + ops-token reachability"
        : " (ops-token stage SKIPPED — PROD_CANARY_OPS_TOKEN not set)"
    }`,
  );

  // ── STAGE 1 — liveness ────────────────────────────────────────────────────
  const health = await call(base, "GET", "/health");
  if (health.status !== 200) fail(`GET /health -> ${health.status} (expected 200)`);
  const healthBody = await health.json().catch(() => ({}));
  if (healthBody.status !== "ok") {
    fail(`GET /health reported status="${healthBody.status}" (expected "ok")`);
  }
  console.log("[prod-canary] PASS  stage 1 — /health 200 ok (db + redis reachable)");

  // ── STAGE 2 — the ops guards hold ─────────────────────────────────────────
  const leaks = [];
  for (const [method, path, body] of OPS_ROUTES) {
    const res = await call(base, method, path, body);
    if (!REJECTED.has(res.status)) leaks.push(`${method} ${path} -> ${res.status}`);
    console.log(
      `[prod-canary]   ${REJECTED.has(res.status) ? "ok  " : "LEAK"} ${method} ${path} -> ${res.status}`,
    );
  }
  if (leaks.length > 0) {
    fail(
      `CRITICAL — ${leaks.length} ops route(s) answered an UNAUTHENTICATED caller:\n  ` +
        leaks.join("\n  ") +
        "\nThe ops API is exposed to the internet. Anyone can read the audit spine and " +
        "publish a VERIFIED job posting into workers' feeds. Stop the release.",
    );
  }
  console.log(
    `[prod-canary] PASS  stage 2 — all ${OPS_ROUTES.length} ops routes reject an anonymous caller`,
  );

  // ── STAGE 3 — the DPDP consent gate holds ─────────────────────────────────
  const gateLeaks = [];
  for (const [method, path, body] of WORKER_AUTHED_ROUTES) {
    const res = await call(base, method, path, body);
    if (!REJECTED.has(res.status)) gateLeaks.push(`${method} ${path} -> ${res.status}`);
    console.log(
      `[prod-canary]   ${REJECTED.has(res.status) ? "ok  " : "LEAK"} ${method} ${path} -> ${res.status}`,
    );
  }
  if (gateLeaks.length > 0) {
    fail(
      `CRITICAL — worker-authed route(s) answered an UNAUTHENTICATED caller:\n  ` +
        gateLeaks.join("\n  ") +
        "\nIf /consent/accept is among them, the DPDP gate (invariant #6) is forgeable. Stop.",
    );
  }
  console.log(
    `[prod-canary] PASS  stage 3 — all ${WORKER_AUTHED_ROUTES.length} worker-authed routes reject an anonymous caller`,
  );

  // ── STAGE 4 — the ops console can actually reach the API ──────────────────
  if (opsStage) {
    const blocked = [];
    for (const [method, path, body] of OPS_ROUTES) {
      if (method !== "GET") continue; // never send a write, even a rejected one, with a real token
      const res = await call(base, method, path, body, OPS_TOKEN.trim());
      if (REJECTED.has(res.status)) blocked.push(`${method} ${path} -> ${res.status}`);
      console.log(
        `[prod-canary]   ${REJECTED.has(res.status) ? "FAIL" : "ok  "} ${method} ${path} -> ${res.status}`,
      );
    }
    if (blocked.length > 0) {
      fail(
        `the ops token was REJECTED on:\n  ` +
          blocked.join("\n  ") +
          "\nThe guard fails closed, so this is what a missing or mismatched " +
          "INTERNAL_SERVICE_TOKEN looks like (runbook P0-10). The ops console is dead " +
          "until the API and apps/web hold the SAME value.",
      );
    }
    console.log("[prod-canary] PASS  stage 4 — the ops token is accepted (console will work)");
  }

  console.log("");
  console.log("[prod-canary] AUTOMATED CHECKS PASSED");
  console.log("");
  console.log("Still to do BY HAND — this script cannot do these, and they are the ones that");
  console.log("prove the product works (runbook: 'Canary smoke'):");
  console.log("  1. Worker : OTP -> consent -> chat -> extraction -> resume ready");
  console.log("  2. Voice  : record -> transcript -> 'Yeh theek hai?' -> merged into chat");
  console.log("  3. LOOP   : payer signs up -> 50 free credits -> posts a job -> related");
  console.log("              skills pre-ticked with a live reach count -> publish ->");
  console.log("              THE CANARY WORKER SEES IT IN /feed -> applies -> payer sees the");
  console.log("              ranked list with the related badge -> unlocks -> credit");
  console.log("              decrements -> drain to zero -> payer.credits_exhausted observed");
  console.log("  4. Payment: smallest pack on a real card -> ledger row + payment.captured");
  console.log("");
  console.log("Step 3 is the one that matters. It is the first time in this product's life");
  console.log("that a payer-posted job reaches a worker. If it fails, flip MATCH_V1_ENABLED");
  console.log("back and stop — nothing downstream is worth debugging until the loop closes.");
}

/**
 * Run ONLY when executed directly (`node scripts/prod-canary.mjs`), never on import.
 *
 * `OPS_ROUTES` is exported so a test can assert it still covers every route behind
 * `InternalServiceGuard` — the drift guard that stops this list silently falling behind the
 * API again. Without this check, importing the module to read that list would fire a live
 * canary run against whatever `PROD_API_BASE_URL` happened to be set to.
 */
// pathToFileURL, NOT a hand-built `file://${argv[1]}`: on Windows argv[1] is
// `C:\...\prod-canary.mjs`, which string-concatenates to `file://C:\...` and never equals
// import.meta.url's `file:///C:/.../prod-canary.mjs`. That mismatch would make the canary a
// silent no-op that exits 0 — a release-gate script reporting success without running.
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((err) => {
    if (err instanceof CanaryFailure) {
      console.error(`[prod-canary] FAIL: ${err.message}`);
    } else {
      console.error(`[prod-canary] ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
  });
}
