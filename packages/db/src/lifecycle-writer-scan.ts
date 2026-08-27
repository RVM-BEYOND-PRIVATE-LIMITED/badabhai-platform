/**
 * Find, by reading the source tree, every file that can write a taxonomy-spine table.
 *
 * ===========================================================================
 * WHY DISCOVERED AND NOT LISTED
 * ===========================================================================
 * A hand-maintained list of writers is a list of the writers someone remembered. The property
 * that matters — "these files, and no others, can create a `skill_alias` row" — is only worth
 * stating if adding one more makes something fail. So the set is derived, and
 * `skill-lifecycle.test.ts` asserts the derived set against the declared one.
 *
 * This is the technique `cross-slug-alias.test.ts` uses to keep decision 1 closed, for the same
 * reason: no runtime assertion can observe a row nobody is able to write, so the check has to
 * be about what the CODE can express.
 *
 * ===========================================================================
 * A STATEMENT IN A STRING IS NOT A WRITE
 * ===========================================================================
 * The first version of this scan reported five writers that write nothing. This repository is
 * full of files that QUOTE SQL: `activation-sequence.ts` carries `UPDATE skill SET
 * status='active'` as a rollback instruction, `deprecation-seed-plan.ts` RENDERS the statement
 * a separate runner would execute, and `audit-alias-collision-cleanup.ts` prints the
 * de-election SQL precisely because it refuses to run it. Counting those as writers would
 * invert the meaning of the audit — the files most careful to separate planning from execution
 * would be the ones flagged.
 *
 * So a raw-SQL hit counts only inside a `dsql` tagged template, which is the form that actually
 * reaches the driver. Comments are stripped first, everywhere.
 *
 * DIRECTION OF ERROR: a writer that assembles its statement dynamically would be missed, so a
 * hit is proof and a miss is not. That is the safe direction — the scan can under-report a
 * writer, never invent one.
 *
 * NO DATABASE. Filesystem reads only, so this is safe to import from a test.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** The Drizzle table identifiers this repository uses for the taxonomy spine. */
export const SPINE_TABLES = {
  skill: "skills",
  skill_alias: "skillAliases",
  job_domain: "jobDomains",
  job_domain_alias: "jobDomainAliases",
  job_domain_skill: "jobDomainSkills",
  unresolved_phrase: "unresolvedPhrases",
} as const;

export type SpineTable = keyof typeof SPINE_TABLES;

