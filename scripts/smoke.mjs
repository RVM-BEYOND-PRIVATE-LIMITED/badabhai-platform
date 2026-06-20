#!/usr/bin/env node
/* global process, console, fetch, AbortSignal */
/**
 * BadaBhai smoke test — "is the API alive and is the front of the happy path wired?"
 *
 * A fast liveness + front-of-flow check. NOT a substitute for the asserted suite —
 * for a full run use `RUN_E2E=1 pnpm --filter @badabhai/e2e test`.
 *
 * Usage:
 *   node scripts/smoke.mjs [baseUrl]
 *   SMOKE_API_URL=https://<staging-api> node scripts/smoke.mjs
 *
 * Steps:
 *   1. GET  /health             — liveness (works in every environment).
 *   2. POST /auth/otp/request   — mock OTP; the *console* SMS provider echoes the code
 *      as `dev_otp` in dev/test ONLY. If absent (real SMS provider, e.g. staging), the
 *      login → consent flow is SKIPPED, not failed (set SMOKE_REQUIRE_FLOW=1 to force it).
 *   3. POST /auth/otp/verify    — exchange dev_otp for a worker_id (+ session).
 *   4. POST /consent/accept     — capture the DPDP consent (the AI gate).
 *
 * Safety:
 *   - WRITES a throwaway worker + consent (unique phone per run). Point ONLY at local
 *     or staging — NEVER production (no prod target is wired today). These routes are
 *     open, so no secret is needed. Only a masked phone is printed.
 *   - Exit non-zero if /health fails or any *attempted* flow step errors. A skipped
 *     flow (no dev_otp) is a warning, not a failure (unless SMOKE_REQUIRE_FLOW=1).
 */

const BASE = (
  process.argv[2] ||
  process.env.SMOKE_API_URL ||
  process.env.E2E_API_URL ||
  "http://localhost:3001"
).replace(/\/+$/, "");
const REQUIRE_FLOW = process.env.SMOKE_REQUIRE_FLOW === "1";
const CONSENT_VERSION = process.env.SMOKE_CONSENT_VERSION || "2026-06-01";
const PURPOSES = ["profiling", "resume_generation"];
// Unique throwaway number per run → always exercises the new-worker path in isolation.
const PHONE = `+9194${String(Date.now()).slice(-8)}`;

const maskPhone = (p) => p.replace(/^(\+?\d{3})\d+(\d{2})$/, "$1****$2");
const ok = (m) => console.log(`  ✓ ${m}`);
const note = (m) => console.log(`  - ${m}`);
let step = "init";

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, text };
}

async function main() {
  console.log(`BadaBhai smoke → ${BASE}`);

  step = "GET /health";
  const health = await call("GET", "/health");
  if (health.status !== 200) throw new Error(`${step} -> ${health.status} (${health.text})`);
  ok(`/health 200  ${JSON.stringify(health.body)}`);

  step = "POST /auth/otp/request";
  const reqOtp = await call("POST", "/auth/otp/request", { phone: PHONE });
  if (reqOtp.status !== 200 || reqOtp.body?.success !== true) {
    throw new Error(`${step} -> ${reqOtp.status} (${reqOtp.text})`);
  }
  ok(`/auth/otp/request 200  channel=${reqOtp.body.channel}  phone=${maskPhone(PHONE)}`);

  const devOtp = reqOtp.body?.dev_otp;
  if (!devOtp) {
    const msg = "no dev_otp → real SMS provider (not console-mode); login → consent flow SKIPPED.";
    if (REQUIRE_FLOW) throw new Error(`SMOKE_REQUIRE_FLOW=1 but ${msg}`);
    note(msg);
    console.log(
      "\nSMOKE PARTIAL: /health + /auth/otp/request OK; flow skipped (expected on real-SMS envs).",
    );
    return;
  }

  step = "POST /auth/otp/verify";
  const verify = await call("POST", "/auth/otp/verify", { phone: PHONE, otp: devOtp });
  if (verify.status !== 200 || !verify.body?.worker_id) {
    throw new Error(`${step} -> ${verify.status} (${verify.text})`);
  }
  const workerId = verify.body.worker_id;
  ok(`/auth/otp/verify 200  worker_id=${workerId}  is_new=${verify.body.is_new_worker}`);

  step = "POST /consent/accept";
  const consent = await call("POST", "/consent/accept", {
    worker_id: workerId,
    consent_version: CONSENT_VERSION,
    purposes: PURPOSES,
  });
  if (consent.status !== 201 || !consent.body?.consent_id) {
    throw new Error(`${step} -> ${consent.status} (${consent.text})`);
  }
  ok(`/consent/accept 201  consent_id=${consent.body.consent_id}`);

  console.log("\nSMOKE PASS: /health + login → consent wired (worker created, consent captured).");
}

main().catch((err) => {
  console.error(`\nSMOKE FAIL at [${step}]: ${err?.message ?? err}`);
  process.exit(1);
});
