#!/usr/bin/env node
/**
 * THE AUTHORITY LIST MUST NAME ONLY FILES THAT EXIST.
 *
 * `docs/agent/BUILD_RULES.md` names the documents an agent session is required to treat as
 * source of truth. Until 2026-09-04 the two documents at the top of that list were not in the
 * repository at all, so every agent told to obey them read the next-best thing it could open
 * instead. Nothing forced the fourteen phase briefs written from them to reconcile against
 * `docs/decisions/`, and the result was 67 catalogued factual errors across eleven briefs.
 *
 * The fix was to commit the missing documents and rewrite the list. THIS SCRIPT IS WHAT STOPS
 * THAT FIX ROTTING BACK: it extracts every repository path named anywhere in the rules file and
 * asserts each one resolves. A renamed ADR, a moved reference document, or a new entry typed
 * from memory turns CI red and names the line.
 *
 * WHY IT FAILS ON A BARE FILENAME. A token with no directory part (`0036-matching-algorithm-v1.md`)
 * is ambiguous — it could live in any of several directories, and resolving it would mean
 * guessing. Rather than guess, the rules file states that every path in it is written
 * repo-root-relative, and this script enforces that: a bare name that is not a real repo-root
 * file is reported as "write the full path", which is a defect in the rules file, not here.
 *
 * VACUITY IS A FAILURE, NOT A PASS. If the extractor ever stops matching — a Markdown reformat,
 * a change of quoting style — finding nothing would report green while checking nothing. So a
 * run that extracts fewer than MIN_PATHS entries fails and says so. That is the one assertion
 * here that guards the other assertions.
 *
 * Usage:
 *   node scripts/check-authority-paths.mjs                # checks docs/agent/BUILD_RULES.md
 *   node scripts/check-authority-paths.mjs --file <path>  # checks any other rules file
 *   node scripts/check-authority-paths.mjs --json         # machine-readable report
 *
 * Exit 0 = every path resolves. Exit 1 = at least one does not, or the extraction was vacuous.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TARGET = "docs/agent/BUILD_RULES.md";

/**
 * The floor exists to catch a BROKEN EXTRACTOR, not a shrinking rules file. A regex that stops
 * matching would report zero problems over zero paths, which is the shape of a green run that
 * checked nothing.
 *
 * SET FROM A MEASUREMENT, NOT A GUESS: `--json` reports 16 distinct paths in BUILD_RULES.md
 * today. 12 leaves the file room to shed four entries without a CI failure while still being
 * far above what a broken match would produce. The first draft of this file guessed 30 and
 * failed its own first run — which is the argument for the floor existing at all.
 */
const MIN_PATHS = 12;

const EXTENSIONS = ["md", "ts", "tsx", "mjs", "cjs", "js", "yml", "yaml", "json", "sql", "py", "dart"];

/** A path-like token: optional directory segments, then a name with a known extension. */
const FILE_RE = new RegExp(
  String.raw`(?<![\w/.\-])([A-Za-z0-9_][A-Za-z0-9_.\-]*(?:/[A-Za-z0-9_.*\-]+)*\.(?:${EXTENSIONS.join("|")}))(?![\w\-])`,
  "g",
);

/** A directory reference: one of the repo's top-level source trees, ending in a slash. */
const DIR_RE = /(?<![\w/.-])((?:docs|apps|packages|scripts|tests)\/[A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]+)*\/)/g;

/**
 * A DOCUMENT NAME WITH NO DIRECTORY AND NO EXTENSION, e.g. `BadaBhai_MASTER_CONTEXT_2026-07-23`.
 *
 * THIS RULE EXISTS BECAUSE OF A MEASURED MISS. Run against the BUILD_RULES.md that shipped on
 * `main` before 2026-09-04 — the one whose top two entries were not in the repository at all —
 * the path rules above caught source-of-truth #1 and were BLIND to #2, because #2 was written
 * without a `.md`. A gate that catches one of the two documents in the exact incident it was
 * written for is not finished. A name carrying neither a directory nor an extension cannot be
 * resolved, which means it cannot be opened by the agent that was told to obey it.
 *
 * The lookbehind excludes a name that is part of a real path (`docs/reference/Foo_Bar_2026.md`)
 * and the lookahead excludes one carrying an extension, so this fires only on the bare form.
 */
const BARE_DOC_RE = /(?<![\w/.-])([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9-]+){2,})(?![\w./-])/g;

