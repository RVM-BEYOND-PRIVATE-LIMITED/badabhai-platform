#!/usr/bin/env node
/**
 * BadaBhai PreToolUse guard — fail-closed protection for secrets and
 * catastrophic shell actions. Pure Node (no shell, cross-platform: Windows /
 * macOS / Linux / CI). Wired from .claude/settings.json on:
 *   matcher "Read|Edit|Write|Bash|Grep"
 *
 * Contract (Claude Code PreToolUse hook):
 *   - stdin  : JSON { tool_name, tool_input: { file_path?, command?, path? } }
 *   - DENY   : print { hookSpecificOutput: { hookEventName, permissionDecision:
 *              "deny", permissionDecisionReason } } and exit 0.
 *   - ALLOW  : print nothing and exit 0 → normal permission flow is unchanged
 *              (this guard never auto-allows; it only blocks).
 *
 * Design notes
 *   - This is layer 2. Layer 1 is the declarative `permissions.deny` list in
 *     .claude/settings.json, which blocks secret-file reads even if this script
 *     never runs. Keep the two in sync when adding patterns.
 *   - `.env.example` / `.env.*.example` (and .sample/.template/.dist) are
 *     templates the repo and CI legitimately read — they are NOT secrets.
 *   - `decide()` is exported and pure so it can be unit-tested
 *     (.claude/hooks/guard-secrets.test.mjs). The stdin runner only executes
 *     when this file is invoked directly as the hook command.
 */

/* global process */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SAFE_ENV_SUFFIXES = [".example", ".sample", ".template", ".dist"];

// Secret file basenames / patterns. Tested against the path basename.
const SECRET_BASENAME_RES = [
  /^\.env$/i,
  /^\.env\.[^/\\]+$/i, // .env.local, .env.production, … (.example filtered below)
  /^id_rsa$/i,
  /^id_ed25519$/i,
  /^id_ecdsa$/i,
  /^credentials\.json$/i,
  /service[-_]?account.*\.json$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
];

function basename(p) {
  return (
    String(p)
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || ""
  );
}

function isSafeEnvTemplate(name) {
  const lower = name.toLowerCase();
  return SAFE_ENV_SUFFIXES.some((s) => lower.endsWith(s));
}

export function isSecretPath(filePath) {
  if (!filePath) return false;
  const name = basename(filePath);
  if (!name) return false;
  if (isSafeEnvTemplate(name)) return false; // .env.example & friends are fine
  if (/\.pub$/i.test(name)) return false; // a .pub public key is not a secret
  return SECRET_BASENAME_RES.some((re) => re.test(name));
}

