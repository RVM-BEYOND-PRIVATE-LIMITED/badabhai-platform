#!/usr/bin/env node
/**
 * .claude/hooks/guard.mjs — Claude Code PreToolUse guardrail.
 *
 * Defense-in-depth on top of the declarative `permissions.deny` rules in
 * .claude/settings.json. Blocks (exit code 2 = block; stderr is shown to Claude):
 *   - Read/Edit/Write of secret files (.env*, *.pem, *.key, *.p12/pfx, id_rsa, service-account*.json,
 *     *credentials*.json) — except .env.example/.sample/.template.
 *   - Shell commands that reference a secret file in ANY way (read/copy/move/redirect/interpreter),
 *     EXCEPT the one narrow "load .env into a var/pipe without exposing it" pattern. This inverted
 *     model is deliberate: it is far harder to bypass than an allow-list of display verbs
 *     (cat/cp/Out-File/node -e/xxd/awk/... are all covered because ANY reference is suspect).
 *   - Shell commands that echo a secret VALUE (a `$`-dereference of a secret-named variable).
 *   - Catastrophic shell (rm -rf /, fork bomb, mkfs, dd of=/dev/..., git push --force/-f,
 *     supabase db reset, dropdb, destructive SQL via a DB client, Remove-Item -Recurse -Force on
 *     a root/home path, format <drive>:).
 *
 * Design rules (read before editing):
 *   - FAIL OPEN: any internal error -> allow (exit 0). A guard bug must never brick the session.
 *   - The hard secret-file guarantee is the `permissions.deny` list; this hook is the smart layer.
 *   - Conservative on destructive shell to avoid false positives on ordinary work
 *     (`rm -rf node_modules`, `Remove-Item -Recurse -Force ./dist`, writing SQL into a *.sql file,
 *     `git push --force-with-lease`, `echo`-ing a status message that merely mentions a keyword).
 *   - The legit "DATABASE_URL load" pattern (assignment / pipe-filter, no echo/copy/redirect/network)
 *     is the ONLY allowed way a shell command may touch a .env file.
 *
 * To disable: remove the `hooks` block from .claude/settings.json.
 */

import process from "node:process";

function allow() {
  process.exit(0);
}

function block(reason) {
  // PreToolUse: exit code 2 blocks the tool call; stderr is fed back to Claude.
  process.stderr.write(`[guard] BLOCKED: ${reason}\n`);
  process.exit(2);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve(data);
      }
    };
    try {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => (data += chunk));
      process.stdin.on("end", finish);
      process.stdin.on("error", finish);
      setTimeout(finish, 1500); // never hang if no stdin is delivered
    } catch {
      finish();
    }
  });
}

// Non-.env secret files (keys, certs, cloud creds), matched anywhere in a path or command.
const NON_ENV_SECRET =
  /(\.pem\b|\.key\b|\.p12\b|\.pfx\b|\.keystore\b|\.jks\b|\bid_rsa\b|service-account[\w.-]*\.json|credentials[\w-]*\.json)/i;

/** A file path that holds secrets. Base-name based so `.env.example` stays readable. */
function isSecretFilePath(p) {
  if (!p) return false;
  const base = String(p).replace(/\\/g, "/").toLowerCase().split("/").pop() || "";
  if (base === ".env.example" || base === ".env.sample" || base === ".env.template") return false;
  if (base === ".env" || base.startsWith(".env.")) return true;
  return NON_ENV_SECRET.test(base);
}

/** Command references a secret file (.env / key / cert / cloud creds), excluding .env.example. */
function touchesSecretFile(cmd) {
  const envTokens = cmd.match(/\.env(\.[a-z0-9_]+)?\b/gi) || [];
  if (envTokens.some((t) => !/\.(example|sample|template)$/i.test(t))) return true;
  return NON_ENV_SECRET.test(cmd);
}

/**
 * The ONLY legit way a shell command may touch a secret file: load a .env into a variable or
 * pipe-filter without exposing it. Never applies to keys/certs/creds, and is disqualified by any
 * display / copy / move / redirect / network / interpreter verb.
 */