/**
 * SEPARATE A DOCUMENT NAME FROM AN IDENTIFIER, because the underscore shape alone cannot.
 *
 * `BadaBhai_MASTER_CONTEXT_2026-07-23` and `tier_floor_months` have the same shape, and an early
 * draft flagged both — which would have turned this gate red the first time someone wrote a
 * column name or an env var into the rules file, on a line that was perfectly correct. A check
 * that goes red for the wrong reason costs a session and points the reader at innocent text.
 *
 * The two things that make a name a DOCUMENT here, and that no identifier in this codebase has:
 * a trailing date stamp, or a Capitalised word. `OTP_MAX_SENDS_PER_DAY` (screaming snake) and
 * `tier_floor_months` (lower snake) have neither and are deliberately permitted.
 */
function looksLikeDocumentName(name) {
  if (/_\d{4}-\d{2}(-\d{2})?$/.test(name)) return true;
  return /(^|_)[A-Z][a-z]/.test(name);
}

/** Resolve `dir/ *.ext` against the filesystem. A glob must match at least one file. */
function globMatches(rel) {
  const slash = rel.lastIndexOf("/");
  const dir = rel.slice(0, slash);
  const pattern = rel.slice(slash + 1);
  const abs = join(REPO_ROOT, dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return 0;
  const suffix = pattern.replace(/^\*/, "");
  return readdirSync(abs).filter((f) => f.endsWith(suffix)).length;
}

export function extract(text) {
  const found = new Map(); // rel -> first line number
  const bare = new Map(); // document-name-shaped token with no path or extension -> line number
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const re of [FILE_RE, DIR_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        const rel = m[1].replace(/[.,;:]+$/, "");
        if (!found.has(rel)) found.set(rel, i + 1);
      }
    }
    BARE_DOC_RE.lastIndex = 0;
    let d;
    while ((d = BARE_DOC_RE.exec(line)) !== null) {
      if (looksLikeDocumentName(d[1]) && !bare.has(d[1])) bare.set(d[1], i + 1);
    }
  }
  return { found, bare };
}

export function check(text) {
  const { found, bare } = extract(text);
  const problems = [];
  for (const [name, line] of bare) {
    problems.push({
      rel: name,
      line,
      why: "document name with no directory and no extension — write the full repo-relative path",
    });
  }
  for (const [rel, line] of found) {
    if (rel.includes("*")) {
      if (globMatches(rel) === 0) problems.push({ rel, line, why: "glob matches no file" });
      continue;
    }
    if (existsSync(join(REPO_ROOT, rel))) continue;
    problems.push({
      rel,
      line,
      why: rel.includes("/") ? "no such file or directory" : "bare filename — write the full path",
    });
  }
  return { count: found.size, problems };
}

function main(argv) {
  const fileArg = argv.indexOf("--file");
  const target = fileArg === -1 ? DEFAULT_TARGET : argv[fileArg + 1];
  const asJson = argv.includes("--json");

  // resolve(), not join(): `--file` is also given an ABSOLUTE path when this gate is run as a
  // control against another checkout's rules file. Paths found INSIDE the file still resolve
  // against REPO_ROOT, because the question is always "do these exist in this repository".
  const targetAbs = resolve(REPO_ROOT, target);
  if (!existsSync(targetAbs)) {
    console.error(`check-authority-paths: cannot read ${target}`);
    return 1;
  }

  const { count, problems } = check(readFileSync(targetAbs, "utf8"));
  const vacuous = count < MIN_PATHS;

  if (asJson) {
    console.log(JSON.stringify({ target, count, vacuous, problems }, null, 2));
  } else if (problems.length === 0 && !vacuous) {
    console.log(`check-authority-paths: ${count} paths named in ${target}, all resolve.`);
  } else {
    for (const p of problems) console.error(`  ${target}:${p.line}  ${p.rel} — ${p.why}`);
    if (vacuous) {
      console.error(
        `  extracted only ${count} paths (floor ${MIN_PATHS}) — the extractor matched almost ` +
          `nothing, so this run checked almost nothing. Treat as a failure of this script.`,
      );
    }
    console.error(
      `\ncheck-authority-paths: ${problems.length} unresolved path(s) in ${target}.\n` +
        `Every document named as a source of truth must be openable from a clean checkout.`,
    );
  }
  return problems.length === 0 && !vacuous ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-authority-paths.mjs")) {
  process.exit(main(process.argv.slice(2)));
}
