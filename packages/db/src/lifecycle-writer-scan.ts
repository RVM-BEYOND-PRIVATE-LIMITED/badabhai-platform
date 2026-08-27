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
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
