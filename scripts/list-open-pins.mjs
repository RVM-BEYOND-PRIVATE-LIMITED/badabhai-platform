#!/usr/bin/env node
// scripts/list-open-pins.mjs
//
// WHAT AN OPEN PIN IS. A gap this repository has already measured, written down as an
// executable assertion, and left red-on-close: an `it.fails`, a `pytest.mark.xfail`, a
// corpus row carrying its measured-wrong value, or a table row whose `gap` differs from
// its `want`. Closing one is a required visible edit, never a silent improvement.
//
// WHY THIS SCRIPT EXISTS (R13 §4). `sal_004` pinned the missing `hazaar` spelling, wrote
// down exactly what the detector did instead, and predicted that closing it would turn the
// row red. Months later a packet "discovered" the same gap, closed it, watched the pinned
// row go red — and reported the whole thing as a find. The record was correct, current, and
// unconsulted. That is the failure mode of every ledger nobody reads, and the fix is not a
// better ledger: it is a command that puts the relevant rows in front of you before you
// start, filtered to the files you are about to change.
//
// USAGE
//   node scripts/list-open-pins.mjs                  # pins gating this branch's changed files
//   node scripts/list-open-pins.mjs apps/api/src/resume packages/profiling-lexicon
//   node scripts/list-open-pins.mjs --all            # every open pin, unfiltered
//   node scripts/list-open-pins.mjs --json           # machine-readable
//
// FAIL-CLOSED, AND THAT IS THE WHOLE DESIGN. A provider that cannot run reports UNAVAILABLE
// and the process exits non-zero. An empty list must mean "there are no pins here", never
// "the reader was broken" — the same rule the detectors themselves are held to: a fixture
// must contain the thing the detector detects, and a zero must be capable of being non-zero.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Repo-relative, forward-slashed — the form `git diff --name-only` prints. */
const rel = (abs) => relative(REPO, abs).split(sep).join("/");

// ─────────────────────────────────────────────────────────────────────────────────────────
// Where each kind of pin's SUBJECT lives
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Corpus row id prefix -> the files that row is evidence about.
 *
 * The corpus is shared between two engines, so a pinned row gates FOUR files: the canonical
 * lexicon JSON, the Python implementation, the TypeScript port, and the corpus itself. This
 * table is the one hand-maintained thing in the script; a prefix missing from it degrades to
 * the corpus file alone, which is why `--all` still lists the row rather than dropping it.
 */
const CORPUS_PREFIX_SUBJECTS = {
  sal: [
    "packages/profiling-lexicon/data/salary.json",
    "packages/profiling-lexicon/src/values/salary.ts",
    "apps/ai-service/app/profiling/signals.py",
  ],
  salp: [
    "packages/profiling-lexicon/data/salary.json",
    "packages/profiling-lexicon/src/values/salary.ts",
    "apps/ai-service/app/profiling/signals.py",
  ],
  exp: [
    "packages/profiling-lexicon/data/experience.json",
    "packages/profiling-lexicon/src/values/experience.ts",
    "apps/ai-service/app/profiling/signals.py",
  ],
  dev: [
    "packages/profiling-lexicon/data/predicates.json",
    "packages/profiling-lexicon/src/predicates",
    "apps/ai-service/app/profiling/predicates.py",
  ],
};

/** A corpus `note` that records an OPEN gap. `CLOSED` anywhere in the note retires it. */
const PIN_NOTE = /\bpinned\b|\bmeasured gap\b|\bknown gap\b|\buncovered\b|\bdeliberately not\b/i;

// ─────────────────────────────────────────────────────────────────────────────────────────
// Provider 1/2 — assertions that are red until the gap closes
// ─────────────────────────────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".venv",
  "__pycache__",
  ".turbo",
  "coverage",
]);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else if (entry.isFile()) {
      yield join(dir, entry.name);
    }
  }
}

/**
 * The repo files a test file imports — its SUBJECT, derived rather than declared.
 *
 * A pin is filed against the thing it constrains, not the file it happens to live in, so
 * `yadav-parity.contract.test.ts` gating `resume-render-input.ts` is what makes it surface
 * when a packet edits the mapper. Relative TS imports are resolved against the extension
 * conventions this repo actually uses (`.js` specifiers resolving to `.ts` sources);
 * `app.x.y` Python imports map onto `apps/ai-service/app/x/y.py`.
 */
