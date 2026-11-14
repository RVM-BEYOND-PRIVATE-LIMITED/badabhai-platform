import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { stripComments } from "./lifecycle-writer-scan";

/**
 * #2746 — THE AUDIENCE RULE HAS ONE SPELLING, IS NEVER OPTIONAL, AND HAS NO SWITCH.
 *
 * (1) ONE SPELLING. `job-visibility.ts` is the only place "which audiences reach a BadaBhai
 *     worker" is written. A second spelling — an `audience <> 'rvm_students'` in some read, an
 *     `eq(jobPostings.audience, …)` in a service, a `row.audience === …` in TypeScript — is how an
 *     RVM-only job leaks the day a fourth audience lands or one copy is edited. So every non-test
 *     source under `apps/api/src` and `packages/db/src` is swept, comments stripped and every
 *     `reachesBadaBhaiWorkers(…)` call removed, for an audience literal, an audience comparison or
 *     ANY reference to the `job_postings.audience` column. Every hit must be on the ALLOW-LIST
 *     below with its reason. The list is driven both ways (the ops-guard-adoption pattern): a
 *     listed file that no longer hits is a stale entry and fails too.
 *
 * (2) NEVER OPTIONAL. The fragment is applied unconditionally: a `cond ? reachesBadaBhaiWorkers()
 *     : undefined` (or `&&` / `||`) would make the lock depend on whatever `cond` is.
 *
 * (3) PAIRED WITH `hidden_at`. Every worker read that tests a posting's `hidden_at` must also call
 *     the fragment — #2566 put `hidden_at` on exactly the worker reads, so a new read that copies
 *     that test without the audience is the leak this catches. Company, admin and agency code and
 *     the D5/seed scripts are out of this rule (see PAIRING_EXEMPT).
 *
 * (4) NO SWITCH (security review of PR 2, M2). `JOB_AUDIENCE_ROLLOUT` is the ROLLBACK lever:
 *     turning it off must hide the new fields, never re-expose an RVM-only job. So the fragment,
 *     the reach core and the worker reads import no config / rollout / flag module and read no
 *     environment variable, and the services that choose which of those reads to run never
 *     consult the audience switch or `FeatureRolloutService`.
 */

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const SCAN_ROOTS = ["apps/api/src", "packages/db/src"] as const;

interface Rule {
  name: string;
  pattern: RegExp;
}

