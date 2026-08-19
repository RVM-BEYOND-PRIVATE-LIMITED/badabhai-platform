#!/usr/bin/env node
// scripts/check-secret-parity.mjs
//
// Structural drift check: does every env var docker-compose.staging.yml REQUIRES
// (the `${VAR:?...}` fail-loud form) have a matching `${{ secrets.NAME }}` bridge
// in the deploy job of a given GitHub Actions workflow?
//
// WHY THIS EXISTS. docker-compose.staging.yml's `${VAR:?}` list is the single
// source of truth for "what this box's api/ai-service containers cannot boot
// without". Two INDEPENDENT workflows bridge GitHub Secrets into that same
// compose file's shell environment for two different deploy paths:
//   .github/workflows/ci.yml         deploy-lightsail job (the live Lightsail path)
//   .github/workflows/staging-cd.yml deploy job (persistent-staging CD — currently
//                                     an inert guarded no-op until a human wires the
//                                     `staging` GitHub Environment secrets)
// Nothing kept those two secret-bridge lists in sync with docker-compose.staging.yml,
// or with each other, and the two docs that were supposed to document "the exact
// secret list currently bridged" (docs/release-checklist.md, docs/rollback-guide.md)
// are broken cross-references to each other with no list in either. This script is
// the structural backstop: a docs rot or a one-sided secret-bridge edit is now a
// grep away from being caught in CI instead of at 3am on a box that refuses to boot.
//
// SCOPE: text/structure only. Every file this script reads (docker-compose.staging.yml,
// ci.yml, staging-cd.yml) contains variable NAMES only — never a value — so there is
// nothing secret in this script's input or output. It never prints anything but names.
//
// CONVENTION: pure Node, dependency-free, no install beyond actions/setup-node — the
// same discipline as supabase-checks.yml's migration-sequence job (see
// docs/supabase-workflow.md). Deliberately NOT a real YAML parser: docker-compose.staging.yml
// and the workflow files under .github/workflows/ all share one stable indent shape
// (a root key at column 0, an item name at column 2, the item body indented 4+), so a
// line-oriented scan is exact for THIS shape without adding a YAML dependency.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const COMPOSE_FILE = path.join(REPO_ROOT, "docker-compose.staging.yml");
const COMPOSE_SERVICES = ["api", "ai-service"];

// The two deploy paths this check compares against the compose requirement, and the
// single job in each workflow that actually bridges secrets into that deploy.
const WORKFLOW_TARGETS = [
  {
    label: "ci.yml",
    file: path.join(REPO_ROOT, ".github", "workflows", "ci.yml"),
    job: "deploy-lightsail",
    // #994: the deploy BODY no longer lives in the job block — it moved into this script
    // because the inline version had reached ~97% of GitHub's ~21 KB step-input ceiling,
    // past which the whole workflow silently stops parsing. Reading only the job block
    // would now describe half a deploy: this check asks "does the deploy bridge every
    // required var", and the answer must not depend on which file the text happens to sit
    // in. (The three *_IMAGE vars it reports today are a PRE-EXISTING gap, unchanged by
    // that move — they are exported, not bridged, in both layouts.) Same scope note as the
    // header: names only, never values.
    alsoScan: [path.join(REPO_ROOT, "scripts", "deploy", "staging-deploy.sh")],
  },
  {
    label: "staging-cd.yml",
    file: path.join(REPO_ROOT, ".github", "workflows", "staging-cd.yml"),
    job: "deploy",
  },
];

/**
 * Split YAML-ish text into named blocks keyed by the item name at 2-space indent,
 * scoped to start immediately AFTER a given 0-indent root key (e.g. "services:" or
 * "jobs:"). Returns Map<itemName, blockText> — blockText runs to the next 2-space
 * header or EOF, whichever comes first.
 *
 * Deliberately line-oriented rather than a real parser: exact for the stable indent
 * shape these three files share (root key at column 0, item name at column 2, item
 * body indented 4+), same discipline as supabase-checks.yml's migration-sequence job.
 */
export function extractIndentedBlocks(text, rootKey) {
  const lines = text.split(/\r?\n/);
  const rootIdx = lines.findIndex((line) => line === `${rootKey}:`);
  if (rootIdx === -1) {
    throw new Error(`could not find a top-level "${rootKey}:" key`);
  }

  const headerRe = /^ {2}([A-Za-z0-9_-]+):\s*$/;
  const blocks = new Map();
  let currentName = null;
  let currentLines = [];

  const flush = () => {
    if (currentName !== null) blocks.set(currentName, currentLines.join("\n"));
  };

  for (let i = rootIdx + 1; i < lines.length; i++) {
    const match = headerRe.exec(lines[i]);
    if (match) {
      flush();
      currentName = match[1];
      currentLines = [];
    } else if (currentName !== null) {
      currentLines.push(lines[i]);
    }
  }
  flush();
  return blocks;
}

