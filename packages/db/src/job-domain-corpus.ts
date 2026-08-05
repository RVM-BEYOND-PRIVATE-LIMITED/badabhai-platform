/**
 * The job-domain corpus — loader + validator for the seed data behind `job_domain`
 * (migration 0066).
 *
 * WHY THE DATA LIVES IN packages/db/data AND NOT IN @badabhai/taxonomy.
 * `@badabhai/taxonomy` is imported by apps/web and apps/payer-web, so it must stay
 * browser-safe and cheap to typecheck. Thousands of occupation entries as a
 * `as const satisfies` would wreck `tsc`, and an `fs.readFileSync` loader inside it
 * would break browser bundling outright. `packages/db` is node-only, already reads
 * `.env`, and already runs `tsx` scripts — it is the correct home.
 *
 * WHY JSONL AND NOT JSON. One record per line means a corpus update produces a
 * line-diffable review (you can see "12 domains added" instead of "1 file changed"),
 * and the loader can stream if the corpus outgrows memory. A single JSON array would
 * re-indent on every edit and make review meaningless.
 *
 * THE VALIDATOR IS THE POINT OF THIS FILE. The corpus is scraped from published
 * standards, and a scrape has failure modes a type does not catch: a truncated run, a
 * unit group whose parent was never emitted, a `selectable` row with no aliases (which
 * is invisible to retrieval and therefore a silent hole in coverage). Nothing is
 * written to the database until `validateJobDomainCorpus` returns clean — the same
 * discipline `seed-skills.ts` applies via `validateSkillCorpus`.
 *
 * PRIVACY: published occupation titles, definitions and codes. No worker PII, by
 * construction — nothing worker-derived can reach this file.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { INDUSTRIES, ROLES } from "@badabhai/taxonomy";

import type { JobDomainSource } from "./schema";

/** Where the committed corpus lives, resolved relative to this module so it works
 *  identically from `src/` (tsx) and `dist/` (built). */
export const JOB_DOMAIN_DATA_DIR = join(__dirname, "..", "data", "job-domains");

export type JobDomainLang = "en" | "hi";

export interface JobDomainAliasSeed {
  text: string;
  lang: JobDomainLang;
  source: JobDomainSource;
}

/**
 * One line of the corpus. Deliberately mirrors the PUBLISHED shape (a code, a parent
 * code, a level) rather than the DB shape (`jd_*` ids) — the id is DERIVED, so a
 * corpus file stays readable against the source standard it came from.
 */
export interface JobDomainSeedRecord {
  source: JobDomainSource;
  /** The published code in its own scheme. NULL only for a minted `rvm` row. */
  code: string | null;
  /** Required for `rvm` rows (which have no code to derive an id from). */
  id_slug?: string | null;
  level: number;
  /** Parent's code. Null only at level 1. Resolved within `parent_source`. */
  parent_code: string | null;
  /**
   * The scheme `parent_code` belongs to. Defaults to this row's own `source`, which is
   * the normal case (a scheme parents its own rows).
   *
   * IT EXISTS FOR NCO-2015, and the reason is worth stating. NCO's 8-digit codes are
   * ISCO-aligned on their leading four digits by construction — `7223.0300` is a
   * refinement of ISCO unit group `7223` — so India's ~3,450 occupations are genuinely
   * children of the international tree, not a parallel one. Letting them SAY so keeps a
   * single hierarchy: ISCO levels 1-4 organise, NCO level 5 is what a worker actually
   * is. The alternative — duplicating four ISCO levels inside the NCO scheme — would
   * mean two trees to keep in step and two answers to "what trade is this".
   */
  parent_source?: JobDomainSource | null;
  isco_major: string | null;
  isco_unit: string | null;
  skill_level: number | null;
  label_en: string;
  label_hi: string | null;
  description_en: string | null;
  selectable: boolean;
  industry_id: string | null;
  canonical_role_id: string | null;
  aliases: JobDomainAliasSeed[];
}

/** A corpus record with its derived, immutable `job_domain_id` attached. */
export interface ResolvedJobDomain extends JobDomainSeedRecord {
  jobDomainId: string;
  parentJobDomainId: string | null;
}

const SOURCES: readonly JobDomainSource[] = ["isco08", "nco2015", "rvm"];
const LANGS: readonly JobDomainLang[] = ["en", "hi"];
const ID_RE = /^jd_[a-z0-9_]+$/;

/**
 * Derive the immutable `job_domain_id`.
 *
 * IDS ARE DERIVED, NEVER STORED IN THE CORPUS, so the same source row always produces
 * the same id and re-seeding is idempotent without a lookup table. They are also
 * append-only and never reused (the `skill` SG-5 discipline): changing this function
 * would re-mint every id in the catalog and orphan every `worker_profiles.job_domain_id`
 * pointing at the old ones. Treat it as frozen once seeded.
 */