/** An audience VALUE written in code, or an audience COMPARISON in SQL or the query builder. */
const AUDIENCE_SPELLINGS: readonly Rule[] = [
  { name: "rvm_students literal", pattern: /['"`]rvm_students['"`]/ },
  { name: "audience <> / !=", pattern: /audience\}?\s*(?:<>|!=)/i },
  { name: "audience IN / NOT IN", pattern: /audience\}?\s+(?:NOT\s+)?IN\s*\(/i },
  { name: "audience = '…'", pattern: /audience\}?\s*=\s*'/i },
  { name: "builder comparison", pattern: /\b(?:eq|ne|inArray|notInArray)\(\s*[\w.]*\.audience\b/ },
];

/**
 * ANY reference to the `job_postings.audience` column (or an audience compared in TypeScript),
 * matched AFTER every `reachesBadaBhaiWorkers(…)` call is removed — passing the column to the
 * fragment is the one sanctioned use. SQL keywords are matched upper-case only, so a TypeScript
 * `audience` variable (the résumé renderers have one) is not mistaken for the column.
 */
const AUDIENCE_COLUMN_REFS: readonly Rule[] = [
  { name: "jobPostings.audience", pattern: /\bjobPostings\.audience\b/ },
  {
    name: "qualified column in SQL",
    pattern: /(?:\b(?:jp|job_postings)|"job_postings")\."?audience\b/,
  },
  { name: "bare column in SQL", pattern: /\b(?:SELECT|WHERE|AND|OR|ON|BY|SET)\s+audience\b/ },
  {
    name: ".audience compared",
    pattern: /\.audience\s*(?:===?|!==?)|(?:===?|!==?)\s*[\w.]*\.audience\b/,
  },
  { name: ".includes(… audience)", pattern: /\.includes\(\s*[\w.]*audience\b/i },
];

/** The fragment applied conditionally. Never allowed, in any file. */
const CONDITIONAL_FRAGMENT = /(?:[?:]|&&|\|\|)\s*reachesBadaBhaiWorkers\(/;

/** Files that may spell or reference an audience, each with the reason. Repo-relative paths. */
const ALLOWED: Readonly<Record<string, string>> = {
  "packages/db/src/job-visibility.ts": "THE fragment itself.",
  "packages/db/src/schema/job.ts":
    "The column's CHECKs (`job_postings_audience_chk`, `job_postings_twin_audience_chk`, " +
    "`job_postings_rvm_targeting_chk`) and `JOB_POSTING_AUDIENCES` — the closed set the fragment's " +
    "`satisfies` is checked against.",
  "apps/api/src/campus-link/campus-link.contract.ts":
    "The Campus (RVM-facing) wire contract's `audience` enum. Never on a BadaBhai worker path.",
  // #2746 PR 4 — the company side of the audience. None of these decides a BadaBhai worker read.
  "packages/db/src/job-review.ts":
    "The RVM review content hash: the audience is part of what an RVM student sees, so it is one " +
    "of the hashed fields (a change of audience re-pends an approval). It reads the column as a " +
    "VALUE to hash, never as a visibility test.",
  "apps/api/src/job-postings/posting-audience.service.ts":
    "The company's audience write and its own reads: compares the stored audience with the " +
    "requested one (no-change detection) and with the column default (whether the company's read " +
    "shows the block). Worker visibility is decided only through the fragment's TS twins.",
  "apps/api/src/admin/admin-entities.repository.ts":
    "The admin posting list and detail project the audience READ-ONLY for the console. Admin code, " +
    "never a worker path (PAIRING_EXEMPT).",
  // #2746 PR 5 — Campus's review of the RVM part of a posting.
  "apps/api/src/campus-link/campus-posting-review.repository.ts":
    "The Campus review reads the audience as a VALUE (an RVM part or 409 AUDIENCE_EXCLUDES_RVM; " +
    "the TS twin `audienceReachesRvmStudents` decides) and `hidden_at` for its neutral 404. A " +
    "service-credential path for the placement team, never a BadaBhai worker read " +
    "(PAIRING_EXEMPT).",
};

/** A posting's `hidden_at` tested — the mark of a worker read since #2566. */
const HIDDEN_ON_POSTINGS =
  /\bjobPostings\.hiddenAt\b|\bjp\.hidden_at\b|\bjob_postings\.hidden_at\b/;

/**
 * Out of the pairing rule, explicitly: company-side, admin and agency code (their own postings,
 * the admin console — later #2746 PRs decide what those show), and the D5 / seed scripts (D5 calls
 * the fragment through the reach core; seeds write their own fixtures).
 */
const PAIRING_EXEMPT: readonly RegExp[] = [
  /^apps\/api\/src\/admin\//,
  /^apps\/api\/src\/admin-[^/]+\//,
  /^apps\/api\/src\/payer-portal\//,
  /^apps\/api\/src\/payers\//,
  /^apps\/api\/src\/agency\//,
  /^packages\/db\/src\/materialize-job-reach\.ts$/,
  /^packages\/db\/src\/seed-[\w-]+\.ts$/,
  // #2746 PR 5 — Campus's review (placement team, service credential): it refuses a hidden
  // posting; it reads no posting FOR a worker. One file, not the directory: #2752's student-facing
  // read lives in campus-link too and must face this rule on its own merits.
  /^apps\/api\/src\/campus-link\/campus-posting-review\.repository\.ts$/,
];

/**
 * FOLLOW-UP, named so it is not forgotten: the admin empty-feed list is a set-based SECOND COPY of
 * the worker feed rule (#2569) and tests neither `hidden_at` nor the audience today. It is
 * admin-only, so it is out of this PR and exempt above; its parity gate (`admin-empty-feed.db`)
 * still passes because its cohort holds no hidden or RVM-only posting.
 */
const ADMIN_MIRROR_FOLLOW_UP = "apps/api/src/admin/admin-empty-feed.repository.ts";

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

/** Replace every `reachesBadaBhaiWorkers(…)` call (balanced parentheses) with a bare call. */
function stripFragmentCalls(src: string): string {
  const marker = "reachesBadaBhaiWorkers(";
  let out = "";
  let from = 0;
  for (;;) {
    const at = src.indexOf(marker, from);
    if (at < 0) return out + src.slice(from);
    out += `${src.slice(from, at)}reachesBadaBhaiWorkers()`;
    let depth = 1;
    let i = at + marker.length;
    while (i < src.length && depth > 0) {
      if (src[i] === "(") depth += 1;
      else if (src[i] === ")") depth -= 1;
      i += 1;
    }
    from = i;
  }
}

function rulesHit(text: string): string[] {
  const stripped = stripFragmentCalls(text);
  return [
    ...AUDIENCE_SPELLINGS.filter((r) => r.pattern.test(text)).map((r) => r.name),
    ...AUDIENCE_COLUMN_REFS.filter((r) => r.pattern.test(stripped)).map((r) => r.name),
  ];
}

const FILES = SCAN_ROOTS.flatMap(sourceFilesUnder);
const CODE = new Map(FILES.map((file) => [file, code(file)]));

describe("#2746 — the audience rule has one spelling", () => {
  const hits = new Map<string, string[]>();
  for (const [file, text] of CODE) {
    const found = rulesHit(text);
    if (found.length > 0) hits.set(file, found);
  }

  it("reads both trees (a scan of nothing would pass vacuously)", () => {
    expect(FILES).toContain("packages/db/src/job-visibility.ts");
    expect(FILES).toContain("apps/api/src/match/match-feed.repository.ts");
    expect(FILES.length).toBeGreaterThan(400);
  });

  it("no file outside the allow-list spells, compares or references an audience", () => {
    const unexpected = [...hits.entries()]
      .filter(([file]) => !(file in ALLOWED))
      .map(([file, kinds]) => `${file}: ${kinds.join(", ")}`);
    expect(unexpected, "use reachesBadaBhaiWorkers() from @badabhai/db").toEqual([]);
  });

  it("every allow-listed file still needs its entry (no stale exemptions)", () => {
    const stale = Object.keys(ALLOWED).filter((file) => !hits.has(file));
    expect(stale).toEqual([]);
  });

  it("the sweep catches the spellings and references it exists to stop", () => {
    const samples = [
      `sql\`jp.audience <> 'rvm_students'\``,
      "AND jp.audience IN ('badabhai_workers', 'both')",
      "sql`${t.audience} NOT IN ('x')`",
      "WHERE audience = 'both'",
      "eq(jobPostings.audience, aud)",
      `const a = "rvm_students";`,
      "select({ audience: jobPostings.audience })",
      "sql`SELECT jp.audience FROM job_postings jp`",
      'sql`SELECT "job_postings"."audience"`',
      "dsql`SELECT id, status FROM job_postings WHERE audience = $1`",
      "dsql`UPDATE job_postings SET audience = ${a}`",
      "if (row.audience === aud) return;",
      "VISIBLE.includes(row.audience)",
    ];
    for (const sample of samples) expect(rulesHit(sample), sample).not.toEqual([]);
    // The sanctioned use, and a résumé renderer's unrelated `audience` variable, are not hits.
    expect(rulesHit("AND ${reachesBadaBhaiWorkers(dsql`jp.audience`)}")).toEqual([]);
    expect(rulesHit("reachesBadaBhaiWorkers(jobPostings.audience)")).toEqual([]);
    expect(rulesHit(`audience === "worker" ? a : b`)).toEqual([]);
    expect(rulesHit("buildResumeRenderInput(row, audience, opts)")).toEqual([]);
  });
});

describe("#2746 — the fragment is never applied conditionally", () => {
  it("no file applies reachesBadaBhaiWorkers behind a ?:, && or ||", () => {
    const conditional = [...CODE.entries()]
      .filter(([, text]) => CONDITIONAL_FRAGMENT.test(text))
      .map(([file]) => file);
    expect(conditional).toEqual([]);
  });

  it("the detector sees a conditional application", () => {
    for (const sample of [
      "flag ? reachesBadaBhaiWorkers() : undefined",
      "x ? y : reachesBadaBhaiWorkers()",
      "on && reachesBadaBhaiWorkers()",
      "a || reachesBadaBhaiWorkers(sql`jp.audience`)",
    ]) {
      expect(CONDITIONAL_FRAGMENT.test(sample), sample).toBe(true);
    }
    expect(
      CONDITIONAL_FRAGMENT.test("isNull(jobPostings.hiddenAt),\n  reachesBadaBhaiWorkers(),"),
    ).toBe(false);
  });
});

describe("#2746 — every worker read that tests hidden_at also tests the audience", () => {
  const exempt = (file: string) => PAIRING_EXEMPT.some((re) => re.test(file));
  const workerReads = [...CODE.entries()].filter(
    ([file, text]) => !exempt(file) && HIDDEN_ON_POSTINGS.test(text),
  );

  it("finds the known worker reads (a scan of nothing would pass vacuously)", () => {
    const files = workerReads.map(([file]) => file);
    for (const known of [
      "apps/api/src/applications/applications.repository.ts",
      "apps/api/src/jobs/jobs.repository.ts",
      "apps/api/src/match/match-feed.repository.ts",
      "apps/api/src/match/worker-skills.repository.ts",
    ]) {
      expect(files).toContain(known);
    }
  });

  it("each of them calls reachesBadaBhaiWorkers", () => {
    const unpaired = workerReads
      .filter(([, text]) => !text.includes("reachesBadaBhaiWorkers("))
      .map(([file]) => file);
    expect(unpaired, "add reachesBadaBhaiWorkers() beside the hidden_at test").toEqual([]);
  });

  it("the exemptions are the named ones, and the admin feed mirror is a recorded follow-up", () => {
    expect(exempt(ADMIN_MIRROR_FOLLOW_UP)).toBe(true);
    expect(FILES).toContain(ADMIN_MIRROR_FOLLOW_UP);
    expect(exempt("apps/api/src/admin-postings/admin-postings.repository.ts")).toBe(true);
    expect(exempt("apps/api/src/jobs/jobs.repository.ts")).toBe(false);
    expect(exempt("apps/api/src/chat-companion/chat-companion.service.ts")).toBe(false);
    // The Campus review is exempt as ONE file; the rest of campus-link is not.
    expect(exempt("apps/api/src/campus-link/campus-posting-review.repository.ts")).toBe(true);
    expect(exempt("apps/api/src/campus-link/institute-link.repository.ts")).toBe(false);
  });
});

/**
 * The files the visibility rule runs in: the fragment, the reach core and its CLI, and every
 * worker read that applies it. None may depend on a switch of any kind.
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

/**
 * The services that CHOOSE which of those reads to run. They legitimately read config (the feed
 * mode flags), so the rule here is narrower: they never consult the audience switch or the rollout
 * service, so no switch value can route a worker around the audience lock.
 */
const ROUTING_SERVICES = [
  "apps/api/src/applications/applications.service.ts",
  "apps/api/src/jobs/jobs.service.ts",
  "apps/api/src/match/match-feed.service.ts",
  "apps/api/src/match/match-apply.service.ts",
  "apps/api/src/match/publish-reach.service.ts",
  "apps/api/src/chat-companion/chat-companion.service.ts",
] as const;

/** An import of anything that can carry a flag: the config package, a rollout/pilot/flag module. */
const SWITCH_MODULE = /(?:@badabhai\/config|rollout|pilot|feature|flag|config)/i;
/** A flag read in code: the environment, a rollout constant, a config service, an `_ENABLED` key. */
const SWITCH_READ =
  /process\.env|_ROLLOUT\b|FeatureRollout|ConfigService|\b[A-Z][A-Z0-9_]*_ENABLED\b/;
/** The audience switch, by any of its names. */
const AUDIENCE_SWITCH =
  /FeatureRollout|feature-rollout|FEATURE_ROLLOUT_|\bjob_audience\b|JOB_AUDIENCE_ROLLOUT/;

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

  it.each(ROUTING_SERVICES)(
    "%s never consults the audience switch or FeatureRolloutService",
    (file) => {
      const text = code(file);
      expect(importSpecifiers(text).length).toBeGreaterThan(0);
      expect(text).not.toMatch(AUDIENCE_SWITCH);
    },
  );

  it("the fragment depends on drizzle and the schema only", () => {
    expect(importSpecifiers(code("packages/db/src/job-visibility.ts")).sort()).toEqual([
      "./schema",
      "drizzle-orm",
    ]);
  });

  it("the detectors see a switch when one is there", () => {
    expect(SWITCH_MODULE.test("../config/feature-rollout.service")).toBe(true);
    expect(SWITCH_MODULE.test("@badabhai/config")).toBe(true);
    expect(SWITCH_READ.test("if (cfg.JOB_AUDIENCE_ROLLOUT === 'off')")).toBe(true);
    expect(SWITCH_READ.test("this.config.MATCH_V1_ENABLED")).toBe(true);
    for (const sample of [
      'import { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";',
      'await this.rollout.isOn("job_audience", tenant)',
      "this.config.JOB_AUDIENCE_ROLLOUT",
      "FEATURE_ROLLOUT_CONFIG.job_audience",
    ]) {
      expect(AUDIENCE_SWITCH.test(sample), sample).toBe(true);
    }
  });
});
