// scripts/staging-smoke.test.mjs
// Self-test for scripts/staging-smoke.mjs (D-3 rewrite) — node:test, zero deps,
// NO external network. Spins a localhost (127.0.0.1) HTTP server that emulates
// the staging API, then runs the REAL smoke script as a child process against it.
// Asserts: health-only PASS without SMOKE_TEST_LOGIN_TOKEN, full PASS with it,
// FAIL (exit 1) on a disabled seam (404) / wrong token (401) / unhealthy /health,
// and that secrets (gate token, access token, phone) never leak to stdout/stderr.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The test lives beside the script (both in scripts/).
const SMOKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "staging-smoke.mjs");

const GATE_TOKEN = "smoke-gate-token-0123456789abcdef"; // >=32 chars, like the real gate
const ACCESS_TOKEN = "tok_secret_value";

/**
 * Build a fake staging API.
 *   opts.health     — the /health response      (default healthy 200)
 *   opts.testLogin  — (req) => [code, body] for POST /auth/test-login; default
 *                     validates the x-test-login-token header like TestLoginGuard
 *                     (right token → 200 + access_token; wrong → 401).
 *   opts.seamOff    — when true, /auth/test-login answers the NEUTRAL 404 the
 *                     disabled gate returns.
 */
function makeServer(opts = {}) {
  const health = opts.health ?? {
    code: 200,
    body: { status: "ok", service: "api", environment: "staging" },
  };
  return createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (code, obj) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.method === "GET" && req.url === "/health") {
        return send(health.code, health.body);
      }
      if (req.method === "POST" && req.url === "/auth/test-login") {
        if (opts.seamOff) return send(404, { statusCode: 404, message: "Not found" });
        if (req.headers["x-test-login-token"] !== GATE_TOKEN) {
          return send(401, { statusCode: 401, message: "invalid or missing test-login token" });
        }
        return send(200, {
          access_token: ACCESS_TOKEN,
          token_type: "Bearer",
          worker_id: "w-1",
          is_new_worker: true,
          status: "active",
          pin_set: false,
          consent_accepted: false,
        });
      }
      if (req.method === "GET" && req.url === "/auth/me") {
        if (req.headers["authorization"] !== `Bearer ${ACCESS_TOKEN}`) {
          return send(401, { statusCode: 401, message: "unauthorized" });
        }
        return send(200, { worker_id: "w-1", status: "active" });
      }
      send(404, { error: "not found" });
    });
  });
}

async function runSmoke(serverOpts = {}, env = {}) {
  const server = makeServer(serverOpts);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const childEnv = {
    ...process.env,
    STAGING_API_BASE_URL: `http://127.0.0.1:${port}/`, // trailing slash on purpose
    ...env,
  };
  // Ensure a stale ambient token can't leak into the health-only cases.
  if (!("SMOKE_TEST_LOGIN_TOKEN" in env)) delete childEnv.SMOKE_TEST_LOGIN_TOKEN;
  const child = spawn(process.execPath, [SMOKE], {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const [code] = await once(child, "exit");
  server.close();
  return { code, out };
}

test("health-only PASS when SMOKE_TEST_LOGIN_TOKEN is not set (authed stage skipped)", async () => {
  const { code, out } = await runSmoke();
  assert.equal(code, 0, `expected exit 0, got ${code}\n${out}`);
  assert.match(out, /PASS/);
  assert.match(out, /health ONLY/);
  assert.match(out, /authed stage skipped/);
  assert.ok(!out.includes("/auth/test-login   OK"), "authed stage ran without a token");
});

test("full PASS with SMOKE_TEST_LOGIN_TOKEN: health + test-login mint + authed /auth/me read", async () => {
  const { code, out } = await runSmoke({}, { SMOKE_TEST_LOGIN_TOKEN: GATE_TOKEN });
  assert.equal(code, 0, `expected exit 0, got ${code}\n${out}`);
  assert.match(out, /PASS/);
  assert.match(out, /\/auth\/test-login\s+OK/);
  assert.match(out, /\/auth\/me\s+OK/);
  // Privacy: neither the gate token, the access token, nor the phone may appear.
  assert.ok(!out.includes(GATE_TOKEN), "gate token leaked to output");
  assert.ok(!out.includes(ACCESS_TOKEN), "access_token leaked to output");
  assert.ok(!out.includes("+910000000000"), "phone printed in full");
});

test("FAIL (exit 1) when the seam is DISABLED on the target (neutral 404)", async () => {
  const { code, out } = await runSmoke({ seamOff: true }, { SMOKE_TEST_LOGIN_TOKEN: GATE_TOKEN });
  assert.equal(code, 1, `expected exit 1, got ${code}\n${out}`);
  assert.match(out, /FAIL/);
  assert.match(out, /404/);
  assert.match(out, /TEST_LOGIN_ENABLED/);
});

test("FAIL (exit 1) on a WRONG gate token (401) — and neither token value leaks", async () => {
  const wrong = "wrong-token-token-0123456789abcdef";
  const { code, out } = await runSmoke({}, { SMOKE_TEST_LOGIN_TOKEN: wrong });
  assert.equal(code, 1, `expected exit 1, got ${code}\n${out}`);
  assert.match(out, /FAIL/);
  assert.match(out, /401/);
  assert.ok(!out.includes(GATE_TOKEN), "expected gate token leaked");
  assert.ok(!out.includes(wrong), "provided token leaked");
});

// Review L2 — the gate token rides a header; a non-loopback http:// base would put it
// on the wire in plaintext. The check fires BEFORE any request is made.
test("FAIL (exit 1) when the authed stage is armed over non-loopback http:// (TLS gate)", async () => {
  const child = spawn(process.execPath, [SMOKE], {
    env: {
      ...process.env,
      STAGING_API_BASE_URL: "http://staging-api.example.test",
      SMOKE_TEST_LOGIN_TOKEN: GATE_TOKEN,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const [code] = await once(child, "exit");
  assert.equal(code, 1, `expected exit 1, got ${code}\n${out}`);
  assert.match(out, /FAIL/);
  assert.match(out, /PLAINTEXT/);
  assert.ok(!out.includes(GATE_TOKEN), "gate token leaked to output");
  // It must not even have attempted the request (no stage output at all).
  assert.ok(!out.includes("/health           OK"), "made a request despite the TLS gate");
});

test("health-only over non-loopback http:// is ALLOWED (no secret on the wire)", async () => {
  // The TLS gate is scoped to the authed stage: the health probe sends no secret, so a
  // plain-http health-only run must still work (it is what CD gates on today).
  const { code, out } = await runSmoke();
  assert.equal(code, 0, `expected exit 0, got ${code}\n${out}`);
  assert.match(out, /PASS/);
});

test("FAIL (exit 1) when /health is unhealthy (503) — even in health-only mode", async () => {
  const { code, out } = await runSmoke({
    health: { code: 503, body: { status: "error", checks: { database: "down", redis: "up" } } },
  });
  assert.equal(code, 1, `expected exit 1, got ${code}\n${out}`);
  assert.match(out, /FAIL/);
  assert.match(out, /database/);
});