export function jobDomainIdFor(record: Pick<JobDomainSeedRecord, "source" | "code" | "id_slug">): string {
  if (record.source === "rvm") {
    const slug = (record.id_slug ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
    return `jd_rvm_${slug}`;
  }
  const scheme = record.source === "isco08" ? "isco" : "nco";
  // NCO codes carry a dot ("7223.0100"); ids stay [a-z0-9_] so they are safe in a URL,
  // a log line, and a prompt without quoting.
  const code = (record.code ?? "").replace(/\./g, "_");
  return `jd_${scheme}_${code}`;
}

/** Read every `*.jsonl` in the corpus directory, in filename order. */
export function loadJobDomainCorpus(dir: string = JOB_DOMAIN_DATA_DIR): JobDomainSeedRecord[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  const out: JobDomainSeedRecord[] = [];
  for (const file of files) {
    const raw = readFileSync(join(dir, file), "utf8");
    raw.split(/\r?\n/).forEach((line, i) => {
      const trimmed = line.trim();
      // Blank lines and `#` comments are allowed so a corpus file can carry a
      // provenance header naming the source URL it was scraped from.
      if (trimmed.length === 0 || trimmed.startsWith("#")) return;
      try {
        out.push(JSON.parse(trimmed) as JobDomainSeedRecord);
      } catch {
        throw new Error(`${file}:${i + 1} is not valid JSON`);
      }
    });
  }
  return out;
}

/**
 * Every problem with the corpus, as human-readable strings. EMPTY MEANS SEEDABLE.
 *
 * Returns a list rather than throwing on the first fault on purpose: a scrape tends to
 * fail in families (one truncated major group produces dozens of orphans), and fixing
 * them one exception per run is miserable.
 */
export function validateJobDomainCorpus(records: JobDomainSeedRecord[]): string[] {
  const problems: string[] = [];
  if (records.length === 0) {
    return ["corpus is EMPTY — no *.jsonl files found, or every line was a comment"];
  }

  // Widened to Set<string> deliberately: ROLES/INDUSTRIES are `as const`, so the
  // inferred Set would be of literal-union type and `.has(someString)` would not
  // typecheck. The whole job here is to test an ARBITRARY corpus string for
  // membership — narrowing is what we are checking, not something we can assume.
  const roleIds = new Set<string>(ROLES.map((r) => r.id));
  const industryIds = new Set<string>(INDUSTRIES.map((i) => i.id));

  // (source, code) -> id, so a parent_code can be resolved within its own scheme.
  const bySchemeCode = new Map<string, ResolvedJobDomain>();
  const seenIds = new Set<string>();
  const resolved: ResolvedJobDomain[] = [];

  for (const r of records) {
    const where = `${r.source}:${r.code ?? r.id_slug ?? "<no code>"}`;

    if (!SOURCES.includes(r.source)) {
      problems.push(`${where}: unknown source ${JSON.stringify(r.source)}`);
      continue;
    }
    // Only a MINTED row may omit a published code — otherwise a scrape gap would enter
    // the catalog as an unverifiable, codeless row. Mirrors job_domain_source_code_chk.
    if (r.source !== "rvm" && !r.code) {
      problems.push(`${where}: a ${r.source} row must carry its published code`);
      continue;
    }
    if (r.source === "rvm" && !r.id_slug) {
      problems.push(`${where}: an rvm row must carry id_slug (there is no code to derive an id from)`);
      continue;
    }

    const id = jobDomainIdFor(r);
    if (!ID_RE.test(id)) {
      problems.push(`${where}: derived id ${JSON.stringify(id)} does not match ${ID_RE}`);
      continue;
    }
    if (seenIds.has(id)) {
      problems.push(`${where}: duplicate job_domain_id ${id}`);
      continue;
    }
    seenIds.add(id);

    if (!Number.isInteger(r.level) || r.level < 1 || r.level > 5) {
      problems.push(`${id}: level must be an integer 1..5, got ${r.level}`);
    }
    if (!r.label_en || r.label_en.trim().length === 0) {
      problems.push(`${id}: label_en is required`);
    }
    if (r.skill_level !== null && r.skill_level !== undefined) {
      if (!Number.isInteger(r.skill_level) || r.skill_level < 1 || r.skill_level > 4) {
        problems.push(`${id}: skill_level must be null or an integer 1..4, got ${r.skill_level}`);
      }
    }
    // Mirrors job_domain_selectable_leaf_chk. A bucket ("Craft and Related Trades
    // Workers") is real navigation but not a job anybody holds.
    if (r.selectable && r.level < 4) {
      problems.push(`${id}: selectable rows must be level >= 4 (this is level ${r.level})`);
    }
    // A selectable row with no aliases is INVISIBLE to retrieval — we embed aliases,
    // not the canonical label — so it is a silent hole in coverage rather than an error
    // anyone would notice. This check is the whole reason to validate before seeding.
    if (r.selectable && (!Array.isArray(r.aliases) || r.aliases.length === 0)) {
      problems.push(`${id}: selectable but has zero aliases — it could never be retrieved`);
    }
    for (const a of r.aliases ?? []) {
      if (!a.text || a.text.trim().length === 0) problems.push(`${id}: an alias has empty text`);
      if (!LANGS.includes(a.lang)) problems.push(`${id}: alias ${JSON.stringify(a.text)} has lang ${JSON.stringify(a.lang)}`);
      if (!SOURCES.includes(a.source)) problems.push(`${id}: alias ${JSON.stringify(a.text)} has unknown source`);
    }
    if (r.canonical_role_id && !roleIds.has(r.canonical_role_id)) {
      problems.push(
        `${id}: canonical_role_id ${JSON.stringify(r.canonical_role_id)} is not a @badabhai/taxonomy ROLE. ` +
          `The crosswalk must point at the 13-role space the match engine understands, or be null.`,
      );
    }
    if (r.industry_id && !industryIds.has(r.industry_id)) {
      problems.push(`${id}: industry_id ${JSON.stringify(r.industry_id)} is not a @badabhai/taxonomy INDUSTRY`);
    }

    const entry: ResolvedJobDomain = { ...r, jobDomainId: id, parentJobDomainId: null };
    resolved.push(entry);
    if (r.code) {
      const key = `${r.source}|${r.code}`;
      if (bySchemeCode.has(key)) problems.push(`${id}: duplicate (source, code) ${key}`);
      bySchemeCode.set(key, entry);
    }
  }

  // Second pass: parents. Deliberately separate, because a parent may appear anywhere
  // in the file (or in a different file) — the seed has the same two-pass shape.
  for (const r of resolved) {
    if (r.level === 1) {
      if (r.parent_code) problems.push(`${r.jobDomainId}: level 1 must not have a parent_code`);
      continue;
    }
    if (!r.parent_code) {
      problems.push(`${r.jobDomainId}: level ${r.level} requires a parent_code`);
      continue;
    }
    const parentScheme = r.parent_source ?? r.source;
    const parent = bySchemeCode.get(`${parentScheme}|${r.parent_code}`);
    if (!parent) {
      problems.push(
        `${r.jobDomainId}: parent_code ${JSON.stringify(r.parent_code)} is not in the ` +
          `${parentScheme} corpus (a truncated scrape leaves orphans like this)`,
      );
      continue;
    }
    if (parent.level !== r.level - 1) {
      problems.push(
        `${r.jobDomainId}: parent ${parent.jobDomainId} is level ${parent.level}, expected ${r.level - 1}`,
      );
    }
    r.parentJobDomainId = parent.jobDomainId;
  }

  return problems;
}

/** Load + validate + attach derived ids. Throws with EVERY problem listed. */
export function resolveJobDomainCorpus(dir: string = JOB_DOMAIN_DATA_DIR): ResolvedJobDomain[] {
  const records = loadJobDomainCorpus(dir);
  const problems = validateJobDomainCorpus(records);
  if (problems.length > 0) {
    throw new Error(`job-domain corpus invalid:\n  - ${problems.join("\n  - ")}`);
  }
  // Re-resolve so callers get the parent pointers the validator computed.
  const resolved: ResolvedJobDomain[] = records.map((r) => ({
    ...r,
    jobDomainId: jobDomainIdFor(r),
    parentJobDomainId: null,
  }));
  const byKey = new Map(resolved.filter((r) => r.code).map((r) => [`${r.source}|${r.code}`, r]));
  for (const r of resolved) {
    if (r.parent_code) {
      // `parent_source` defaults to the row's own scheme; NCO rows set it to `isco08`.
      const scheme = r.parent_source ?? r.source;
      r.parentJobDomainId = byKey.get(`${scheme}|${r.parent_code}`)?.jobDomainId ?? null;
    }
  }
  return resolved;
}

/** Counts for the seed's dry-run summary. Ids + integers only (never row contents). */
export function summariseCorpus(records: ResolvedJobDomain[]): Record<string, number> {
  const byLevel: Record<string, number> = {};
  for (const r of records) byLevel[`level_${r.level}`] = (byLevel[`level_${r.level}`] ?? 0) + 1;
  return {
    domains: records.length,
    selectable: records.filter((r) => r.selectable).length,
    aliases: records.reduce((n, r) => n + (r.aliases?.length ?? 0), 0),
    with_crosswalk: records.filter((r) => r.canonical_role_id).length,
    ...byLevel,
  };
}