/**
 * Drop full-comment lines (trimmed content starts with "#") before pattern-matching.
 * LOAD-BEARING: docker-compose.staging.yml's own prose comments illustrate the
 * `${VAR:?}` syntax generically (e.g. "`${VAR:?}` fails at compose time…") — left
 * in, that literal example text would be extracted as a required variable named
 * "VAR" that no workflow could ever bridge. Real declaration lines in these files
 * never carry a trailing same-line "#" comment after the value (verified against
 * both docker-compose.staging.yml and ci.yml/staging-cd.yml), so a full-line filter
 * is exact here without needing a real YAML/comment-aware tokenizer.
 */
function stripCommentLines(blockText) {
  return blockText
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

/** Every `${NAME:?...}` (compose's fail-loud "required" form) in a block, deduped. */
export function extractComposeRequiredVars(blockText) {
  const names = new Set();
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*):\?/g;
  let match;
  while ((match = re.exec(stripCommentLines(blockText)))) names.add(match[1]);
  return names;
}

/** Every `${{ secrets.NAME }}` reference in a block, deduped. */
export function extractSecretRefs(blockText) {
  const names = new Set();
  const re = /\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  let match;
  while ((match = re.exec(stripCommentLines(blockText)))) names.add(match[1]);
  return names;
}

/** docker-compose.staging.yml -> Map<serviceName, Set<requiredVarName>>. */
export function parseComposeRequiredVars(composeText) {
  const services = extractIndentedBlocks(composeText, "services");
  const result = new Map();
  for (const [name, block] of services) {
    result.set(name, extractComposeRequiredVars(block));
  }
  return result;
}

/** A workflow file's named job -> Set<secretName> referenced anywhere within it. */
export function parseWorkflowJobSecrets(workflowText, jobName) {
  const jobs = extractIndentedBlocks(workflowText, "jobs");
  const block = jobs.get(jobName);
  if (block === undefined) {
    throw new Error(
      `job "${jobName}" not found under jobs: (found: ${[...jobs.keys()].join(", ")})`,
    );
  }
  return extractSecretRefs(block);
}

/**
 * The gate itself: for each service's required-var set, which vars have no
 * matching entry in `secretRefs`. Returns Map<serviceName, string[]> — services
 * with nothing missing are omitted, so an empty Map means "fully covered".
 */
export function findMissing(requiredByService, secretRefs) {
  const missingByService = new Map();
  for (const [service, required] of requiredByService) {
    const missing = [...required].filter((name) => !secretRefs.has(name)).sort();
    if (missing.length > 0) missingByService.set(service, missing);
  }
  return missingByService;
}

function formatReport(label, jobName, missingByService) {
  if (missingByService.size === 0) {
    return [`  OK    ${label} (${jobName}) bridges every docker-compose.staging.yml required var.`];
  }
  const lines = [];
  for (const [service, vars] of missingByService) {
    lines.push(`  MISSING in ${label} (${jobName}), service "${service}": ${vars.join(", ")}`);
  }
  return lines;
}

function main() {
  const composeText = readFileSync(COMPOSE_FILE, "utf8");
  const requiredByService = parseComposeRequiredVars(composeText);
  for (const service of COMPOSE_SERVICES) {
    if (!requiredByService.has(service)) {
      throw new Error(
        `expected service "${service}" in docker-compose.staging.yml — found: ${[...requiredByService.keys()].join(", ")}`,
      );
    }
  }

  console.log(
    "[secret-parity] checking docker-compose.staging.yml required (${VAR:?}) vars against each deploy workflow's secrets bridge\n",
  );

  let anyMissing = false;
  for (const target of WORKFLOW_TARGETS) {
    const workflowText = readFileSync(target.file, "utf8");
    const secretRefs = parseWorkflowJobSecrets(workflowText, target.job);
    // #994: fold in any file the job delegates its body to (see `alsoScan`). The extracted
    // script is plain shell, not YAML, so the same name-extraction runs over its raw text.
    for (const extraFile of target.alsoScan ?? []) {
      for (const name of extractSecretRefs(readFileSync(extraFile, "utf8"))) {
        secretRefs.add(name);
      }
    }
    const missing = findMissing(requiredByService, secretRefs);
    for (const line of formatReport(target.label, target.job, missing)) console.log(line);
    if (missing.size > 0) anyMissing = true;
  }

  console.log();
  if (anyMissing) {
    console.log(
      "[secret-parity] FAIL — at least one deploy workflow does not bridge every docker-compose.staging.yml required var. " +
        "No values are involved (or at risk) here — this is a structural name-vs-name check only.",
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    "[secret-parity] PASS — both deploy workflows bridge every docker-compose.staging.yml required var.",
  );
}

// Only run when this file is executed directly (`node scripts/check-secret-parity.mjs`)
// — never as a side effect of the self-test importing the pure functions above.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main();
}
