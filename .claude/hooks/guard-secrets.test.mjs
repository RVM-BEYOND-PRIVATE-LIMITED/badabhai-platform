#!/usr/bin/env node
/**
 * Behavior spec for the PreToolUse secrets/danger guard. Run:
 *   node .claude/hooks/guard-secrets.test.mjs
 *
 * Imports the pure decide() — so this file's (intentionally dangerous-looking)
 * fixture strings are never executed and never reach a shell. The guard only
 * inspects tool input, not file contents, so these fixtures are inert.
 */
/* global console, process */
import assert from "node:assert/strict";
import { decide } from "./guard-secrets.mjs";

let passed = 0;
const failures = [];

function expect(label, payload, want) {
  const got = decide(payload).decision;
  try {
    assert.equal(got, want, `${label}: expected ${want}, got ${got}`);
    passed++;
  } catch (e) {
    failures.push(e.message);
  }
}

const read = (file_path) => ({ tool_name: "Read", tool_input: { file_path } });
const write = (file_path) => ({ tool_name: "Write", tool_input: { file_path } });
const grep = (path) => ({ tool_name: "Grep", tool_input: { path, pattern: "x" } });
const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });

// --- secret files: DENY ---
expect("Read .env", read("apps/api/.env"), "deny");
expect("Read nested .env.production", read("apps/api/.env.production"), "deny");
expect("Read private key .pem", read("infra/tls/server.pem"), "deny");
expect("Read .key", read("certs/app.key"), "deny");
expect("Read id_rsa", read("/home/u/.ssh/id_rsa"), "deny");
expect("Read serviceAccount json", read("gcp-serviceAccount-prod.json"), "deny");
expect("Write .env.staging", write(".env.staging"), "deny");
expect("Grep into .env", grep("apps/api/.env"), "deny");

// --- templates / normal files: ALLOW ---
expect("Read .env.example", read(".env.example"), "allow");
expect("Read .env.staging.example", read("apps/ai-service/.env.staging.example"), "allow");
expect("Read normal source", read("apps/api/src/app.module.ts"), "allow");
expect("Read id_rsa.pub (public)", read("~/.ssh/id_rsa.pub"), "allow");

// --- dangerous shell: DENY ---
expect("rm -rf root", bash("rm -rf /"), "deny");
expect("rm -rf home", bash("sudo rm -rf ~"), "deny");
expect("rm -rf cwd dot", bash("rm -rf ."), "deny");
expect("force push main", bash("git push --force origin main"), "deny");
expect("force push -f master", bash("git push -f origin master"), "deny");
expect("force push +refspec main", bash("git push origin +main"), "deny");
expect("drop table via psql", bash('psql "$DATABASE_URL" -c "DROP TABLE workers"'), "deny");
expect("truncate table", bash('psql -c "TRUNCATE TABLE events"'), "deny");
expect("cat .env", bash("cat apps/api/.env"), "deny");

// --- safe shell: ALLOW ---
expect("rm -rf node_modules", bash("rm -rf node_modules dist"), "allow");
expect("force-with-lease feature", bash("git push --force-with-lease origin feat/x"), "allow");
expect(
  "force-push a feature branch (not protected)",
  bash("git push --force origin feature/x"),
  "allow",
);
expect(
  "commit -F then push (no -F false positive)",
  bash("git commit -F msg.txt && git push -u origin feature"),
  "allow",
);
expect("cat .env.example", bash("cat .env.example"), "allow");
expect("pnpm test", bash("pnpm test"), "allow");
expect("normal migrate", bash("pnpm --filter @badabhai/db db:migrate"), "allow");

// --- robustness: unknown tool / empty input ALLOW ---
expect("unknown tool", { tool_name: "WebFetch", tool_input: {} }, "allow");
expect("empty payload", {}, "allow");

if (failures.length) {
  console.error(`guard-secrets: ${failures.length} FAILED, ${passed} passed`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`guard-secrets: all ${passed} cases passed`);
