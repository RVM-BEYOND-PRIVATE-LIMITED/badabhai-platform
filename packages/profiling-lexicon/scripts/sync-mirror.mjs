#!/usr/bin/env node
/**
 * Sync (or verify) the two GENERATED artifacts built from `data/`, the canonical lexicon.
 *
 *   node scripts/sync-mirror.mjs           # write both artifacts
 *   node scripts/sync-mirror.mjs --check   # verify only; exit 1 on any drift
 *
 *   1. apps/ai-service/app/profiling/lexicon_data/*.json  — the Python mirror
 *   2. src/internal/data.generated.ts                     — the TypeScript embedding
 *
 * WHY A MIRROR EXISTS AT ALL — this is the part worth reading before "simplifying" it.
 *
 * `apps/ai-service/Dockerfile` builds from the `apps/ai-service` context ONLY. `packages/` is
 * not in the build context, and the Dockerfile header states the package "reads nothing outside
 * itself". So a runtime `parents[3] / "packages" / "profiling-lexicon" / "data"` read works on a
 * laptop and in CI and then ImportErrors on boot in staging and production.
 * `apps/ai-service/tests/test_contract_parity.py` reaches across the repo exactly that way and is
 * fine — because tests are never copied into the image. `signals.py` is runtime code.
 *
 * The mirror lands under `app/`, which the Dockerfile already COPYs wholesale, so the image needs
 * no change and the deploy story stays "COPY app ./app".
 *
 * Duplication is only safe when drift is mechanically impossible, so it is checked from BOTH
 * sides, in two different CI jobs on purpose:
 *
 *   pnpm lexicon:verify              node job       (path filter: packages/**)
 *   tests/test_lexicon_parity.py     ai-service job (path filter: apps/ai-service/**)
 *
 * Whichever side of the pair a change touches, at least one gate fires. `ci.yml` additionally
 * lists `packages/profiling-lexicon/**` in the ai-service filter so a canonical-only edit still
 * runs pytest.
 *
 * Compared as TEXT, not as parsed JSON, and only line endings are normalized (see `readLf`). A
 * reformat is drift too — `git diff` on the mirror should be reviewable line by line against the
 * canonical diff in the same commit. Comparing parsed objects would let a reindent through and
 * make the two diffs impossible to read side by side.
 *
 * WHY THE TYPESCRIPT SIDE IS GENERATED RATHER THAN READ FROM DISK
 * --------------------------------------------------------------
 * `data/` sits outside the package's `rootDir`, so it cannot simply be `import`ed as JSON. The
 * alternative — reading it at runtime with `node:fs` — needs a directory anchor, and there is no
 * single expression that resolves correctly in all four places this package runs: the CommonJS
 * build output (`__dirname`), the Vitest ESM transform (`import.meta.url`, which `module:
 * CommonJS` refuses to compile), a bundled NestJS deploy, and a consumer that hoists the package
 * to a different node_modules depth. Embedding removes the entire class of problem: there is no
 * path to resolve, no file to ship, and no runtime failure mode.
 *
 * The embedding stores the RAW FILE TEXT, not a re-serialized object, so `--check` can assert it
 * against `data/` exactly like the Python mirror — one rule, both artifacts.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Read a file as text with LF line endings, whatever the working tree has.
 *
 * EVERY comparison and every generated artifact goes through this, and it is not cosmetic.
 * `.gitattributes` sets `* text=auto eol=lf`, so the repo stores LF and a Linux CI checkout has
 * LF — but a Windows working tree can still hold CRLF for a file git has not normalized yet.
 * A raw byte compare would then pass on one machine and fail on the other, and the TypeScript
 * embedding is worse: it stores the file text INSIDE a string literal, so a CRLF checkout bakes
 * `\r\n` into the committed artifact and CI regenerates `\n` and reports drift that is not real.
 *
 * Normalizing here makes the invariant "identical after LF normalization", which is the
 * invariant that actually matters and the only one that is stable across platforms.
 */