function isSafeEnvLoad(cmd) {
  if (NON_ENV_SECRET.test(cmd)) return false; // keys/certs/creds are never a "safe load"
  const load =
    /(\$\w+\s*=\s*\(?\s*(get-content|gc|cat)\b|(get-content|gc|cat)\b[^\n|]*\|\s*(where-object|select-string|convertfrom-stringdata|out-string|measure-object)\b|-replace)/i;
  if (!load.test(cmd)) return false;
  const expose =
    /(\b(echo|printf|write-output|write-host|cp|copy|copy-item|mv|move-item|scp|rsync|tee|tee-object|out-file|set-content|add-content|curl|wget|invoke-webrequest|iwr|nc|netcat)\b|>>?\s|\bnode\s+-e\b|\bpython\d?\s+-c\b|\bnpx\b)/i;
  return !expose.test(cmd);
}

/** Echoing a secret VALUE: a print verb plus a `$`-dereference of a secret-named variable. */
function echoesSecretValue(cmd) {
  return /\b(echo|printf|write-output|write-host)\b[^\n]*\$\{?(env:)?\w*(service_role|database_url|api[_-]?key|secret|token|password|gemini[\w]*key|sarvam[\w]*key|langfuse[\w]*key|supabase[\w]*key)\w*/i.test(
    cmd,
  );
}

function isCatastrophic(cmd) {
  const patterns = [
    /rm\s+-[a-z]*r[a-z]*f[a-z]*\s+(\/(\s|$|\*)|~(\s|$|\/)|\$home|--no-preserve-root)/i,
    /rm\s+-[a-z]*f[a-z]*r[a-z]*\s+(\/(\s|$|\*)|~(\s|$|\/)|\$home)/i,
    /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // fork bomb
    /\bmkfs\b/i,
    /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|disk|hd)/i,
    />\s*\/dev\/(sd|nvme|hd)/i,
    /\bgit\s+push\b[^\n]*(\s--force(?![\w-])|\s-f(?![\w-]))/i, // --force / -f, NOT --force-with-lease
    /\bsupabase\b[^\n]*\bdb\s+reset\b/i,
    /\bdropdb\b/i,
    /\bformat\b\s+[a-z]:/i,
    /remove-item\b[^\n]*-recurse\b[^\n]*-force\b[^\n]*(\s[a-z]:\\(\s|$)|\\\\|\$home|~(\s|$|\\)|\s\/(\s|$))/i,
  ];
  if (patterns.some((re) => re.test(cmd))) return true;
  // Destructive SQL only when paired with an actual DB client (not a literal string / *.sql write).
  const dbClient =
    /\b(psql|mysql|mariadb|mongo|supabase|prisma|drizzle-kit|pg_dump|pg_restore|sqlite3)\b/i;
  const destructiveSql = /\b(drop\s+(database|table|schema)|truncate\s+table)\b/i;
  return dbClient.test(cmd) && destructiveSql.test(cmd);
}

async function main() {
  const raw = await readStdin();
  let payload = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    allow(); // unparseable input -> fail open
  }

  const tool = String(payload.tool_name || "");
  const input = payload.tool_input || {};

  if (/^(Read|Edit|Write|NotebookEdit)$/.test(tool)) {
    const path = input.file_path || input.path || input.notebook_path;
    if (isSecretFilePath(path)) block(`access to a secret file is not allowed: ${path}`);
    allow();
  }

  if (/^(Bash|PowerShell)$/.test(tool)) {
    const cmd = String(input.command || "");
    if (!cmd) allow();
    if (isCatastrophic(cmd)) block("catastrophic/destructive command pattern detected");
    if (touchesSecretFile(cmd) && !isSafeEnvLoad(cmd)) {
      block("command references a secret file (read/copy/redirect blocked)");
    }
    if (echoesSecretValue(cmd)) block("command appears to echo a secret value to output");
    allow();
  }

  allow(); // any other tool
}

main().catch(() => allow()); // fail open on any unexpected error
