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
 * THREE KINDS OF LINE. A line is a DOMAIN unless tagged `"kind":"alias"`, in which case it
 * is a vernacular ALIAS OVERLAY attached to an existing domain (Phase 2), or
 * `"kind":"retire"`, a reviewed decision that an existing alias must stop routing workers.
 * The published files carry no tag and are therefore untouched. See
 * `JobDomainAliasOverlayRecord` for why the authored aliases live in their own file
 * rather than inside the scraped domain lines, `validateAliasOverlay` for the checks
 * that make an unreachable or PII-bearing alias impossible to commit, and
 * `JobDomainAliasRetirementRecord` for why a retirement is a record rather than a deletion.
 *
 * PRIVACY: published occupation titles, definitions and codes. No worker PII, by
 * construction — nothing worker-derived can reach this file.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { normalizeOccupationText } from "@badabhai/profiling-lexicon";
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

/**
 * An ALIAS OVERLAY line — one vernacular alias attached to an existing domain.
 *
 * WHY A SECOND RECORD KIND RATHER THAN EDITING THE DOMAIN LINES. The scraped files
 * (`isco08.jsonl`, `nco2015.jsonl`) are a faithful copy of a published standard, and
 * their value is that a reviewer can diff them against that standard. Threading ~3,000
 * hand-authored Hinglish aliases INTO those lines would destroy that property: every
 * domain line would become a mix of published text and our text, and the next scrape
 * refresh would have to merge rather than replace. Keeping the overlay in its own file
 * means the published corpus stays replaceable and the authored corpus stays reviewable
 * on its own terms — which is also what makes "every alias has a reviewer in the git
 * blame" a real, checkable claim rather than an aspiration.
 *
 * The overlay is MERGED into `ResolvedJobDomain.aliases` by `resolveJobDomainCorpus`, so
 * every existing consumer (the seed, the audit, `summariseCorpus`) picks it up with no
 * change. That is deliberate: the alternative — a second seeding path — would be a
 * second place for the deterministic-id and embedding-safety rules to drift.
 */
export interface JobDomainAliasOverlayRecord {
  kind: "alias";
  /** The domain this alias attaches to. Must already exist in the domain corpus. */
  job_domain_id: string;
  text: string;
  lang: JobDomainLang;
  /**
   * Always `rvm`, and validated to be. An authored alias must never be able to claim it
   * came from a published standard — the `source` column is what an auditor uses to tell
   * "the government calls this a Gas Welder" from "we decided workers say gas welding
   * wala", and a mislabelled row makes that distinction unrecoverable.
   */
  source?: JobDomainSource;
}

/**
 * A RETIREMENT line — a reviewed decision that one alias must stop routing workers.
 *
 * WHY A RECORD AND NOT A DELETION. The corpus can only ever ADD to the database: the domain
 * seed inserts `ON CONFLICT DO NOTHING` and never deletes, and CLAUDE.md §10 forbids deleting
 * production rows anyway. So removing a line from a file changes nothing live — the row
 * stays, and stays searchable. Three signed rulings needed exactly that and were blocked on
 * it: A1 (plain `fitter` off Maintenance Fitter), A4 (the junk `Machine` split off "Milker,
 * Machine") and item 21 (`Press Operator`, the woollen-cloth press title). Two of those are
 * PUBLISHED aliases, which no authored file could ever have removed.
 *
 * WHAT IT DOES. A retirement never removes a row. It takes the alias out of RETRIEVAL,
 * everywhere at once: `resolveJobDomainCorpus` drops it from the index every offline
 * consumer builds, and `db:normalize:aliases` clears `is_searchable` on the live row, which
 * every retrieval layer (L0/L1 snapshot, L2 trigram, L3 vector) filters on. Because the
 * normalizer recomputes the flag FROM THIS FILE on every run, the decision is durable — a
 * later seed or `--renormalize` cannot quietly undo it — and reversible: delete the line and
 * re-run the normalizer.
 *
 * KEYED ON THE PHRASE, NOT THE ROW ID. `(job_domain_id, lang, text)` is how a reviewer names
 * an alias, and it resolves identically on production, staging and a CI database, where row
 * ids exist only once seeded. The effect covers the alias's whole normalized group — every
 * row on that domain whose text normalizes to the same key — because retrieval matches on
 * `text_norm`, and retiring one spelling while its twin stays searchable would retire nothing.
 *
 * Every field beyond the key is EVIDENCE, as in `alias-exclusions.ts`: a year from now the
 * reason and the ruling are the whole value of the line.
 */
