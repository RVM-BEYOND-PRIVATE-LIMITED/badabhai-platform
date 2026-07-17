#!/usr/bin/env node
// Persistent-staging smoke — D-3 rewrite (health + optional gated authed stage).
//
// Zero-dependency: global fetch (Node 22). The old smoke asserted a `dev_otp`
// echo that PROVED SMS_PROVIDER=console — a posture the config now FORBIDS
// (`SMS_PROVIDER: z.literal("fast2sms")` — console fails Zod parse at boot), so
// that assertion could never pass again (drift register D-3). This rewrite:
//
//   STAGE 1 (always)
//     (a) GET /health -> 200 + body.status === "ok"   (proves db+redis up: /health
//         503s with checks:{database,redis} when a dependency is down)
//
//   STAGE 2 (ONLY when SMOKE_TEST_LOGIN_TOKEN is provided in the env)
//     (b) POST /auth/test-login  (x-test-login-token header, {phone} body)
//           -> 200 + access_token present
//         The D-3 GATED test-login mint seam: TEST_LOGIN_ENABLED +
//         TEST_LOGIN_TOKEN on the API (staging may arm them; production CANNOT —
//         assertAuthConfig refuses to boot). While the seam is disabled the route
//         404s; a wrong token 401s — both FAIL this stage loudly.
//     (c) GET /auth/me (Bearer) -> 200 + worker_id present
//         One cheap authed read proving the minted session actually resolves.
//
// Stage 2 implicitly proves REDIS_URL end-to-end too (the per-IP cap + session
// store live in Redis and fail closed).
//
// PRIVACY (CLAUDE.md §2): uses a SYNTHETIC reserved phone; NEVER prints the phone
// (fully masked), NEVER prints the gate token or the access token. Output is a
// clean PASS/FAIL summary only.
//
// Env:
//   STAGING_API_BASE_URL    (required)  e.g. https://staging-api.example
//   SMOKE_TEST_LOGIN_TOKEN  (optional)  the API's TEST_LOGIN_TOKEN; absent =>
//                                       health-only smoke (stage 2 skipped)
//   STAGING_SMOKE_PHONE     (optional)  default a clearly-synthetic reserved number

const BASE_URL_RAW = process.env.STAGING_API_BASE_URL;
const TEST_LOGIN_TOKEN = process.env.SMOKE_TEST_LOGIN_TOKEN;
// A clearly-synthetic, reserved E.164 test number (all-zero subscriber part).
// Never a real worker — staging is SYNTHETIC-DATA-ONLY.
const PHONE = process.env.STAGING_SMOKE_PHONE || "+910000000000";

/** Mask a phone for logs — NEVER reveal subscriber digits. The env is synthetic-only,
 *  but an operator override of STAGING_SMOKE_PHONE must not leak even the last 4. */
function maskPhone(p) {
  const digits = String(p).replace(/\D/g, "");
  return `+${"•".repeat(digits.length)}`;
}

/** A smoke assertion failed — thrown (never process.exit mid-flight: a hard exit
 *  while undici keep-alive sockets are closing aborts Node on Windows instead of
 *  exiting 1). The single catch at the bottom prints + sets exitCode. */
class SmokeFailure extends Error {}

function fail(msg) {
  throw new SmokeFailure(msg);
}

/** Trim a single trailing slash so `${base}/health` never doubles up. */
function normalizeBase(u) {
  return u.replace(/\/+$/, "");
}

async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    // Surface a short, NON-secret hint about the body shape (status code only).
    throw new Error(`expected JSON but got non-JSON body (HTTP ${res.status})`);
  }
}