// Catastrophic / irreversible shell command patterns. Conservative on purpose:
// routine `rm -rf node_modules|dist|.next` is NOT blocked — only root/home/cwd
// wipes and the disasters the playbook names. Returns a reason string or null.
export function dangerousCommandReason(cmd) {
  if (!cmd) return null;
  const c = String(cmd);

  // rm with both -r and -f (any order/combination) aimed at a catastrophic
  // target: filesystem root, home, or the current/parent directory itself.
  const rmRecursiveForce =
    /\brm\s+(-[a-z]*\s+)*-?[a-z]*(rf|fr)[a-z]*\b|\brm\s+(-[a-z]+\s+)*(-r\b.*-f\b|-f\b.*-r\b)/i;
  if (rmRecursiveForce.test(c)) {
    const target =
      /\brm\s+[^|;&]*?\s(\/(\s|\*|$)|\/\*|~(\/|\s|$)|\$HOME|\.(\s|$)|\.\/(\s|\*|$)|\.\.(\/|\s|$))/;
    if (target.test(c)) {
      return "Refusing `rm -rf` targeting filesystem root, home, or the current/parent directory. Delete a specific subpath instead.";
    }
  }

  // git FORCE-push to a PROTECTED branch (main/master) — the catastrophic case.
  // Scope the flag check to the `git push …` segment so an unrelated flag elsewhere
  // on the line (e.g. `git commit -F msg && git push …`) can't trigger it. Short
  // flags are matched CASE-SENSITIVELY: `-f` forces a push, but `-F` is git commit's
  // `--file` and must never count. Force-pushing a FEATURE branch and
  // `--force-with-lease` are routine and allowed; only main/master is blocked.
  const pushSeg = c.match(/\bgit\s+push\b[^|&;\n]*/i);
  if (pushSeg) {
    const seg = pushSeg[0];
    const hasForce = /--force\b(?!-with-lease)/.test(seg) || /(?:^|\s)-[a-z]*f[a-z]*\b/.test(seg);
    const targetsProtected = /\b(main|master)\b/.test(seg);
    const plusProtectedRefspec = /\s\+(?:refs\/heads\/)?(?:main|master)\b/.test(seg);
    if ((hasForce && targetsProtected) || plusProtectedRefspec) {
      return "Refusing force-push to a protected branch (main/master). Use --force-with-lease, and never force a protected branch.";
    }
  }

  // Destructive DDL issued as a shell command (psql -c, etc.). Only inspects
  // the command line — migration .sql FILES are never read by this guard.
  if (/\b(DROP\s+(DATABASE|SCHEMA|TABLE)|TRUNCATE\s+(TABLE\s+)?\w)/i.test(c)) {
    return "Refusing destructive DDL (DROP/TRUNCATE) from the shell. Route schema changes through a reviewed Drizzle migration (bb-database-design / safe-db-migration).";
  }

  // Printing a real .env via the shell (cat/type/Get-Content/less/more/head/tail).
  if (
    /\b(cat|less|more|head|tail|type|Get-Content|gc)\b[^|;&]*?(^|[\s"'`=\\/])\.env(\b|$)/i.test(
      c,
    ) &&
    // Template exemption. Mirrors guard.mjs's ENV_TEMPLATE_SUFFIX/ENV_TOKEN pair —
    // keep the two in step. `[^...]*` spans intermediate segments so MULTI-segment
    // templates (`.env.staging.example`) are exempt, not just `.env.example`; before
    // this, layer 1 allowed them while layer 2 still denied, so the read failed anyway.
    // The trailing lookahead (NOT `\b`) anchors the suffix to the END of the filename:
    // with `\b`, `.env.example-prod` and `.env.staging.example~` (an editor backup
    // holding real values) matched the exemption, because `-` and `~` are themselves
    // word boundaries.
    !/\.env[^\s'"`|;&<>()]*\.(example|sample|template|dist)(?=[\s'"`|;&<>()]|$)/i.test(c)
  ) {
    return "Refusing to print a .env file via the shell (secrets must never reach logs or context). Read .env.example instead.";
  }

  return null;
}

/**
 * Pure decision function. Returns { decision: "deny", reason } or
 * { decision: "allow" }. Never throws on shape — unknown tools allow.
 */
export function decide(payload) {
  const tool = (payload && payload.tool_name) || "";
  const input = (payload && payload.tool_input) || {};

  if (tool === "Read" || tool === "Edit" || tool === "Write") {
    if (isSecretPath(input.file_path)) {
      return {
        decision: "deny",
        reason: `Blocked ${tool} on a secret/credential file ("${basename(
          input.file_path,
        )}"). Raw secrets must never be read, edited, or written by the agent.`,
      };
    }
  } else if (tool === "Grep") {
    if (isSecretPath(input.path)) {
      return {
        decision: "deny",
        reason: `Blocked Grep targeting a secret/credential file ("${basename(input.path)}").`,
      };
    }
  } else if (tool === "Bash") {
    const reason = dangerousCommandReason(input.command);
    if (reason) return { decision: "deny", reason };
  }

  return { decision: "allow" };
}

function emitDenyAndExit(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `[BadaBhai guard] ${reason}`,
      },
    }),
  );
  process.exit(0);
}

function runFromStdin(raw) {
  let payload;
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    // Can't parse → don't brick the session. Secret files are still covered by
    // the declarative permissions.deny layer in settings.json.
    process.exit(0);
  }
  const result = decide(payload);
  if (result.decision === "deny") emitDenyAndExit(result.reason);
  process.exit(0); // allow: no output, normal permission flow applies
}

// Only run the stdin loop when invoked directly as the hook command — not when
// imported by the test file.
let isEntry = false;
try {
  isEntry = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  isEntry = false;
}

if (isEntry) {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (buf += d));
  process.stdin.on("end", () => runFromStdin(buf));
  process.stdin.on("error", () => process.exit(0));
}