function readLf(path) {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");

const CANONICAL_DIR = join(PACKAGE_ROOT, "data");
const MIRROR_DIR = join(REPO_ROOT, "apps", "ai-service", "app", "profiling", "lexicon_data");
const GENERATED_TS = join(PACKAGE_ROOT, "src", "internal", "data.generated.ts");

/** Relative to the repo root, for messages a human has to act on. */
const CANONICAL_LABEL = "packages/profiling-lexicon/data";
const MIRROR_LABEL = "apps/ai-service/app/profiling/lexicon_data";
const GENERATED_TS_LABEL = "packages/profiling-lexicon/src/internal/data.generated.ts";

/**
 * Render the TypeScript embedding. Each file's RAW TEXT goes in as a string literal, so the
 * check below is the same byte comparison the Python mirror gets.
 */
function renderGeneratedTs(names) {
  const entries = names
    .map((name) => {
      const text = readLf(join(CANONICAL_DIR, name));
      const key = name.replace(/\.json$/, "");
      return `  ${JSON.stringify(key)}: ${JSON.stringify(text)},`;
    })
    .join("\n");

  return `// GENERATED by scripts/sync-mirror.mjs — DO NOT EDIT.
//
// Raw text of every file in ${CANONICAL_LABEL}/, embedded so the lexicon needs no runtime
// path resolution. Edit the JSON there, then run \`pnpm lexicon:sync\` and commit both.
//
// Stored as text rather than as object literals for two reasons: \`pnpm lexicon:verify\`
// compares it against the canonical files, and \`JSON.parse\` yields exactly
// what Python's \`json.loads\` yields on the same bytes — which is the property the
// dual-language parity corpus depends on.

const RAW_LEXICON_FILES: Readonly<Record<string, string>> = {
${entries}
};

/** Parse one lexicon file by stem. Throws on an unknown stem rather than returning \`{}\`. */
export function readLexiconFile<T>(stem: string): T {
  const raw = RAW_LEXICON_FILES[stem];
  if (raw === undefined) {
    throw new Error(
      \`unknown profiling-lexicon file "\${stem}" — known: \${Object.keys(RAW_LEXICON_FILES).join(", ")}\`,
    );
  }
  return JSON.parse(raw) as T;
}

/** Every embedded stem, for the parity tests that walk all files. */
export const LEXICON_FILE_STEMS: readonly string[] = Object.keys(RAW_LEXICON_FILES);
`;
}

const README_NAME = "README.md";

/**
 * The mirror README is generated, not synced — it says something different from the canonical
 * one (namely "do not edit this directory"), so it is excluded from the comparison below.
 */
const MIRROR_README = `# GENERATED — do not edit

Byte-identical mirror of \`${CANONICAL_LABEL}/\`, which is the source of truth.

It exists because the ai-service image is built from the \`apps/ai-service\` context only, so
\`packages/\` does not exist at runtime in the container. See
\`packages/profiling-lexicon/scripts/sync-mirror.mjs\` for the full reasoning.

## Changing lexicon data

1. Edit the file under \`${CANONICAL_LABEL}/\`.
2. Run \`pnpm lexicon:sync\`.
3. Commit **both** directories in the same commit.

\`pnpm lexicon:verify\` and \`apps/ai-service/tests/test_lexicon_parity.py\` both fail if these
two directories disagree, so a half-committed change cannot merge.
`;

/** Canonical `.json` filenames, sorted so output order is stable across platforms. */
function canonicalFiles() {
  if (!existsSync(CANONICAL_DIR)) {
    fail(`canonical directory missing: ${CANONICAL_LABEL}`);
  }
  return readdirSync(CANONICAL_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function mirrorFiles() {
  if (!existsSync(MIRROR_DIR)) return [];
  return readdirSync(MIRROR_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function fail(message) {
  console.error(`lexicon-mirror: ${message}`);
  process.exit(1);
}

function check() {
  const canonical = canonicalFiles();
  const mirrored = mirrorFiles();
  const problems = [];

  if (canonical.length === 0) {
    fail(`no .json files in ${CANONICAL_LABEL} — refusing to "verify" an empty corpus`);
  }

  for (const name of mirrored) {
    if (!canonical.includes(name)) {
      problems.push(`${name}: present in the mirror but not in ${CANONICAL_LABEL} (stale copy)`);
    }
  }

  for (const name of canonical) {
    const mirrorPath = join(MIRROR_DIR, name);
    if (!existsSync(mirrorPath)) {
      problems.push(`${name}: missing from the mirror`);
      continue;
    }
    const want = readLf(join(CANONICAL_DIR, name));
    const got = readLf(mirrorPath);
    if (want !== got) {
      problems.push(`${name}: mirror differs from canonical (${want.length} vs ${got.length} chars)`);
    }
  }

  if (!existsSync(GENERATED_TS)) {
    problems.push(`${GENERATED_TS_LABEL}: missing`);
  } else if (readLf(GENERATED_TS) !== renderGeneratedTs(canonical)) {
    problems.push(`${GENERATED_TS_LABEL}: stale — does not match ${CANONICAL_LABEL}`);
  }

  if (problems.length > 0) {
    console.error(
      `lexicon-mirror: ${problems.length} problem(s) — run \`pnpm lexicon:sync\` and commit every generated file.\n`,
    );
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  console.log(
    `lexicon-mirror: OK — ${canonical.length} file(s) identical in ${MIRROR_LABEL}, TS embedding current`,
  );
}

function sync() {
  const canonical = canonicalFiles();
  mkdirSync(MIRROR_DIR, { recursive: true });

  // Remove stale mirrored files first. Renaming a canonical file must not leave the old copy
  // behind for `lexicon.py` to keep reading.
  for (const name of mirrorFiles()) {
    if (!canonical.includes(name)) {
      rmSync(join(MIRROR_DIR, name));
      console.log(`lexicon-mirror: removed stale ${name}`);
    }
  }

  let written = 0;
  for (const name of canonical) {
    const want = readLf(join(CANONICAL_DIR, name));
    const mirrorPath = join(MIRROR_DIR, name);
    if (existsSync(mirrorPath) && readLf(mirrorPath) === want) continue;
    writeFileSync(mirrorPath, want);
    written += 1;
    console.log(`lexicon-mirror: wrote ${name}`);
  }

  writeFileSync(join(MIRROR_DIR, README_NAME), MIRROR_README);

  const generated = renderGeneratedTs(canonical);
  mkdirSync(dirname(GENERATED_TS), { recursive: true });
  if (!existsSync(GENERATED_TS) || readLf(GENERATED_TS) !== generated) {
    writeFileSync(GENERATED_TS, generated);
    console.log(`lexicon-mirror: wrote ${GENERATED_TS_LABEL}`);
  }

  console.log(`lexicon-mirror: ${written} file(s) updated, ${canonical.length} in sync`);
}

if (process.argv.includes("--check")) check();
else sync();