async function main() {
  if (!BASE_URL_RAW || !BASE_URL_RAW.trim()) {
    fail("STAGING_API_BASE_URL is not set (the public HTTPS URL of the staging API).");
  }
  const base = normalizeBase(BASE_URL_RAW.trim());
  const authedStage = Boolean(TEST_LOGIN_TOKEN && TEST_LOGIN_TOKEN.trim());

  console.log("[staging-smoke] START");
  console.log(`[staging-smoke]   target : ${base}`);
  console.log(
    `[staging-smoke]   stages : health${authedStage ? " + test-login (gated authed stage)" : " ONLY (SMOKE_TEST_LOGIN_TOKEN not set — authed stage skipped)"}`,
  );
  if (authedStage) {
    console.log(`[staging-smoke]   phone  : ${maskPhone(PHONE)} (synthetic)`);
  }

  // ---- STAGE 1 ----
  // (a) GET /health -> 200 + status ok. /health is a real readiness check: it 503s with a
  // checks:{database,redis} body when a dependency is down. Read the body FIRST so a 503 can
  // surface WHICH dep failed (checks carries only up/down — no PII/secret).
  let health;
  try {
    health = await fetch(`${base}/health`, { method: "GET" });
  } catch (e) {
    fail(`GET /health request errored (is the API reachable?): ${e.message}`);
  }
  const healthBody = await readJson(health).catch(() => ({}));
  if (health.status !== 200) {
    const checks = healthBody.checks ? ` checks=${JSON.stringify(healthBody.checks)}` : "";
    fail(`GET /health expected 200, got ${health.status}.${checks} (a dependency is down).`);
  }
  if (healthBody.status !== "ok") {
    fail(`GET /health body.status expected "ok", got ${JSON.stringify(healthBody.status)}.`);
  }
  console.log(
    `[staging-smoke]   (a) /health           OK   (db+redis up; environment=${healthBody.environment})`,
  );

  if (!authedStage) {
    console.log(
      "\n[staging-smoke] PASS — /health ok (health-only; set SMOKE_TEST_LOGIN_TOKEN to run the gated authed stage).",
    );
    return;
  }

  // ---- STAGE 2 (gated) ----
  // (b) POST /auth/test-login -> 200 + access_token present. The gate secret rides the
  // header ONLY — never the body, never the logs. A 404 means TEST_LOGIN_ENABLED is off
  // on the target; a 401 means the token mismatches — both are loud, actionable fails.
  let loginRes;
  try {
    loginRes = await fetch(`${base}/auth/test-login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-login-token": TEST_LOGIN_TOKEN.trim(),
      },
      body: JSON.stringify({ phone: PHONE }),
    });
  } catch (e) {
    fail(`POST /auth/test-login request errored: ${e.message}`);
  }
  // Consume the body BEFORE any fail(): exiting with an unconsumed fetch stream
  // aborts Node on Windows (undici) instead of exiting 1. The error body is never
  // printed — the status code alone is the diagnostic.
  const loginBody = await readJson(loginRes).catch((e) => fail(`POST /auth/test-login: ${e.message}`));
  if (loginRes.status !== 200) {
    fail(
      `POST /auth/test-login expected 200, got ${loginRes.status}. ` +
        "404 = TEST_LOGIN_ENABLED is off on the target env; 401 = SMOKE_TEST_LOGIN_TOKEN does not match the API's TEST_LOGIN_TOKEN; 429 = the per-IP cap tripped or Redis is down (fails closed).",
    );
  }
  const token = loginBody.access_token;
  if (!token) {
    fail("POST /auth/test-login returned no access_token.");
  }
  // NEVER print the token — only confirm its presence + the safe, non-secret fields.
  console.log(
    `[staging-smoke]   (b) /auth/test-login   OK   (access_token present; is_new_worker=${loginBody.is_new_worker})`,
  );

  // (c) GET /auth/me (Bearer) -> 200 + worker_id present — one cheap authed read
  // proving the minted session resolves through WorkerAuthGuard + Redis.
  let meRes;
  try {
    meRes = await fetch(`${base}/auth/me`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (e) {
    fail(`GET /auth/me request errored: ${e.message}`);
  }
  // Same body-before-fail ordering as above (no unconsumed stream on exit).
  const meBody = await readJson(meRes).catch((e) => fail(`GET /auth/me: ${e.message}`));
  if (meRes.status !== 200) {
    fail(`GET /auth/me expected 200, got ${meRes.status}.`);
  }
  if (!meBody.worker_id) {
    fail("GET /auth/me returned no worker_id (the Bearer session did not resolve).");
  }
  console.log(`[staging-smoke]   (c) /auth/me           OK   (status=${meBody.status})`);

  console.log(
    "\n[staging-smoke] PASS — /health ok + gated test-login mint + authed read succeeded.",
  );
}

main().catch((e) => {
  console.error(`\n[staging-smoke] FAIL — ${e?.message ?? String(e)}`);
  // exitCode (not process.exit): let the event loop drain so pending socket
  // handles close cleanly — a hard exit here aborts Node on Windows (libuv).
  process.exitCode = 1;
});
