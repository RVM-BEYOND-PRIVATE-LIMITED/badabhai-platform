// scripts/staging-smoke.test.mjs
// Self-test for scripts/staging-smoke.mjs — node:test, zero deps, NO external network.
// Spins a localhost (127.0.0.1) HTTP server that emulates the staging API, then runs
// the REAL smoke script as a child process against it. Asserts: PASS on a healthy
// Mode-A env, FAIL (exit 1) when dev_otp is absent, and that secrets never leak to stdout.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The test lives beside the script (both in scripts/).
const SMOKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "staging-smoke.mjs");

const DEV_OTP = "123456";
const TOKEN = "tok_secret_value";

// Build a server whose /auth/otp/request body is produced by `otpRequestBody`,
// so a test can drop dev_otp to simulate a non-mock-OTP env.
function makeServer(otpRequestBody) {
  return createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (code, obj) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.method === "GET" && req.url === "/health") {
        return send(200, { status: "ok", service: "api", environment: "staging" });
      }
      if (req.method === "POST" && req.url === "/auth/otp/request") {
        return send(200, otpRequestBody);
      }
      if (req.method === "POST" && req.url === "/auth/otp/verify") {
        return send(200, { access_token: TOKEN, worker_id: "w-1", is_new_worker: true, status: "active" });
      }
      if (req.method === "GET" && req.url === "/auth/me") {
        return send(200, { worker_id: "w-1", status: "active" });
      }
      send(404, { error: "not found" });
    });
  });
}

async function runSmoke(otpRequestBody) {
  const server = makeServer(otpRequestBody);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const child = spawn(process.execPath, [SMOKE], {
    env: { ...process.env, STAGING_API_BASE_URL: `http://127.0.0.1:${port}/` }, // trailing slash on purpose
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const [code] = await once(child, "exit");
  server.close();
  return { code, out };
}

test("PASS on a healthy Mode-A env (dev_otp present)", async () => {
  const { code, out } = await runSmoke({ success: true, channel: "sms", resend_in_seconds: 30, dev_otp: DEV_OTP });
  assert.equal(code, 0, `expected exit 0, got ${code}\n${out}`);
  assert.match(out, /PASS/);
  // Privacy: neither the OTP nor the token may appear in output.
  assert.ok(!out.includes(DEV_OTP), "dev_otp leaked to stdout");
  assert.ok(!out.includes(TOKEN), "access_token leaked to stdout");
  // Phone is masked (full synthetic number never printed).
  assert.ok(!out.includes("+910000000000"), "phone printed in full");
});

test("FAIL (exit 1) when dev_otp is absent (NOT mock-OTP mode)", async () => {
  const { code, out } = await runSmoke({ success: true, channel: "sms", resend_in_seconds: 30 });
  assert.equal(code, 1, `expected exit 1, got ${code}\n${out}`);
  assert.match(out, /FAIL/);
  assert.match(out, /dev_otp/);
});
