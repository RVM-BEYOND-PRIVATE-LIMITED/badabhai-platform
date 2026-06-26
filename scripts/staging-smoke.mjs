#!/usr/bin/env node
// Persistent-staging /health + mock-OTP smoke (BLOCKER #1).
//
// Zero-dependency: global fetch (Node 22). Proves a freshly-deployed persistent
// staging API is BOTH reachable AND in mock-OTP ("Mode A") posture, end-to-end:
//
//   (a) GET  /health             -> 200 + body.status === "ok"
//   (b) POST /auth/otp/request   -> 200 + dev_otp present  (PROVES SMS_PROVIDER=console)
//   (c) POST /auth/otp/verify    -> 200 + access_token present
//   (d) GET  /auth/me  (Bearer)  -> 200 + worker_id present
//
// The presence of `dev_otp` in (b) is the load-bearing assertion: that field is
// echoed ONLY when SMS_PROVIDER=console (apps/api/src/auth/auth.dto.ts). If it is
// absent the env is NOT in mock-OTP mode (a real provider is wired, or
// NODE_ENV/SMS_PROVIDER drifted) and we FAIL loudly.
//
// Steps (b)-(d) also implicitly prove REDIS_URL is wired: OTP issuance/verify use
// Redis (per-IP cap + HMAC code store); a Redis outage fails closed (429/503), so
// a green smoke means Redis is reachable too.
//
// PRIVACY (CLAUDE.md §2): uses a SYNTHETIC reserved phone; NEVER prints the phone
// in full (masked to last-4), NEVER prints dev_otp or the access_token. Output is
// a clean PASS/FAIL summary only.
//
// Env:
//   STAGING_API_BASE_URL  (required)  e.g. https://staging-api.example
//   STAGING_SMOKE_PHONE   (optional)  default a clearly-synthetic reserved number

const BASE_URL_RAW = process.env.STAGING_API_BASE_URL;
// A clearly-synthetic, reserved E.164 test number (all-zero subscriber part).
// Never a real worker — Mode A staging is SYNTHETIC-DATA-ONLY.
const PHONE = process.env.STAGING_SMOKE_PHONE || "+910000000000";

/** Mask a phone for logs — NEVER reveal subscriber digits. The env is synthetic-only,
 *  but an operator override of STAGING_SMOKE_PHONE must not leak even the last 4. */
function maskPhone(p) {
  const digits = String(p).replace(/\D/g, "");
  return `+${"•".repeat(digits.length)}`;
}

function fail(msg) {
  console.error(`\n[staging-smoke] FAIL — ${msg}`);
  process.exit(1);
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

  console.log("[staging-smoke] START");
  console.log(`[staging-smoke]   target : ${base}`);
  console.log(`[staging-smoke]   phone  : ${maskPhone(PHONE)} (synthetic)`);

  // (a) GET /health -> 200 + status ok
  let health;
  try {
    health = await fetch(`${base}/health`, { method: "GET" });
  } catch (e) {
    fail(`GET /health request errored (is the API reachable?): ${e.message}`);
  }
  if (health.status !== 200) {
    fail(`GET /health expected 200, got ${health.status}.`);
  }
  const healthBody = await readJson(health).catch((e) => fail(`GET /health: ${e.message}`));
  if (healthBody.status !== "ok") {
    fail(`GET /health body.status expected "ok", got ${JSON.stringify(healthBody.status)}.`);
  }
  console.log(`[staging-smoke]   (a) /health           OK   (environment=${healthBody.environment})`);

  // (b) POST /auth/otp/request -> 200 + dev_otp present (PROVES mock-OTP / console mode)
  let reqRes;
  try {
    reqRes = await fetch(`${base}/auth/otp/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: PHONE }),
    });
  } catch (e) {
    fail(`POST /auth/otp/request request errored: ${e.message}`);
  }
  if (reqRes.status !== 200) {
    fail(
      `POST /auth/otp/request expected 200, got ${reqRes.status}. ` +
        "If 429/503 the per-IP cap tripped or Redis is down (OTP fails closed without Redis).",
    );
  }
  const reqBody = await readJson(reqRes).catch((e) => fail(`POST /auth/otp/request: ${e.message}`));
  const devOtp = reqBody.dev_otp;
  if (!devOtp) {
    fail(
      "POST /auth/otp/request returned no dev_otp — env is NOT in mock-OTP mode " +
        "(SMS_PROVIDER!=console, or a real provider is wired, or NODE_ENV drifted). " +
        "Mode A staging REQUIRES SMS_PROVIDER=console so dev_otp is echoed.",
    );
  }
  // NEVER print devOtp — only confirm its presence + the delivery channel.
  console.log(
    `[staging-smoke]   (b) /auth/otp/request  OK   (dev_otp present; channel=${reqBody.channel})`,
  );

  // (c) POST /auth/otp/verify -> 200 + access_token present
  let verRes;
  try {
    verRes = await fetch(`${base}/auth/otp/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: PHONE, otp: devOtp }),
    });
  } catch (e) {
    fail(`POST /auth/otp/verify request errored: ${e.message}`);
  }
  if (verRes.status !== 200) {
    fail(`POST /auth/otp/verify expected 200, got ${verRes.status}.`);
  }
  const verBody = await readJson(verRes).catch((e) => fail(`POST /auth/otp/verify: ${e.message}`));
  const token = verBody.access_token;
  if (!token) {
    fail("POST /auth/otp/verify returned no access_token.");
  }
  // NEVER print the token — only confirm its presence + the safe, non-secret fields.
  console.log(
    `[staging-smoke]   (c) /auth/otp/verify   OK   (access_token present; is_new_worker=${verBody.is_new_worker})`,
  );

  // (d) GET /auth/me (Bearer) -> 200 + worker_id present
  let meRes;
  try {
    meRes = await fetch(`${base}/auth/me`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (e) {
    fail(`GET /auth/me request errored: ${e.message}`);
  }
  if (meRes.status !== 200) {
    fail(`GET /auth/me expected 200, got ${meRes.status}.`);
  }
  const meBody = await readJson(meRes).catch((e) => fail(`GET /auth/me: ${e.message}`));
  if (!meBody.worker_id) {
    fail("GET /auth/me returned no worker_id (the Bearer session did not resolve).");
  }
  console.log(`[staging-smoke]   (d) /auth/me           OK   (status=${meBody.status})`);

  console.log("\n[staging-smoke] PASS — /health ok + mock-OTP login round-trip succeeded (Mode A).");
}

main().catch((e) => fail(e?.message ?? String(e)));