export interface JobDomainAliasRetirementRecord {
  kind: "retire";
  /** The domain the alias hangs off. */
  job_domain_id: string;
  /** The alias EXACTLY as the corpus spells it — validated to name a real alias. */
  text: string;
  lang: JobDomainLang;
  /** The signed ruling this implements, e.g. "RVM worksheet Part 5, A4". */
  ruling: string;
  /** Why this alias must stop routing workers, in one sentence. */
  reason: string;
  decided_by: string;
  /** ISO date, YYYY-MM-DD. */
  decided_on: string;
}

/** One line of a corpus file: a domain by default, an overlay or a retirement when tagged. */
export type JobDomainCorpusLine =
  | JobDomainSeedRecord
  | JobDomainAliasOverlayRecord
  | JobDomainAliasRetirementRecord;

function isAliasOverlay(line: JobDomainCorpusLine): line is JobDomainAliasOverlayRecord {
  return (line as JobDomainAliasOverlayRecord).kind === "alias";
}

function isAliasRetirement(line: JobDomainCorpusLine): line is JobDomainAliasRetirementRecord {
  return (line as JobDomainAliasRetirementRecord).kind === "retire";
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
 * Length cap for an AUTHORED alias. The scraped corpus reaches 232 characters because it
 * carries OCR artefacts ("ISCO 08 Unit Group Details:"); an alias a worker would actually
 * say is short. The cap is a cheap way to catch a generator that pasted a definition
 * instead of a trade name.
 */
const MAX_OVERLAY_ALIAS_LEN = 60;

/**
 * Characters that must never appear in an authored alias.
 *
 * THIS IS A PII GUARD, not a style rule. The overlay's second generator mines real
 * `chat_messages`, so the corpus is one careless promotion away from carrying a phone
 * number, a handle or a link into a git-committed file that is then embedded and served.
 * An occupation name needs none of these: of the 8,695 scraped aliases only 21 contain a
 * digit and every one of those is a scrape artefact, so the rule costs nothing real.
 *
 * Digits are matched as an EXPLICIT class covering Latin and Devanagari rather than `\d`,
 * because JS `\d` is ASCII-only while Python's is Unicode-aware — the divergence this
 * repo has already been bitten by and documents at `skills.dto.ts:10-13`. A Devanagari
 * phone number must not pass a check that an ASCII one fails.
 */
const OVERLAY_FORBIDDEN_RE = /[0-9०-९@]|https?:|www\./i;

/**
 * The guard above, as a predicate, so the chat miner applies the IDENTICAL rule at mining
 * time instead of a lookalike of its own.
 *
 * It matters that this is shared rather than re-expressed. The validator is the last gate
 * before a commit, but the miner writes a REVIEW FILE first — and a mined salary figure or
 * phone number sitting in a review file has already left the database and landed on disk,
 * which is precisely what the guard exists to prevent. Two copies of the rule would drift,
 * and the copy that drifts is the one nobody tests.
 */
export function hasForbiddenAliasChars(text: string): boolean {
  return OVERLAY_FORBIDDEN_RE.test(text);
}

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

/**
 * Read every `*.jsonl` in the corpus directory, in filename order, and partition the
 * lines by kind. An untagged line is a DOMAIN — that default is what keeps the two
 * scraped files (4,071 untagged lines) valid without touching a byte of them.
 */
export function loadJobDomainCorpusLines(dir: string = JOB_DOMAIN_DATA_DIR): {
  domains: JobDomainSeedRecord[];
  overlays: JobDomainAliasOverlayRecord[];
  retirements: JobDomainAliasRetirementRecord[];
} {
  const domains: JobDomainSeedRecord[] = [];
  const overlays: JobDomainAliasOverlayRecord[] = [];
  const retirements: JobDomainAliasRetirementRecord[] = [];
  if (!existsSync(dir)) return { domains, overlays, retirements };
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  for (const file of files) {
    const raw = readFileSync(join(dir, file), "utf8");
    raw.split(/\r?\n/).forEach((line, i) => {
      const trimmed = line.trim();
      // Blank lines and `#` comments are allowed so a corpus file can carry a
      // provenance header naming the source URL it was scraped from.
      if (trimmed.length === 0 || trimmed.startsWith("#")) return;
      let parsed: JobDomainCorpusLine;
      try {
        parsed = JSON.parse(trimmed) as JobDomainCorpusLine;
      } catch {
        throw new Error(`${file}:${i + 1} is not valid JSON`);
      }
      // An unrecognised `kind` THROWS rather than being skipped. A silently ignored
      // line is how a corpus loses 3,000 aliases while every count still looks
      // plausible; the loader would rather refuse to run.
      const kind = (parsed as { kind?: unknown }).kind;
      if (kind !== undefined && kind !== "alias" && kind !== "retire" && kind !== "domain") {
        throw new Error(
          `${file}:${i + 1} has unknown kind ${JSON.stringify(kind)} (expected "domain", "alias" or "retire")`,
        );
      }
      if (isAliasOverlay(parsed)) overlays.push(parsed);
      else if (isAliasRetirement(parsed)) retirements.push(parsed);
      else domains.push(parsed as JobDomainSeedRecord);
    });
  }
  return { domains, overlays, retirements };
}

/**
 * Domain lines only. Kept with its original name and signature because two callers and
 * every test already depend on it; alias overlays are reached via
 * `loadJobDomainCorpusLines` or, more usually, already merged by
 * `resolveJobDomainCorpus`.
 */
export function loadJobDomainCorpus(dir: string = JOB_DOMAIN_DATA_DIR): JobDomainSeedRecord[] {
  return loadJobDomainCorpusLines(dir).domains;
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

/**
 * Every problem with the ALIAS OVERLAY, as human-readable strings. EMPTY MEANS SEEDABLE.
 *
 * Same collect-everything discipline as `validateJobDomainCorpus`: a bad generator run
 * fails in families, and fixing 400 aliases one exception per run is miserable.
 *
 * The interesting check is the normalizer one. `text_norm` is what every lexical
 * retrieval layer (L0 exact, L1 skeleton, L2 trigram) actually matches against, so an
 * alias whose text normalizes to nothing is not a weak alias — it is an unreachable row
 * that still costs an embedding. Running the REAL Phase 1 normalizer here, rather than a
 * reimplementation, is also what makes "the normalizer round-trips identically in the
 * seeder and the query path" true by construction instead of by assertion.
 */
export function validateAliasOverlay(
  overlays: JobDomainAliasOverlayRecord[],
  domains: ResolvedJobDomain[],
): string[] {
  const problems: string[] = [];
  const byId = new Map(domains.map((d) => [d.jobDomainId, d]));

  // (job_domain_id, lang, text) already claimed — by the published corpus or by an
  // earlier overlay line. Exact repeats are a no-op at seed time (the deterministic id
  // collides and ON CONFLICT DO NOTHING fires), so they are not a data hazard; they are
  // a HONESTY hazard, because they inflate the corpus's apparent size. Rejected.
  const claimed = new Set<string>();
  // The same, but keyed on the NORMALIZED text — which is what `is_searchable` dedupes
  // on and what every lexical layer matches against. Two rows that normalize alike are
  // not two aliases: exactly one wins `is_searchable`, and the loser is an unreachable
  // row that still costs an embedding. This is the check that stops the corpus being
  // padded with `"welding"`, `"welding wala"` and `"welding ka kaam"` — the particle
  // stripper collapses all three to `welding`, so the last two buy nothing at all.
  const claimedNorm = new Map<string, string>();
  for (const d of domains) {
    for (const a of d.aliases ?? []) {
      claimed.add(`${d.jobDomainId}|${a.lang}|${a.text}`);
      claimedNorm.set(`${d.jobDomainId}|${a.lang}|${normalizeOccupationText(a.text)}`, a.text);
    }
  }

  for (const [i, o] of overlays.entries()) {
    const where = `alias[${i}] ${JSON.stringify(o.text ?? "")} -> ${o.job_domain_id ?? "<no id>"}`;

    if (!o.job_domain_id || !ID_RE.test(o.job_domain_id)) {
      problems.push(`${where}: job_domain_id is missing or does not match ${ID_RE}`);
      continue;
    }
    const domain = byId.get(o.job_domain_id);
    if (!domain) {
      problems.push(`${where}: job_domain_id is not in the domain corpus (a renamed or mistyped id lands here)`);
      continue;
    }
    // is_searchable requires `selectable AND status='active'`, so an alias on a bucket
    // row is dead weight: it seeds, it embeds, and retrieval never sees it.
    if (!domain.selectable) {
      problems.push(`${where}: target domain is not selectable, so this alias could never be retrieved`);
    }
    if (!LANGS.includes(o.lang)) {
      problems.push(`${where}: lang must be one of ${LANGS.join("|")}, got ${JSON.stringify(o.lang)}`);
    }
    if (o.source !== undefined && o.source !== "rvm") {
      problems.push(`${where}: an authored alias must be source 'rvm', never ${JSON.stringify(o.source)}`);
    }

    const text = o.text ?? "";
    if (text.trim().length === 0) {
      problems.push(`${where}: text is empty`);
      continue;
    }
    if (text !== text.trim()) {
      problems.push(`${where}: text has leading or trailing whitespace`);
    }
    if (text.length > MAX_OVERLAY_ALIAS_LEN) {
      problems.push(`${where}: text is ${text.length} chars, over the ${MAX_OVERLAY_ALIAS_LEN} cap`);
    }
    if (OVERLAY_FORBIDDEN_RE.test(text)) {
      problems.push(
        `${where}: text contains a digit, '@' or a URL. An occupation name needs none of these, ` +
          `and this is the guard that stops a mined phone number reaching a committed file.`,
      );
    }
    const norm = normalizeOccupationText(text);
    if (norm.length === 0) {
      problems.push(
        `${where}: normalizes to the empty string, so no lexical layer could ever match it ` +
          `(it would still cost an embedding).`,
      );
      continue;
    }

    const key = `${o.job_domain_id}|${o.lang}|${text}`;
    if (claimed.has(key)) {
      problems.push(`${where}: duplicate — this exact (domain, lang, text) is already in the corpus`);
    }
    claimed.add(key);

    const normKey = `${o.job_domain_id}|${o.lang}|${norm}`;
    const collidesWith = claimedNorm.get(normKey);
    if (collidesWith !== undefined && collidesWith !== text) {
      problems.push(
        `${where}: normalizes to ${JSON.stringify(norm)}, same as ${JSON.stringify(collidesWith)} on this ` +
          `domain. Only one of them can win is_searchable, so the other is an unreachable row — ` +
          `drop it, or make it differ by more than a stripped particle.`,
      );
    }
    claimedNorm.set(normKey, text);
  }

  return problems;
}

/**
 * A retired alias as retrieval sees it: the domain, the language and the NORMALIZED text —
 * the same triple `is_searchable` dedupes on and every lexical layer matches against.
 */
export interface RetiredAliasKey {
  jobDomainId: string;
  lang: JobDomainLang;
  textNorm: string;
}

/** The retrieval key a retirement line names. Runs the REAL normalizer, never a lookalike. */
export function retiredAliasKey(
  r: Pick<JobDomainAliasRetirementRecord, "job_domain_id" | "lang" | "text">,
): RetiredAliasKey {
  return { jobDomainId: r.job_domain_id, lang: r.lang, textNorm: normalizeOccupationText(r.text) };
}

/** A retirement key as one comparable string — the only spelling of it anywhere. */
export function retiredKeyString(jobDomainId: string, lang: string, textNorm: string): string {
  return `${jobDomainId}|${lang}|${textNorm}`;
}


const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RETIREMENT_EVIDENCE_FIELDS = ["ruling", "reason", "decided_by"] as const;

/**
 * Every problem with the RETIREMENT lines, as human-readable strings. EMPTY MEANS APPLICABLE.
 *
 * `domains` is the corpus AFTER the overlay merge and BEFORE any retirement, because a
 * retirement may name a published alias or an authored one.
 *
 * The two checks that matter most are the ones that stop a retirement doing the wrong
 * amount. One that names no alias would retire NOTHING — a typo that reads as a decision
 * taken. One that removes a selectable domain's last alias would make that occupation
 * unreachable by any phrase; that is sometimes the right answer, but it is a second
 * decision, so it is refused until a replacement alias names what workers should say instead.
 */
export function validateAliasRetirements(
  retirements: readonly JobDomainAliasRetirementRecord[],
  domains: readonly ResolvedJobDomain[],
): string[] {
  const problems: string[] = [];
  const byId = new Map(domains.map((d) => [d.jobDomainId, d]));
  const seen = new Set<string>();
  const retiredByDomain = new Map<string, Set<string>>();

  for (const [i, r] of retirements.entries()) {
    const where = `retire[${i}] ${JSON.stringify(r.text ?? "")} -> ${r.job_domain_id ?? "<no id>"}`;

    if (!r.job_domain_id || !ID_RE.test(r.job_domain_id)) {
      problems.push(`${where}: job_domain_id is missing or does not match ${ID_RE}`);
      continue;
    }
    const domain = byId.get(r.job_domain_id);
    if (!domain) {
      problems.push(`${where}: job_domain_id is not in the domain corpus`);
      continue;
    }
    if (!LANGS.includes(r.lang)) {
      problems.push(`${where}: lang must be one of ${LANGS.join("|")}, got ${JSON.stringify(r.lang)}`);
      continue;
    }
    for (const field of RETIREMENT_EVIDENCE_FIELDS) {
      const value = r[field];
      if (typeof value !== "string" || value.trim().length === 0) {
        problems.push(`${where}: ${field} is required — a retirement is a recorded decision, not a silent edit`);
      }
    }
    if (typeof r.decided_on !== "string" || !ISO_DATE_RE.test(r.decided_on) || Number.isNaN(Date.parse(r.decided_on))) {
      problems.push(`${where}: decided_on must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(r.decided_on)}`);
    }

    const text = r.text ?? "";
    const named = (domain.aliases ?? []).some((a) => a.text === text && a.lang === r.lang);
    if (!named) {
      problems.push(
        `${where}: names no alias on that domain — the text and lang must match an existing alias exactly, ` +
          `or this line would retire nothing while reading as a decision taken`,
      );
      continue;
    }

    const { textNorm } = retiredAliasKey(r);
    const key = retiredKeyString(r.job_domain_id, r.lang, textNorm);
    if (seen.has(key)) {
      problems.push(`${where}: duplicate — this alias (or a spelling that normalizes alike) is already retired`);
      continue;
    }
    seen.add(key);
    const set = retiredByDomain.get(r.job_domain_id) ?? new Set<string>();
    set.add(key);
    retiredByDomain.set(r.job_domain_id, set);
  }

  for (const [jobDomainId, retired] of retiredByDomain) {
    const domain = byId.get(jobDomainId);
    if (!domain?.selectable) continue;
    const kept = (domain.aliases ?? []).filter(
      (a) => !retired.has(retiredKeyString(jobDomainId, a.lang, normalizeOccupationText(a.text))),
    );
    if (kept.length === 0) {
      problems.push(
        `${jobDomainId}: the retirements remove EVERY alias it has, so no phrase could ever reach this ` +
          `occupation. Add the alias workers should use instead to rvm-aliases.jsonl in the same change.`,
      );
    }
  }

  return problems;
}

/**
 * The corpus with every retired alias removed — what retrieval can actually see.
 *
 * Returns NEW domain objects for the domains it touches and the originals for the rest, so a
 * caller holding the unretired corpus is never mutated under it.
 */
export function applyAliasRetirements(
  domains: readonly ResolvedJobDomain[],
  retirements: readonly JobDomainAliasRetirementRecord[],
): ResolvedJobDomain[] {
  if (retirements.length === 0) return [...domains];
  const retiredByDomain = new Map<string, Set<string>>();
  for (const r of retirements) {
    const { textNorm } = retiredAliasKey(r);
    const set = retiredByDomain.get(r.job_domain_id) ?? new Set<string>();
    set.add(retiredKeyString(r.job_domain_id, r.lang, textNorm));
    retiredByDomain.set(r.job_domain_id, set);
  }
  return domains.map((d) => {
    const retired = retiredByDomain.get(d.jobDomainId);
    if (!retired) return d;
    return {
      ...d,
      aliases: (d.aliases ?? []).filter(
        (a) => !retired.has(retiredKeyString(d.jobDomainId, a.lang, normalizeOccupationText(a.text))),
      ),
    };
  });
}

export interface ResolveJobDomainCorpusOptions {
  /**
   * Keep retired aliases in each domain's `aliases`. ONLY for the two consumers that reason
   * about ROWS rather than retrieval: the seed, which writes every row so a fresh database
   * ends up in the same state as production (the row exists, the normalizer marks it
   * unsearchable), and the id-by-id audit, which would otherwise report every retired row
   * as an unexplained extra. Everything that builds an index or measures routing wants the
   * default.
   */
  includeRetiredAliases?: boolean;
}

/**
 * Load + validate + attach derived ids, with the alias overlay merged into each domain's
 * `aliases` and — by default — every retired alias removed. Throws with EVERY problem listed.
 *
 * THE DEFAULT IS THE RETRIEVAL VIEW, deliberately. The consumers that build an occupation
 * index (the eval, the reachability pins, the chat miner, the chip-label tests) must measure
 * the phrases a worker can actually reach, and a forgotten option would otherwise let them
 * report a route production no longer takes. A row-level consumer that forgets the option
 * fails loudly instead (the audit reports extras), which is the safe direction.
 */
export function resolveJobDomainCorpus(
  dir: string = JOB_DOMAIN_DATA_DIR,
  options: ResolveJobDomainCorpusOptions = {},
): ResolvedJobDomain[] {
  const { domains, retirements } = resolveMergedCorpus(dir);
  return options.includeRetiredAliases === true ? domains : applyAliasRetirements(domains, retirements);
}

/**
 * The retrieval keys of every retirement on file, after validating the WHOLE corpus — so the
 * normalizer and the verifiers refuse to act on a retirement list the seed would reject.
 */
export function loadRetiredAliasKeys(dir: string = JOB_DOMAIN_DATA_DIR): RetiredAliasKey[] {
  return resolveMergedCorpus(dir).retirements.map(retiredAliasKey);
}

/** Domains with ids, parents and the overlay merged; retirements validated but NOT applied. */
function resolveMergedCorpus(dir: string): {
  domains: ResolvedJobDomain[];
  retirements: JobDomainAliasRetirementRecord[];
} {
  const { domains: records, overlays, retirements } = loadJobDomainCorpusLines(dir);
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

  // ── Alias overlay ─────────────────────────────────────────────────────────
  // Validated against the RESOLVED domains (it needs `jobDomainId` and `selectable`),
  // then merged into `aliases` so every downstream consumer sees one alias list. The
  // overlay is appended, never prepended: `is_searchable`'s dedupe tie-break prefers the
  // shorter text and then the lower id, not the array position, so order carries no
  // meaning — appending simply keeps a diff of the published rows readable.
  const overlayProblems = validateAliasOverlay(overlays, resolved);
  if (overlayProblems.length > 0) {
    throw new Error(`job-domain alias overlay invalid:\n  - ${overlayProblems.join("\n  - ")}`);
  }
  const byId = new Map(resolved.map((r) => [r.jobDomainId, r]));
  for (const o of overlays) {
    const domain = byId.get(o.job_domain_id);
    if (!domain) continue; // unreachable: the validator above already threw.
    domain.aliases = [...(domain.aliases ?? []), { text: o.text, lang: o.lang, source: o.source ?? "rvm" }];
  }

  // ── Retirements ───────────────────────────────────────────────────────────
  // Validated against the MERGED aliases, because a retirement may name a published alias
  // or an authored one. Applied by the caller, never here — see `resolveJobDomainCorpus`.
  const retirementProblems = validateAliasRetirements(retirements, resolved);
  if (retirementProblems.length > 0) {
    throw new Error(`job-domain alias retirements invalid:\n  - ${retirementProblems.join("\n  - ")}`);
  }

  return { domains: resolved, retirements };
}

/** Counts for the seed's dry-run summary. Ids + integers only (never row contents). */
export function summariseCorpus(records: ResolvedJobDomain[]): Record<string, number> {
  const byLevel: Record<string, number> = {};
  for (const r of records) byLevel[`level_${r.level}`] = (byLevel[`level_${r.level}`] ?? 0) + 1;
  // Broken out by source so a dry run states how much of the corpus is AUTHORED rather
  // than scraped. That number is the Phase 2 deliverable, and a single `aliases` total
  // would hide it entirely.
  const bySource: Record<string, number> = {};
  for (const r of records) {
    for (const a of r.aliases ?? []) bySource[`aliases_${a.source}`] = (bySource[`aliases_${a.source}`] ?? 0) + 1;
  }
  return {
    domains: records.length,
    selectable: records.filter((r) => r.selectable).length,
    aliases: records.reduce((n, r) => n + (r.aliases?.length ?? 0), 0),
    ...bySource,
    with_crosswalk: records.filter((r) => r.canonical_role_id).length,
    ...byLevel,
  };
}
