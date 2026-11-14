import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { stripComments } from "./lifecycle-writer-scan";

/**
 * #2746 — THE AUDIENCE RULE HAS ONE SPELLING, AND NO SWITCH.
 *
 * (1) ONE SPELLING. `job-visibility.ts` is the only place "which audiences reach a BadaBhai
 *     worker" is written. A second spelling — an `audience <> 'rvm_students'` in some read, an
 *     `eq(jobPostings.audience, …)` in a service — is how an RVM-only job leaks the day a fourth
 *     audience lands or one copy is edited. So every non-test source under `apps/api/src` and
 *     `packages/db/src` is swept for an audience literal or an audience comparison, comments
 *     stripped, and every hit must be on the ALLOW-LIST below with its reason. The list is driven
 *     both ways (the ops-guard-adoption pattern): a listed file that no longer hits is a stale
 *     entry and fails too.
 *
 * (2) NO SWITCH (security review of PR 2, finding M2). The rollout switch for job audiences is
 *     the ROLLBACK lever: turning it off must hide the new fields, never re-expose an RVM-only job.
 *     If the fragment, the reach core or a worker read consulted any flag, switching off would do
 *     exactly that. So those files may import no config / rollout / flag module and read no
 *     environment variable — the rule is unconditional by construction, not by convention.
 */

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const SCAN_ROOTS = ["apps/api/src", "packages/db/src"] as const;

/** An audience VALUE written in code, or an audience COMPARISON in SQL or the query builder. */
const AUDIENCE_SPELLINGS: readonly { name: string; pattern: RegExp }[] = [
  { name: "rvm_students literal", pattern: /['"`]rvm_students['"`]/ },
  { name: "audience <> / !=", pattern: /audience\}?\s*(?:<>|!=)/i },
  { name: "audience IN / NOT IN", pattern: /audience\}?\s+(?:NOT\s+)?IN\s*\(/i },
  { name: "audience = '…'", pattern: /audience\}?\s*=\s*'/i },
  { name: "builder comparison", pattern: /\b(?:eq|ne|inArray|notInArray)\(\s*[\w.]*\.audience\b/ },
];

/** Files that may spell an audience, each with the reason. Paths are repo-relative. */
const ALLOWED: Readonly<Record<string, string>> = {
  "packages/db/src/job-visibility.ts": "THE fragment itself.",
  "packages/db/src/schema/job.ts":
    "The column's CHECKs (`job_postings_audience_chk`, `job_postings_twin_audience_chk`, " +
    "`job_postings_rvm_targeting_chk`) and `JOB_POSTING_AUDIENCES` — the closed set the fragment's " +
    "`satisfies` is checked against.",
  "apps/api/src/campus-link/campus-link.contract.ts":
    "The Campus (RVM-facing) wire contract's `audience` enum. Never on a BadaBhai worker path.",
};

function sourceFilesUnder(dir: string): string[] {
  const base = join(REPO_ROOT, ...dir.split("/"));
  if (!existsSync(base)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      if (/\.(?:test|test-support|d)\.ts$/.test(entry.name)) continue;
      out.push(relative(REPO_ROOT, full).split(sep).join("/"));
    }
  };
  walk(base);
  return out.sort();
}

function code(file: string): string {
  return stripComments(readFileSync(join(REPO_ROOT, ...file.split("/")), "utf8"));
}

describe("#2746 — the audience rule has one spelling", () => {
  const files = SCAN_ROOTS.flatMap(sourceFilesUnder);
  const hits = new Map<string, string[]>();
  for (const file of files) {
    const text = code(file);
    const found = AUDIENCE_SPELLINGS.filter((s) => s.pattern.test(text)).map((s) => s.name);
    if (found.length > 0) hits.set(file, found);
  }

  it("reads both trees (a scan of nothing would pass vacuously)", () => {
    expect(files).toContain("packages/db/src/job-visibility.ts");
    expect(files).toContain("apps/api/src/match/match-feed.repository.ts");
    expect(files.length).toBeGreaterThan(400);
  });

  it("no file outside the allow-list spells an audience literal or comparison", () => {
    const unexpected = [...hits.entries()]
      .filter(([file]) => !(file in ALLOWED))
      .map(([file, kinds]) => `${file}: ${kinds.join(", ")}`);
    expect(unexpected, "use reachesBadaBhaiWorkers() from @badabhai/db").toEqual([]);
  });

  it("every allow-listed file still needs its entry (no stale exemptions)", () => {
    const stale = Object.keys(ALLOWED).filter((file) => !hits.has(file));
    expect(stale).toEqual([]);
  });

  it("the sweep catches the spellings it exists to stop", () => {
    const samples = [
      `sql\`jp.audience <> 'rvm_students'\``,
      "AND jp.audience IN ('badabhai_workers', 'both')",
      "sql`${t.audience} NOT IN ('x')`",
      "WHERE audience = 'both'",
      "eq(jobPostings.audience, aud)",
      `const a = "rvm_students";`,
    ];
    for (const sample of samples) {
      expect(
        AUDIENCE_SPELLINGS.some((s) => s.pattern.test(sample)),
        sample,
      ).toBe(true);
    }
    // …and not a resume renderer's audience variable, which is a different word entirely.
    expect(AUDIENCE_SPELLINGS.some((s) => s.pattern.test(`audience === "worker"`))).toBe(false);
  });
});

/**
 * The files the visibility rule runs in: the fragment, the reach core and its CLI, and every
 * worker read that applies it. None may depend on a switch.
 */
const NO_SWITCH_FILES = [
  "packages/db/src/job-visibility.ts",
  "packages/db/src/agency-twin.ts",
  "packages/db/src/materialize-job-reach.ts",
  "apps/api/src/applications/applications.repository.ts",
  "apps/api/src/jobs/jobs.repository.ts",
  "apps/api/src/match/match-feed.repository.ts",
  "apps/api/src/match/worker-skills.repository.ts",
] as const;

/** An import of anything that can carry a flag: the config package, a rollout/pilot/flag module. */
const SWITCH_MODULE = /(?:@badabhai\/config|rollout|pilot|feature|flag|config)/i;
/** A flag read in code: the environment, a rollout constant, a config service, an `_ENABLED` key. */
const SWITCH_READ =
  /process\.env|_ROLLOUT\b|FeatureRollout|ConfigService|\b[A-Z][A-Z0-9_]*_ENABLED\b/;

function importSpecifiers(text: string): string[] {
  return [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1] ?? "");
}

describe("#2746 (M2) — the audience rule never depends on a rollout switch", () => {
  it.each(NO_SWITCH_FILES)("%s imports no config, rollout or flag module", (file) => {
    const specifiers = importSpecifiers(code(file));
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => SWITCH_MODULE.test(s))).toEqual([]);
  });

  it.each(NO_SWITCH_FILES)("%s reads no environment variable or flag", (file) => {
    expect(code(file)).not.toMatch(SWITCH_READ);
  });

  it("the fragment depends on drizzle and the schema only", () => {
    expect(importSpecifiers(code("packages/db/src/job-visibility.ts")).sort()).toEqual([
      "./schema",
      "drizzle-orm",
    ]);
  });

  it("the detector sees a switch when one is there", () => {
    expect(SWITCH_MODULE.test("../config/feature-rollout.service")).toBe(true);
    expect(SWITCH_MODULE.test("@badabhai/config")).toBe(true);
    expect(SWITCH_READ.test("if (cfg.JOB_AUDIENCE_ROLLOUT === 'off')")).toBe(true);
    expect(SWITCH_READ.test("this.config.MATCH_V1_ENABLED")).toBe(true);
  });
});