function importedSubjects(file, source) {
  const subjects = new Set();
  const here = dirname(file);
  for (const m of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
    const spec = m[1].replace(/\.js$/, "");
    for (const candidate of [`${spec}.ts`, `${spec}.tsx`, `${spec}/index.ts`, spec]) {
      const abs = resolve(here, candidate);
      if (existsSync(abs) && statSync(abs).isFile()) {
        subjects.add(rel(abs));
        break;
      }
    }
  }
  for (const m of source.matchAll(/^\s*from\s+(app(?:\.[a-z_]+)*)\s+import\s+/gm)) {
    const base = `apps/ai-service/${m[1].split(".").join("/")}`;
    for (const candidate of [`${base}.py`, `${base}/__init__.py`]) {
      if (existsSync(join(REPO, candidate))) {
        subjects.add(candidate);
        break;
      }
    }
  }
  return [...subjects];
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

/** `it.fails(...)` / `it.todo(...)` — a TypeScript assertion that is red until built. */
function providerVitest() {
  const pins = [];
  for (const abs of walk(join(REPO, "apps"))) {
    if (!/\.test\.tsx?$/.test(abs)) continue;
    const src = readFileSync(abs, "utf8");
    if (!src.includes("it.fails(") && !src.includes("it.todo(")) continue;
    const subjects = importedSubjects(abs, src);
    for (const m of src.matchAll(/\bit\.(fails|todo)\(\s*(["'`])((?:\\.|(?!\2).)*)\2/g)) {
      pins.push({
        source: "vitest",
        id: `${rel(abs)}:${lineOf(src, m.index)}`,
        title: m[3],
        why: `it.${m[1]} — passes only once the behaviour exists`,
        gates: [rel(abs), ...subjects],
      });
    }
  }
  return pins;
}

/** `@pytest.mark.xfail(...)` — the same shape on the Python side. */
function providerPytest() {
  const pins = [];
  for (const abs of walk(join(REPO, "apps", "ai-service", "tests"))) {
    if (!abs.endsWith(".py")) continue;
    const src = readFileSync(abs, "utf8");
    if (!src.includes("@pytest.mark.xfail")) continue;
    const subjects = importedSubjects(abs, src);
    for (const m of src.matchAll(/@pytest\.mark\.xfail\(/g)) {
      // Scan forward to the decorated `def`, rather than matching a bounded blob between the
      // two. THE FIRST VERSION CAPPED THE DECORATOR AT 400 CHARACTERS AND FOUND NOTHING —
      // the one xfail in this repo carries a 700-character reason, so the provider reported
      // a clean zero on a file that had a pin in it. That is the vacuous detector again, in
      // the tool built to stop people missing pins.
      const defAt = src.indexOf("\ndef ", m.index);
      if (defAt === -1) continue;
      const decorator = src.slice(m.index, defAt);
      const name = /^\ndef\s+(\w+)/.exec(src.slice(defAt))?.[1] ?? "(unnamed)";
      // A `reason=` is routinely a parenthesised run of adjacent string literals; take them
      // all, in order, or the reason truncates at the first line break.
      const after = decorator.slice(decorator.indexOf("reason"));
      const reason = [...after.matchAll(/"([^"]*)"|'([^']*)'/g)]
        .map((lit) => lit[1] ?? lit[2])
        .join("");
      pins.push({
        source: "pytest",
        id: `${rel(abs)}:${lineOf(src, m.index)}`,
        title: name,
        why: reason.replace(/\s+/g, " ").slice(0, 200) || "xfail",
        gates: [rel(abs), ...subjects],
      });
    }
  }
  return pins;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Provider 3 — the shared corpus
// ─────────────────────────────────────────────────────────────────────────────────────────

function providerCorpus() {
  const dir = join(REPO, "packages", "profiling-lexicon", "__fixtures__");
  const pins = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const abs = join(dir, name);
    const lines = readFileSync(abs, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      const row = JSON.parse(line);
      const note = row.note ?? "";
      if (!PIN_NOTE.test(note) || /\bCLOSED\b/.test(note)) return;
      const prefix = String(row.id ?? "").split("_")[0];
      pins.push({
        source: "corpus",
        id: `${row.id} (${rel(abs)}:${i + 1})`,
        title: row.text ?? "",
        why: note.replace(/\s+/g, " ").slice(0, 200),
        // THE UNTRUNCATED NOTE, and it is not a nicety. `why` is capped at 200 characters for
        // the listing, and the first alias this script grew sat at character 340 — so the fold
        // silently did not happen and the duplicate it was written to remove stayed on the page.
        // Aliases are read from here; display still reads `why`.
        raw: note.replace(/\s+/g, " "),
        gates: [rel(abs), ...(CORPUS_PREFIX_SUBJECTS[prefix] ?? [])],
      });
    });
  }
  return pins;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Provider 4 — table-driven gap suites
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Any Python test module exposing `pinned_gaps()` opts in by defining that function.
 *
 * Greppable on purpose: a new table suite joins by writing one function, and this script
 * finds it without a registry that somebody has to remember to update — which is the exact
 * failure this whole file is a response to.
 */
function pythonExe() {
  const candidates = [
    join(REPO, "apps", "ai-service", ".venv", "Scripts", "python.exe"),
    join(REPO, "apps", "ai-service", ".venv", "bin", "python"),
    join(REPO, ".venv", "Scripts", "python.exe"),
    join(REPO, ".venv", "bin", "python"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function providerPythonTables() {
  const testsDir = join(REPO, "apps", "ai-service", "tests");
  const modules = [];
  for (const abs of walk(testsDir)) {
    if (!abs.endsWith(".py")) continue;
    if (readFileSync(abs, "utf8").includes("def pinned_gaps(")) {
      modules.push({
        abs,
        module: `tests.${abs
          .slice(testsDir.length + 1, -3)
          .split(sep)
          .join(".")}`,
      });
    }
  }
  if (modules.length === 0) return [];

  const exe = pythonExe();
  if (exe === null) {
    // Fail closed and say so. Reporting zero here would be the vacuous-detector bug this
    // repo has now shipped five times: an absence that is indistinguishable from a break.
    throw new Error(
      "no ai-service virtualenv found, so table-driven gap suites could not be read " +
        `(${modules.map((m) => m.module).join(", ")}). Create apps/ai-service/.venv or run ` +
        "with --skip-python and treat the list as incomplete.",
    );
  }

  const script = [
    "import importlib, json, sys",
    "out = []",
    "for name in sys.argv[1:]:",
    "    mod = importlib.import_module(name)",
    "    for pin in mod.pinned_gaps():",
    "        pin['module'] = name",
    "        out.append(pin)",
    "print(json.dumps(out))",
  ].join("\n");

  const stdout = execFileSync(exe, ["-c", script, ...modules.map((m) => m.module)], {
    cwd: join(REPO, "apps", "ai-service"),
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: join(REPO, "apps", "ai-service"), PYTHONIOENCODING: "utf8" },
  });

  return JSON.parse(stdout).map((pin) => ({
    source: "table",
    id: `${pin.module}::${pin.id}`,
    title: pin.title ?? "",
    why: pin.why ?? "",
    gates: pin.gates ?? [],
  }));
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Filtering and output
// ─────────────────────────────────────────────────────────────────────────────────────────

/** What this packet is about to touch: the branch's diff against main, plus the worktree. */
function changedPaths() {
  const run = (args) => {
    try {
      return execFileSync("git", args, { cwd: REPO, encoding: "utf8" });
    } catch {
      return "";
    }
  };
  const paths = new Set();
  for (const line of run(["diff", "--name-only", "origin/main...HEAD"]).split("\n")) {
    if (line.trim()) paths.add(line.trim());
  }
  for (const line of run(["status", "--porcelain"]).split("\n")) {
    const p = line.slice(3).trim();
    if (p) paths.add(p.replace(/^.* -> /, ""));
  }
  return [...paths];
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// De-duplication — one gap, however many places record it (R14 §5)
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * `SAME GAP AS <pin>` folds this pin into that one. `SEE ALSO <pin>` keeps both and links them.
 *
 * WHY THIS EXISTS. The first run of this script against R13's paths reported twenty pins, and
 * two pairs of them were one gap each: `sp_hajar`/`sp_hazzar` in the pytest table and
 * `sal_018`/`sal_019` in the shared corpus are the same two missing spellings, recorded once per
 * mechanism because the two mechanisms were built a packet apart. Nobody would have noticed from
 * either end — each register is internally consistent — and the cost is not tidiness: a list that
 * says twenty when it means eighteen is a list whose count nobody can act on, and the two extra
 * rows read as two extra pieces of work.
 *
 * FAIL CLOSED ON A DANGLING REFERENCE. An alias naming a pin that no longer exists is worse than
 * no alias: it silently deletes a pin from the listing. `resolveAliases` reports it as an
 * unavailable provider would be reported, and the process exits non-zero.
 */
const ALIAS_RE = /\b(SAME GAP AS|SEE ALSO)\s+([A-Za-z0-9_.:]+)/g;

/** Does `pin` answer to `ref` — its full id, its trailing `::case`, or its corpus row id? */
function pinAnswersTo(pin, ref) {
  if (pin.id === ref) return true;
  if (pin.id.endsWith(`::${ref}`)) return true;
  // Corpus ids are rendered `sal_018 (path:line)`.
  return pin.id.split(" ")[0] === ref;
}

export function resolveAliases(pins) {
  const dangling = [];
  const merged = new Map(pins.map((pin) => [pin.id, { ...pin, alsoAt: [], seeAlso: [] }]));
  const folded = new Set();

  for (const pin of pins) {
    for (const [, kind, ref] of (pin.raw ?? pin.why).matchAll(ALIAS_RE)) {
      const target = pins.find((other) => other !== pin && pinAnswersTo(other, ref));
      if (target === undefined) {
        dangling.push(`${pin.id} names "${ref}", which is not an open pin`);
        continue;
      }
      if (kind === "SEE ALSO") {
        merged.get(target.id).seeAlso.push(pin.id);
        merged.get(pin.id).seeAlso.push(target.id);
        continue;
      }
      // SAME GAP AS — the referencing pin folds into the target, and its gated files come with
      // it so path filtering still surfaces the gap from either side.
      const into = merged.get(target.id);
      into.alsoAt.push(pin.id);
      into.gates = [...new Set([...into.gates, ...pin.gates])];
      folded.add(pin.id);
    }
  }
  return { pins: [...merged.values()].filter((pin) => !folded.has(pin.id)), dangling };
}

/** A pin matches when any file it gates sits under any of the given paths (or vice versa). */
export function pinsTouching(pins, paths) {
  if (paths.length === 0) return [];
  return pins.filter((pin) =>
    pin.gates.some((gate) =>
      paths.some((p) => gate === p || gate.startsWith(`${p}/`) || p.startsWith(`${gate}/`)),
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Provider 5 — ALLOWLIST ROWS (R16 §0)
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * An allowlist row is a pin that does not look like one.
 *
 * THE INCIDENT. `branch-parity.audit.test.ts` carried a row reading "no pack asks for axes yet".
 * True when written; false four days later when `qp_vmc_milling` shipped asking exactly that. A
 * pin gets read every time somebody runs `pnpm pins`; an allowlist row is read when somebody
 * happens to open the file it lives in, which is approximately never. The suppression outlived
 * its justification in silence — the same failure the pin ledger exists to prevent, one layer
 * down.
 *
 * So allowlist rows are collected HERE, beside the pins, and each must state the OBSERVABLE that
 * would flip it. A row with no `falsifiedBy` is not listed and not ignored: it THROWS, so the
 * provider is unavailable and `collectPins` reports it — the same fail-closed shape
 * `providerPythonTables` uses for a missing venv. Reporting a suppression as absent would be the
 * vacuous-detector bug in the tool built to stop it.
 *
 * WHAT COUNTS AS AN ALLOWLIST is a naming convention, deliberately: a `const` whose name ends in
 * `ALLOWED`, `ALLOWLIST` or `_ON_PURPOSE`. A convention is checkable and a comment is not, and
 * the alternative — every file registering itself somewhere — is one more list to go stale.
 */
function providerAllowlists() {
  const pins = [];
  const missing = [];
  for (const abs of walk(join(REPO, "apps"))) {
    if (!/\.test\.tsx?$/.test(abs)) continue;
    // BLANKED ONCE, HERE, AND BOTH WALKERS READ THE BLANKED TEXT. Two bugs came from getting
    // this wrong. `balanced` treated the apostrophe in a comment's `worker's` as a string
    // opener and scanned past the closing brace, so every allowlist in this file parsed to
    // nothing and the provider reported a confident zero. `topLevelEntries` split on a comma
    // inside a comment and invented a member called `and that is the finding`.
    //
    // `blankComments` preserves LENGTH and preserves STRING literals, so offsets stay valid and
    // `reason` / `falsifiedBy` are still extractable from the blanked text.
    const code = blankComments(readFileSync(abs, "utf8"));
    for (const m of code.matchAll(
      // No prefix requirement before the suffix — the first version demanded at least one
      // character before `ALLOWED`, so the constant actually named `ALLOWED` never matched and
      // only `RUNTIME_ALLOWED` was seen.
      /const\s+([\w$]*(?:ALLOWED|ALLOWLIST|_ON_PURPOSE))\s*:[^=]*=\s*\{/g,
    )) {
      const open = code.indexOf("{", m.index + m[0].length - 1);
      const body = balanced(code, open);
      if (body === null) continue;
      for (const entry of topLevelEntries(body)) {
        // A row whose value is a bare string cannot carry a falsifier at all — that is the old
        // shape, and it is exactly what R16 §0 replaces.
        if (!/falsifiedBy\s*:/.test(entry.value)) {
          missing.push(`${rel(abs)} ${m[1]}.${entry.key}`);
          continue;
        }
        pins.push({
          source: "allowlist",
          id: `${m[1]}.${entry.key}`,
          title: `${rel(abs)}:${lineOf(code, m.index)}`,
          why:
            `SUPPRESSED — ${fieldText(entry.value, "reason") || "no reason given"}` +
            ` | FALSIFIED BY: ${fieldText(entry.value, "falsifiedBy") || "(unparsed)"}`,
          raw: entry.value,
          gates: [rel(abs)],
        });
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      "allowlist row(s) state no `falsifiedBy`, so the suppression has no expiry and cannot be " +
        `checked: ${missing.join(", ")}. R16 §0 — every allowlist entry says what would make it ` +
        "false.",
    );
  }
  return pins;
}

/** The only two fields `fieldText` is ever asked for — literal, so no pattern is built. */
const FIELD_HEAD = {
  reason: /\breason\s*:/,
  falsifiedBy: /\bfalsifiedBy\s*:/,
};

/**
 * The full string value of `field:` inside an object-literal chunk.
 *
 * ADJACENT LITERALS ARE JOINED, and that is not a nicety: prettier wraps any reason longer than
 * the print width into `"..." + "..."`, and reading only the first literal truncated the
 * falsifier mid-sentence — the ledger then showed a condition that stopped before saying what
 * the condition was. Same failure `providerPytest` already had to fix for `reason=`.
 */
function fieldText(chunk, field) {
  // LITERAL PATTERNS, NOT an interpolated `new RegExp`. The interpolated form tripped
  // semgrep's detect-non-literal-regexp, and it was right to: the field set here is closed
  // and known, so building a pattern at run time bought nothing and put a template string on
  // the regex path. Two entries, both literal.
  const at = FIELD_HEAD[field]?.exec(chunk) ?? null;
  if (at === null) return "";
  // Stop at the next top-level `key:` so a later field's text cannot be absorbed.
  const rest = chunk.slice(at.index + at[0].length);
  const nextKey = /,\s*[A-Za-z_$][\w$]*\s*:/.exec(rest);
  const slice = nextKey === null ? rest : rest.slice(0, nextKey.index);
  return [...slice.matchAll(/"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|`((?:\\.|[^`])*)`/g)]
    .map((lit) => lit[1] ?? lit[2] ?? lit[3] ?? "")
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** The body of the `{...}` opening at `open`, or null when unbalanced. Strings are skipped. */
function balanced(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i += 1;
      while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * `key: value` members at depth 0. Quoted keys are unquoted.
 *
 * COMMENTS ARE BLANKED FIRST, and that ordering is the bug this had. Splitting on `,` before
 * stripping comments turns every comma INSIDE a comment into a member boundary, so the tail of a
 * prose sentence becomes a "key": the first run reported an entry called
 * `SHARED_ON_PURPOSE.and that is the finding` from an object that is empty apart from its note.
 * Blanking preserves length, so the depth walk below still sees the real braces.
 */
function topLevelEntries(rawBody) {
  // Idempotent: the allowlist provider hands in already-blanked text, and blanking it twice is
  // a no-op. Kept so the function is correct for any caller, not only that one.
  const body = blankComments(rawBody);
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === '"' || c === "'" || c === "`") {
      i += 1;
      while (i < body.length && body[i] !== c) i += body[i] === "\\" ? 2 : 1;
      continue;
    }
    if ("{[(".includes(c)) depth += 1;
    else if ("}])".includes(c)) depth -= 1;
    else if (c === "," && depth === 0) {
      pushEntry(out, body.slice(start, i));
      start = i + 1;
    }
  }
  pushEntry(out, body.slice(start));
  return out;
}

/** Replace comment bodies with spaces, preserving length so brace depth still holds. */
function blankComments(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === "//") {
      const nl = text.indexOf("\n", i);
      const stop = nl === -1 ? text.length : nl;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    if (two === "/*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (let k = i; k < stop; k += 1) out += text[k] === "\n" ? "\n" : " ";
      i = stop;
      continue;
    }
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      out += c;
      i += 1;
      while (i < text.length && text[i] !== c) {
        if (text[i] === "\\") {
          out += text[i];
          i += 1;
        }
        out += text[i] ?? "";
        i += 1;
      }
      out += text[i] ?? "";
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function pushEntry(out, chunk) {
  const cleaned = chunk.trim();
  if (!cleaned) return;
  const at = cleaned.indexOf(":");
  if (at === -1) return;
  const key = cleaned
    .slice(0, at)
    .trim()
    .replace(/^["'`]|["'`]$/g, "");
  if (!key) return;
  out.push({ key, value: cleaned.slice(at + 1).trim() });
}

export const PROVIDERS = {
  vitest: providerVitest,
  pytest: providerPytest,
  corpus: providerCorpus,
  table: providerPythonTables,
  allowlist: providerAllowlists,
};

export function collectPins({ skipPython = false } = {}) {
  const pins = [];
  const unavailable = [];
  for (const [name, provider] of Object.entries(PROVIDERS)) {
    if (skipPython && name === "table") {
      unavailable.push(`${name}: skipped by --skip-python`);
      continue;
    }
    try {
      pins.push(...provider());
    } catch (error) {
      unavailable.push(`${name}: ${error.message}`);
    }
  }
  // R14 §5 — collapse the registers AFTER every provider has run, never inside one: the two
  // halves of a duplicated gap live in different providers by definition.
  const { pins: deduped, dangling } = resolveAliases(pins);
  for (const line of dangling) unavailable.push(`alias: ${line}`);
  return { pins: deduped, unavailable };
}

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const paths = argv.filter((a) => !a.startsWith("--"));
  const { pins, unavailable } = collectPins({ skipPython: flags.has("--skip-python") });

  const scope = flags.has("--all") ? null : paths.length > 0 ? paths : changedPaths();
  const shown = scope === null ? pins : pinsTouching(pins, scope);

  if (flags.has("--json")) {
    process.stdout.write(
      `${JSON.stringify({ pins: shown, total: pins.length, unavailable }, null, 2)}\n`,
    );
  } else {
    const header =
      scope === null
        ? `${pins.length} open pins (all)`
        : `${shown.length} of ${pins.length} open pins touch ${scope.length} path(s)`;
    process.stdout.write(`\n${header}\n${"─".repeat(Math.max(header.length, 40))}\n`);
    // DERIVED FROM `PROVIDERS`, NOT LISTED. This was a hardcoded array, and adding the
    // allowlist provider made its rows collectable, countable and INVISIBLE: the header said
    // "23 open pins" while the body printed the four groups the list happened to name. A
    // ledger that silently omits a category is worse than one that omits nothing, because the
    // count says otherwise.
    for (const group of Object.keys(PROVIDERS)) {
      const rows = shown.filter((p) => p.source === group);
      if (rows.length === 0) continue;
      process.stdout.write(`\n[${group}]\n`);
      for (const pin of rows) {
        process.stdout.write(`  ${pin.id}\n`);
        if (pin.title) process.stdout.write(`      ${pin.title}\n`);
        if (pin.why) process.stdout.write(`      ${pin.why}\n`);
        // The same gap, recorded elsewhere. Printed rather than hidden: the point of folding is
        // one COUNT, not one location — closing this gap means editing every line named here.
        for (const also of pin.alsoAt ?? []) {
          process.stdout.write(`      also recorded at ${also}\n`);
        }
        for (const link of pin.seeAlso ?? []) {
          process.stdout.write(`      see also ${link}\n`);
        }
      }
    }
    if (shown.length === 0) process.stdout.write("\n  (none)\n");
    process.stdout.write("\n");
  }

  if (unavailable.length > 0) {
    for (const line of unavailable) process.stderr.write(`UNAVAILABLE ${line}\n`);
    process.stderr.write(
      "The list above is INCOMPLETE — a provider could not run, and an absence it would " +
        "have reported is indistinguishable from a break.\n",
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