/** The raw-SQL forms, for runners that write a statement rather than build one. */
const RAW_SQL: Readonly<Record<SpineTable, readonly RegExp[]>> = {
  skill: [/UPDATE\s+"?skill"?\s+SET/i, /INSERT\s+INTO\s+"?skill"?\s*\(/i],
  skill_alias: [/UPDATE\s+"?skill_alias"?/i, /INSERT\s+INTO\s+"?skill_alias"?/i],
  job_domain: [/UPDATE\s+"?job_domain"?\s+SET/i, /INSERT\s+INTO\s+"?job_domain"?\s*\(/i],
  job_domain_alias: [/UPDATE\s+"?job_domain_alias"?/i, /INSERT\s+INTO\s+"?job_domain_alias"?/i],
  job_domain_skill: [/UPDATE\s+"?job_domain_skill"?/i, /INSERT\s+INTO\s+"?job_domain_skill"?/i],
  unresolved_phrase: [/UPDATE\s+"?unresolved_phrase"?/i, /INSERT\s+INTO\s+"?unresolved_phrase"?/i],
};

/**
 * Files that describe the scan rather than participate in it.
 *
 * Both hold the writer identifiers as literal text — one as the patterns it searches for, the
 * other as the lifecycle it documents — so both match themselves. Naming them here is honest;
 * inferring "meta-ness" from a filename would be a rule that silently excludes a real writer
 * someone happens to name similarly.
 */
const META_FILES: ReadonlySet<string> = new Set([
  "lifecycle-writer-scan.ts",
  "skill-lifecycle.ts",
  "audit-skill-lifecycle.ts",
]);

/** Line and block comments removed. A mention in prose is not a capability. */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

/** The text inside every `dsql` tagged template — the only raw SQL that reaches the driver. */
function taggedSql(code: string): string {
  return [...code.matchAll(/dsql`([\s\S]*?)`/g)].map((m) => m[1] ?? "").join("\n");
}

export interface WriterScan {
  /** Basename -> the spine tables that file can write. */
  readonly byFile: ReadonlyMap<string, ReadonlySet<SpineTable>>;
  /** Spine table -> the basenames that can write it. */
  readonly byTable: ReadonlyMap<SpineTable, ReadonlySet<string>>;
  /** Every basename that can write anything on the spine. */
  readonly writers: ReadonlySet<string>;
}

/** Source files worth scanning: implementation only. Tests write to throwaway schemas. */
export function sourceFiles(srcDir: string): string[] {
  return readdirSync(srcDir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
    .filter((f) => !META_FILES.has(f))
    .sort();
}

export function scanWriters(srcDir: string): WriterScan {
  const byFile = new Map<string, Set<SpineTable>>();
  const byTable = new Map<SpineTable, Set<string>>();
  for (const t of Object.keys(SPINE_TABLES) as SpineTable[]) byTable.set(t, new Set());

  for (const file of sourceFiles(srcDir)) {
    const code = stripComments(readFileSync(join(srcDir, file), "utf8"));
    const sql = taggedSql(code);
    for (const t of Object.keys(SPINE_TABLES) as SpineTable[]) {
      const id = SPINE_TABLES[t];
      const builderHit = code.includes(`.insert(${id})`) || code.includes(`.update(${id})`);
      const rawHit = RAW_SQL[t].some((re) => re.test(sql));
      if (!builderHit && !rawHit) continue;
      const set = byFile.get(file) ?? new Set<SpineTable>();
      set.add(t);
      byFile.set(file, set);
      byTable.get(t)!.add(file);
    }
  }

  return { byFile, byTable, writers: new Set(byFile.keys()) };
}

/**
 * Files that both QUERY the occupation alias vocabulary and WRITE the skill vocabulary.
 *
 * THE DIRECTIONALITY CHECK. `job_domain_alias` holds how a worker names their occupation;
 * `skill_alias` holds how they name a unit of work. Deriving the second from the first would
 * put job titles into the skill id space — in two recorded cases actively harmfully. Nothing
 * does it today, and this is how that stays true: the expected result is the empty set.
 *
 * "Queries" means the identifier appears in code after comments are stripped. A file that only
 * MENTIONS the table in prose — `seed-domain-skills.ts` explains why it does not touch it — is
 * not reading it, and the first version of this function wrongly said it was.
 */
export function crossVocabularyWriters(srcDir: string): string[] {
  const out: string[] = [];
  for (const file of sourceFiles(srcDir)) {
    const code = stripComments(readFileSync(join(srcDir, file), "utf8"));
    const readsDomainAliases =
      code.includes("jobDomainAliases") || /\bjob_domain_alias\b/.test(taggedSql(code));
    const writesSkillVocab =
      code.includes(".insert(skillAliases)") || code.includes(".insert(skills)");
    if (readsDomainAliases && writesSkillVocab) out.push(file);
  }
  return out;
}

// ===========================================================================
// THE REPO-WIDE SCAN
// ===========================================================================

/**
 * ONE WORKSPACE THAT CAN REACH THE DATABASE, named by the directory its code lives in.
 *
 * ── WHY THIS EXISTS, AND WHAT WAS WRONG BEFORE IT ─────────────────────────────────────
 * {@link scanWriters} reads ONE directory — `packages/db/src` — and every claim built on it was
 * therefore a claim about that directory. But the claims themselves are repo-wide: this file's
 * own header says the property that matters is *"these files, and no others, can create a
 * `skill_alias` row"*, and `skill-lifecycle.test.ts` asserts things like "exactly one writer for
 * `job_domain_skill`". Read literally those are statements about the whole codebase, and they
 * were being measured over a fraction of it.
 *
 * The gap was not hypothetical in shape, only in luck: `apps/api` imports `@badabhai/db` in 198
 * files and holds every HTTP request path in the product. A `.insert(skills)` added there — in
 * good faith, by somebody implementing "approve and create it" on the skill-review surface —
 * would have satisfied every assertion in this module, because this module could not see the
 * file it was in.
 *
 * ── WHY EXACTLY THESE TWO, AND HOW THAT STAYS TRUE ────────────────────────────────────
 * A writer needs the Drizzle models or a connection, and both arrive through `@badabhai/db`.
 * Exactly two workspaces declare that dependency (measured 2026-08-27: `apps/api` and
 * `packages/db`; the four Next apps and every other package declare none and import it in zero
 * files). So this list is complete TODAY — and because "today" is the part that rots,
 * `skill-lifecycle.test.ts` re-derives the dependent set from the workspace manifests and fails
 * if a third one appears. A new consumer is then a decision about this list rather than a silent
 * hole in it.
 */
export interface SpineWriterRoot {
  /** Repo-relative directory, POSIX-separated. Also the prefix of every key it contributes. */
  readonly dir: string;
  /** Why this directory can write, so a reader can judge whether the list is still right. */
  readonly reason: string;
}

export const SPINE_WRITER_ROOTS: readonly SpineWriterRoot[] = [
  {
    dir: "packages/db/src",
    reason: "owns the schema, the migrations and every seeding/maintenance runner",
  },
  {
    dir: "apps/api/src",
    reason: "the only application workspace that imports @badabhai/db — every request path",
  },
];

/** Every workspace manifest, so the root list can be checked against what actually depends on db. */
export function workspacesDependingOnDb(repoRoot: string): string[] {
  const out: string[] = [];
  for (const group of ["apps", "packages"]) {
    const groupDir = join(repoRoot, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(groupDir, entry.name, "package.json");
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
        name?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      // `packages/db` depends on itself in no manifest, so it is added explicitly by the caller;
      // this function answers "who ELSE reaches for it".
      if (deps["@badabhai/db"] !== undefined) out.push(`${group}/${entry.name}`);
    }
  }
  return out.sort();
}

/**
 * Every implementation file under one root, RECURSIVELY, keyed repo-relative.
 *
 * Recursive where {@link sourceFiles} is flat, because `packages/db/src` is flat and
 * `apps/api/src` is 40-odd nested modules — a non-recursive walk over the second would return
 * almost nothing and report a clean scan, which is the worst possible failure for an audit.
 *
 * Keys are repo-relative paths (`apps/api/src/skills/skills.repository.ts`), not basenames.
 * Basenames were fine while one directory was in scope and are not now: `index.ts` alone would
 * collide a dozen ways, and a collision here silently merges two files' capabilities into one
 * entry.
 */
export function spineSourceFiles(repoRoot: string, root: SpineWriterRoot): string[] {
  const base = join(repoRoot, ...root.dir.split("/"));
  if (!existsSync(base)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // `node_modules` and build output are not this repo's source, and `dist` in particular
        // holds a COMPILED COPY of every writer — counting it would double-report every one.
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".next") {
          continue;
        }
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue;
      if (entry.name.endsWith(".d.ts")) continue;
      if (META_FILES.has(entry.name)) continue;
      out.push(relative(repoRoot, full).split(sep).join("/"));
    }
  };
  walk(base);
  return out.sort();
}

/**
 * The text inside every SQL tagged template, under EITHER tag name.
 *
 * ── WHY THIS IS NOT {@link taggedSql}, WHICH IS THE SAME FUNCTION ONE CHARACTER SHORTER ──
 * That one matches ``dsql`...` `` only, because `packages/db` imports drizzle's `sql` AS `dsql`
 * by convention throughout. `apps/api` does not: it imports it as `sql`, which is drizzle's own
 * export name. So the `dsql`-only matcher, pointed at `apps/api`, reads 437 files and finds no
 * raw SQL in any of them.
 *
 * THAT IS EXACTLY WHAT HAPPENED ON THE FIRST RUN OF THIS SCAN, and it is worth recording rather
 * than quietly fixing: the repo-wide scan reported ZERO writers in `apps/api` — a clean bill of
 * health for the workspace it had just been extended to cover — while
 * `apps/api/src/skills/skills.repository.ts` was, and is, writing `unresolved_phrase` through
 * ``sql`INSERT INTO unresolved_phrase ...` ``. An audit that returns "nothing found" because it
 * cannot read the syntax in front of it is worse than no audit, because the empty result gets
 * quoted.
 *
 * `\bd?sql` accepts both tags and still refuses `mysql`/`pgsql`: the word boundary cannot sit
 * between two word characters, so there is no position in `mysql` where the match can start.
 */
function taggedSqlAny(code: string): string {
  return [...code.matchAll(/\bd?sql`([\s\S]*?)`/g)].map((m) => m[1] ?? "").join("\n");
}

/**
 * THE REPO-WIDE WRITER SET. Same detection rules as {@link scanWriters} — a Drizzle builder call
 * or raw SQL inside a tagged template, comments stripped first — over every root instead of one.
 *
 * `.delete(...)` is detected here and not in {@link scanWriters}, deliberately: that function's
 * result feeds the LIFECYCLE MODEL, which is about how vocabulary is CREATED, and adding deletes
 * to it would make `validateLifecycle` report maintenance runners as undeclared growth paths.
 * This function answers a different question — "what can change these tables at all" — and a
 * delete is squarely inside it.
 *
 * DIRECTION OF ERROR IS UNCHANGED AND STILL MATTERS: a writer that assembles its statement
 * dynamically is missed, so a hit is proof and a miss is not. The scan can under-report a writer,
 * never invent one.
 */
export function scanWritersAcross(
  repoRoot: string,
  roots: readonly SpineWriterRoot[] = SPINE_WRITER_ROOTS,
): WriterScan {
  const byFile = new Map<string, Set<SpineTable>>();
  const byTable = new Map<SpineTable, Set<string>>();
  for (const t of Object.keys(SPINE_TABLES) as SpineTable[]) byTable.set(t, new Set());

  for (const root of roots) {
    for (const rel of spineSourceFiles(repoRoot, root)) {
      const code = stripComments(readFileSync(join(repoRoot, ...rel.split("/")), "utf8"));
      const sql = taggedSqlAny(code);
      for (const t of Object.keys(SPINE_TABLES) as SpineTable[]) {
        const id = SPINE_TABLES[t];
        const builderHit =
          code.includes(`.insert(${id})`) ||
          code.includes(`.update(${id})`) ||
          code.includes(`.delete(${id})`);
        // Anchored on a word boundary at the table name, so `skill_candidate` never matches
        // `skill` and `job_domain_skill` never matches `job_domain`. The 0093 staging tables are
        // named AFTER the corpus tables they stage for, and a scan that could not tell them apart
        // would flag the review layer's own guarded write as a corpus write — at which point the
        // audit has to be switched off to ship anything.
        const rawHit = RAW_SQL_ANCHORED[t].some((re) => re.test(sql));
        if (!builderHit && !rawHit) continue;
        const set = byFile.get(rel) ?? new Set<SpineTable>();
        set.add(t);
        byFile.set(rel, set);
        byTable.get(t)!.add(rel);
      }
    }
  }

  return { byFile, byTable, writers: new Set(byFile.keys()) };
}

/**
 * The raw-SQL patterns, with a trailing boundary the originals lack.
 *
 * `RAW_SQL` matches `INSERT INTO "?skill"?\s*\(`, which cannot match `skill_candidate` because
 * of the required `(`. That happens to hold for the two-writer set it was built for and is not a
 * property worth relying on repo-wide, where `INSERT INTO skill_candidate_source (...)` is a real
 * statement in a real file. `(?![a-z_])` states the intent instead of inheriting it.
 */
/** The four statement verbs, built per table so the boundary is stated once. */
function anchoredWritePatterns(table: SpineTable): readonly RegExp[] {
  const t = table;
  return [
    new RegExp(`INSERT\\s+INTO\\s+"?${t}"?(?![a-z_])`, "i"),
    new RegExp(`UPDATE\\s+"?${t}"?(?![a-z_])\\s+SET`, "i"),
    new RegExp(`DELETE\\s+FROM\\s+"?${t}"?(?![a-z_])`, "i"),
    new RegExp(`TRUNCATE\\s+(TABLE\\s+)?"?${t}"?(?![a-z_])`, "i"),
  ];
}

const RAW_SQL_ANCHORED: Readonly<Record<SpineTable, readonly RegExp[]>> = {
  skill: anchoredWritePatterns("skill"),
  skill_alias: anchoredWritePatterns("skill_alias"),
  job_domain: anchoredWritePatterns("job_domain"),
  job_domain_alias: anchoredWritePatterns("job_domain_alias"),
  job_domain_skill: anchoredWritePatterns("job_domain_skill"),
  unresolved_phrase: anchoredWritePatterns("unresolved_phrase"),
};
