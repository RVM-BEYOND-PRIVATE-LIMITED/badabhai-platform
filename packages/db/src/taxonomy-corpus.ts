/**
 * The canonical Domain -> Skill taxonomy corpus — loader + validator for the seed data
 * behind `skill`, `skill_alias` and `job_domain_skill` (migration 0076, already applied).
 *
 * ---------------------------------------------------------------------------
 * WHY THE DATA LIVES IN packages/db/data AND NOT IN @badabhai/taxonomy
 * ---------------------------------------------------------------------------
 * `job-domain-corpus.ts` already makes half of this argument: `@badabhai/taxonomy` is
 * imported by apps/web and apps/payer-web, so it must stay browser-safe and cheap to
 * typecheck, and a thousand-entry `as const satisfies` would wreck `tsc`.
 *
 * The taxonomy corpus has a SECOND, harder reason, and it is the one that decides the
 * question. `packages/taxonomy/src/match-skills.test.ts` asserts that
 * `ATTRIBUTE_TO_MATCH_SKILLS` is EXHAUSTIVE over `SKILL_CORPUS` — every attribute skill
 * must carry a hand-authored bridge into the closed 18-member `mskill_*` matchable
 * vocabulary. That test is correct and load-bearing: it is what stops a descriptive skill
 * silently becoming invisible to matching. But it also means every id appended to
 * `SKILL_CORPUS` costs a hand-authored bridge entry, and hand-authoring does not scale to
 * a corpus generated per trade.
 *
 * So: new canonical skills live HERE, as JSONL, seeded by `seed-domain-skills.ts`, and
 * `SKILL_CORPUS` DOES NOT GROW. This file imports it READ-ONLY, for exactly one purpose —
 * to refuse an id that would collide with a shipped one.
 *
 * WHY JSONL. Same reason as the job-domain corpus: one record per line makes a corpus
 * update a line-diffable review ("12 skills added"), and it is the shape a batch pipeline
 * naturally produces. A single JSON array re-indents on every edit and makes review
 * meaningless.
 *
 * ---------------------------------------------------------------------------
 * THE VALIDATOR IS THE POINT OF THIS FILE
 * ---------------------------------------------------------------------------
 * Nothing reaches the database until `validateTaxonomyCorpus` returns clean. Every check
 * in it exists because the corresponding bad row is INVISIBLE once seeded:
 *
 *   * a skill with no edges seeds fine and is never shown to anyone;
 *   * a domain with no edges seeds fine and renders the employer picker EMPTY for that
 *     trade — the single most visible failure this whole taxonomy can have;
 *   * two skills whose labels normalize alike seed fine and permanently split one concept
 *     into two, so half the workers who have it never match the postings that want it;
 *   * an alias owned by two skills seeds fine and makes canonicalization a coin flip;
 *   * a digit or an '@' in a label seeds fine, is committed to git, and is then embedded
 *     and served.
 *
 * None of these throw at run time. They just make the product quietly worse for one
 * trade, which is the hardest kind of bug to notice and the cheapest kind to prevent.
 *
 * RETURNS EVERY PROBLEM, NEVER THROWS ON THE FIRST — inherited deliberately from
 * `validateJobDomainCorpus`. Generation errors arrive in families (one bad batch produces
 * dozens of the same fault) and fixing them one exception per run is miserable enough
 * that people stop running the validator.
 *
 * ---------------------------------------------------------------------------
 * PROBLEM MESSAGE FORMAT — `locator: CODE — prose`
 * ---------------------------------------------------------------------------
 * e.g. `skill[skill_fanuc_cnc]: ALIAS_AMBIGUOUS — "fanuc" is already an alias of ...`
 *
 * The LOCATOR names the offending record so `--ingest` can drop exactly that candidate
 * instead of re-deriving the rule (`generate-domain-aliases.ts` does the same thing with
 * its `alias[<i>]` prefix). The CODE is what the batch manifest's rejection summary counts
 * by — a summary keyed on free prose would re-bucket itself every time someone improved a
 * sentence. The prose is for the human who has to fix it, and says WHY, not just what.
 *
 * PRIVACY: trade vocabulary and published occupation ids. No worker data can reach this
 * file by construction — the generator reads `job_domain`, never a worker row. The
 * forbidden-character guard is reused from `job-domain-corpus.ts` anyway, because a model
 * asked for skill names can still return something shaped like a contact detail.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { normalizeOccupationText } from "@badabhai/profiling-lexicon";
import { MATCH_SKILLS, SKILL_CORPUS } from "@badabhai/taxonomy";

import { hasForbiddenAliasChars } from "./job-domain-corpus";
import type { JobDomainSkillSource, SkillRequirement } from "./schema/taxonomy";

/** Where the committed corpus lives, resolved relative to this module so it works
 *  identically from `src/` (tsx) and `dist/` (built) — same trick as JOB_DOMAIN_DATA_DIR. */
export const TAXONOMY_DATA_DIR = join(__dirname, "..", "data", "taxonomy");

/** One directory per external generation batch. See `generate-domain-skills.ts`. */
export const TAXONOMY_BATCHES_DIR = join(TAXONOMY_DATA_DIR, "batches");

export type TaxonomyLang = "en" | "hi";

// ===========================================================================
// Record kinds
// ===========================================================================

/**
 * A DOMAIN the corpus covers (`sample-domains.jsonl`).
 *
 * Deliberately a THIN pointer, not a copy of `job_domain`. The occupation catalogue is
 * already 4,071 rows in `data/job-domains/`, owned by its own scrape and its own
 * validator; duplicating level/parent/ISCO fields here would create a second, drifting
 * answer to "what is this trade". All this file needs is: which domains are in scope,
 * what a human calls them (for the domain-name-as-skill check and the prompt), and how
 * they cluster (`trade_group`, which is what makes a batch reviewable trade by trade).
 *
 * The `job_domain_id` is NOT re-derived here — it must already exist in the occupation
 * catalogue, and the seeder verifies that against the live table before it writes
 * anything (the `job_domain_skill.job_domain_id` FK would otherwise fail mid-run).
 */
export interface TaxonomyDomainRecord {
  /** Optional and always `"domain"`. Untagged lines are domains — see `loadTaxonomyCorpus`. */
  kind?: "domain";
  job_domain_id: string;
  label_en: string;
  /** Review/batching cluster ("cnc_machining"). Free text; not an id in any table. */
  trade_group: string;
}

/** One alias of a canonical skill. Becomes one `skill_alias` row. */
export interface TaxonomySkillAliasRecord {
  text: string;
  lang: TaxonomyLang;
}

/**
 * A canonical SKILL (`skills.jsonl`). Becomes one `skill` row with `kind='attribute'`.
 *
 * ATTRIBUTE, NEVER MATCHABLE. The `mskill_*` space is a closed 18-member vocabulary the
 * match engine consumes directly; this corpus is DESCRIPTIVE — it drives the employer's
 * skill picker and worker profiling, and invariant #4 keeps it out of ranking. That is
 * why `skill_id` is validated against `^skill_[a-z0-9_]+$` and an `mskill_*` id is
 * rejected with its own message rather than a generic format error.
 */
export interface TaxonomySkillRecord {
  kind: "skill";
  skill_id: string;
  label_en: string;
  label_hi: string | null;
  aliases: TaxonomySkillAliasRecord[];
  /**
   * DELIBERATE REUSE of an id that already exists in `SKILL_CORPUS`.
   *
   * The NORMAL way to reuse a shipped canonical skill is to not list it here at all and
   * simply reference its id from a `domain_skill` edge — the edge validator accepts any
   * `SKILL_CORPUS` id. This flag is for the narrower case where the corpus wants to ADD
   * ALIASES to a shipped skill, which needs a record to hang them on.
   *
   * It is opt-in and explicit because the default must be a hard failure: an id
   * collision that nobody noticed means two different concepts fighting over one row,
   * and the loser is silently re-labelled the next time either corpus is seeded. The
   * seeder never inserts or updates the `skill` row for a reuse record — the shipped row
   * stays authoritative for its labels, kind, status, source and legacy `domain_id`.
   */
  reuses_existing?: boolean;
}

/**
 * A domain <-> skill EDGE (`domain-skills.jsonl`). Becomes one `job_domain_skill` row.
 *
 * Mirrors the table's columns and nothing else. `inherited_from_job_domain_id` is
 * deliberately absent: this corpus is authored per domain, so it has no inheritance to
 * record. An `inherited` edge is legal in the enum (the ISCO ladder resolver writes them)
 * but a corpus file is not where one comes from.
 */
export interface TaxonomyDomainSkillRecord {
  kind: "domain_skill";
  job_domain_id: string;
  skill_id: string;
  default_requirement: SkillRequirement;
  relevance: number;
  /** NULL is legal and means "the question is moot" (a `curated` edge). */
  confidence: number | null;
  source: JobDomainSkillSource;
}

/** One line of a corpus file: a domain unless tagged `skill` or `domain_skill`. */
export type TaxonomyCorpusLine =
  | TaxonomyDomainRecord
  | TaxonomySkillRecord
  | TaxonomyDomainSkillRecord;

/** The three partitions a corpus directory resolves to. */
export interface TaxonomyCorpus {
  domains: TaxonomyDomainRecord[];
  skills: TaxonomySkillRecord[];
  edges: TaxonomyDomainSkillRecord[];
}

// ===========================================================================
// Vocabularies + limits
// ===========================================================================

/**
 * The DESCRIPTIVE skill id space. `mskill_*` is excluded by construction: it does not
 * start with `skill_`, so it fails this pattern — but it gets its own message anyway,
 * because "does not match a regex" is not a useful thing to tell someone who just tried
 * to add a 19th matchable skill.
 */
const SKILL_ID_RE = /^skill_[a-z0-9_]+$/;

/** The closed matchable vocabulary's prefix. Never mintable from this corpus. */
const MATCH_SKILL_PREFIX = "mskill_";

const REQUIREMENTS: readonly SkillRequirement[] = ["required", "preferred"];
const EDGE_SOURCES: readonly JobDomainSkillSource[] = ["llm_bootstrap", "inherited", "curated"];
const LANGS: readonly TaxonomyLang[] = ["en", "hi"];

/**
 * Length caps. An alias is something a worker or an employer types, so 60 characters is
 * generous (the same cap the authored occupation aliases use). A label is a display
 * string and 120 is the point past which it is a sentence, not a name.
 *
 * These are cheap catches for a generator that pasted a definition instead of a skill.
 */
const MAX_ALIAS_LEN = 60;
const MAX_LABEL_LEN = 120;

/**
 * SINGLE-WORD skills so generic that they carry no information.
 *
 * "Machine" on a CNC turning domain tells an employer nothing and tells the matcher
 * nothing; it also acts as an attractor during canonicalization, swallowing phrases that
 * should have resolved to a real skill. A model asked for 6-14 skills WILL pad with these
 * when it runs out of genuine ones, which is precisely when a human needs to look.
 *
 * FLAGGED, NOT SILENTLY DROPPED. Some of these are legitimate in a multi-word skill
 * ("machine maintenance", "safety interlock check"), so the rule only fires when the
 * normalized label is exactly ONE token. Even then the call is a human's: the check
 * reports a problem and the reviewer either deletes the row or renames it.
 */
export const GENERIC_SKILL_STOPLIST: readonly string[] = [
  "work",
  "working",
  "machine",
  "machinery",
  "safety",
  "tools",
  "tool",
  "operation",
  "operations",
  "operator",
  "labour",
  "labor",
  "job",
  "worker",
  "skill",
  "skills",
  "equipment",
  "process",
  "quality",
  "production",
  "experience",
  "helper",
  "general",
  "maintenance",
];

// ===========================================================================
// Problem codes
// ===========================================================================

/**
 * Every way this corpus can be wrong, as a stable machine-readable code.
 *
 * STABLE IS THE WHOLE POINT. The batch manifest summarises rejections BY CODE, so a run
 * six months from now is comparable with one today even after every sentence in this file
 * has been reworded. Adding a code is additive; renaming one breaks that comparison and
 * should be treated like renaming a column.
 */
export type TaxonomyProblemCode =
  // ── skill identity ────────────────────────────────────────────────────────
  | "SKILL_ID_FORMAT"
  | "SKILL_ID_MATCHABLE_PREFIX"
  | "SKILL_ID_COLLIDES_CORPUS"
  /** `reuses_existing: true` on an id that is not in SKILL_CORPUS — the inverse claim. */
  | "SKILL_ID_REUSE_UNKNOWN"
  | "SKILL_ID_DUPLICATE"
  // ── skill text ────────────────────────────────────────────────────────────
  | "SKILL_LABEL_MISSING"
  | "SKILL_LABEL_TOO_LONG"
  | "SKILL_LABEL_NORMALIZES_EMPTY"
  | "SKILL_LABEL_COLLIDES"
  | "SKILL_LABEL_IS_DOMAIN_NAME"
  | "SKILL_LABEL_OVER_GENERIC"
  | "TEXT_FORBIDDEN_CHARS"
  // ── aliases ───────────────────────────────────────────────────────────────
  | "ALIAS_LIST_INVALID"
  | "ALIAS_LIST_EMPTY"
  | "ALIAS_TEXT_EMPTY"
  | "ALIAS_TEXT_WHITESPACE"
  | "ALIAS_TOO_LONG"
  | "ALIAS_LANG_ENUM"
  | "ALIAS_NORMALIZES_EMPTY"
  | "ALIAS_DUPLICATE_WITHIN_SKILL"
  | "ALIAS_AMBIGUOUS"
  // ── edges ─────────────────────────────────────────────────────────────────
  | "EDGE_UNKNOWN_DOMAIN"
  | "EDGE_UNKNOWN_SKILL"
  | "EDGE_MATCHABLE_SKILL"
  | "EDGE_DUPLICATE"
  | "EDGE_REQUIREMENT_ENUM"
  | "EDGE_SOURCE_ENUM"
  | "EDGE_RELEVANCE_RANGE"
  | "EDGE_CONFIDENCE_RANGE"
  // ── coverage holes ────────────────────────────────────────────────────────
  | "SKILL_ORPHAN"
  | "DOMAIN_ORPHAN"
  // ── domain records ────────────────────────────────────────────────────────
  | "DOMAIN_ID_FORMAT"
  | "DOMAIN_DUPLICATE"
  | "DOMAIN_LABEL_MISSING";

/**
 * The joiners `normalizeOccupationText` keeps INTRA-WORD, plus whitespace.
 *
 * THE ONE TOKENIZER. It lives here, in the lowest layer, because there was briefly a second
 * one: this file used `labelNorm.split(" ")` while `taxonomy-lexical.ts` split on `/[\s/-]+/`,
 * and the two disagreed on exactly the characters the normalizer preserves. `"Machine/Tools"`
 * was one token to the validator (not in the stoplist, so not over-generic) and two tokens to
 * the analyzer (both generic, so zero informative tokens) — a label that was simultaneously
 * too specific to reject and too empty to compare, invisible to every detector downstream.
 * Two tokenizers is one too many; `taxonomy-lexical.ts` imports this.
 */
const TOKEN_SPLIT = /[\s/-]+/;

/** Split an ALREADY-NORMALIZED string into comparison tokens. */
export function taxonomyTokens(normalized: string): string[] {
  return normalized.split(TOKEN_SPLIT).filter((t) => t.length > 0);
}

const PROBLEM_SEPARATOR = " — ";

function problem(locator: string, code: TaxonomyProblemCode, detail: string): string {
  return `${locator}: ${code}${PROBLEM_SEPARATOR}${detail}`;
}

/**
 * Pull the stable code back out of a problem string, for the manifest's rejection
 * summary. Returns `"UNKNOWN"` rather than throwing, so a hand-written problem string
 * from somewhere else cannot break a report.
 */
export function taxonomyProblemCode(text: string): TaxonomyProblemCode | "UNKNOWN" {
  const match = /: ([A-Z_]+) — /.exec(text);
  return match?.[1] === undefined ? "UNKNOWN" : (match[1] as TaxonomyProblemCode);
}

/**
 * Pull the locator (`skill[...]`, `edge[...]`, `domain[...]`) back out of a problem
 * string. This is how `--ingest` drops exactly the offending candidate instead of
 * re-deriving the rule that rejected it.
 */
export function taxonomyProblemLocator(text: string): string | null {
  const match = /^([a-z_]+)\[([^\]]*)\]/.exec(text);
  return match === null ? null : `${match[1]}[${match[2]}]`;
}

/** The locator a skill record is reported under. Exported so the ingest can build the
 *  same key rather than string-matching on prose. */
export function skillLocator(skillId: string): string {
  return `skill[${skillId}]`;
}

/** The locator an edge is reported under. */
export function edgeLocator(jobDomainId: string, skillId: string): string {
  return `edge[${jobDomainId} -> ${skillId}]`;
}

// ===========================================================================
// The shipped vocabulary, imported READ-ONLY
// ===========================================================================

/**
 * Every id already claimed by `SKILL_CORPUS`, INCLUDING deprecated ones.
 *
 * Deprecated ids are included on purpose: SG-5 says a `skill_id` is never reused, so
 * minting a retired id is worse than colliding with a live one — the retag crosswalk
 * would silently point new rows at a successor chosen for a different concept.
 */
const SHIPPED_SKILL_IDS: ReadonlySet<string> = new Set(SKILL_CORPUS.map((s) => s.skillId));

/** The closed matchable vocabulary, for the edge check's error message. */
const MATCH_SKILL_COUNT = MATCH_SKILLS.length;

/** The shipped ids, for callers that want the default the validator uses. */
export function shippedSkillIds(): ReadonlySet<string> {
  return SHIPPED_SKILL_IDS;
}

/** One entry of the catalogue shown to the model so it can REUSE instead of re-minting. */
export interface SkillCatalogueEntry {
  skill_id: string;
  label_en: string;
}

/**
 * The catalogue a prompt shows the model: every skill it is allowed to echo the id of.
 *
 * DEPRECATED SKILLS ARE EXCLUDED. Telling a model it may reuse a retired id would produce
 * edges pointing at a row the retag runner is actively migrating away from. Already-
 * authored corpus skills are folded in via `extra`, so batch 2 reuses batch 1's work
 * instead of minting a synonym for it.
 */
export function skillCatalogue(extra: readonly TaxonomySkillRecord[] = []): SkillCatalogueEntry[] {
  const entries: SkillCatalogueEntry[] = SKILL_CORPUS.filter((s) => s.status !== "deprecated").map(
    (s) => ({ skill_id: s.skillId, label_en: s.labelEn }),
  );
  const seen = new Set(entries.map((e) => e.skill_id));
  for (const s of extra) {
    if (typeof s.skill_id !== "string" || seen.has(s.skill_id)) continue;
    seen.add(s.skill_id);
    entries.push({ skill_id: s.skill_id, label_en: s.label_en });
  }
  // Sorted so a prompt is byte-identical across runs for the same inputs — the property
  // `prompt_template_sha256` and the determinism test both depend on.
  entries.sort((a, b) => a.skill_id.localeCompare(b.skill_id));
  return entries;
}

/**
 * Mint a `skill_id` from a label.
 *
 * DERIVED, NEVER MODEL-SUPPLIED. The generator's prompt has no field for the model to put
 * an invented id in, and this is why: an id is an internal, immutable, never-reused
 * database key (SG-5), and a model that invents one produces something that looks
 * authoritative, survives review, and can never be corrected afterwards. The model
 * supplies a LABEL; the id is a pure function of it, so the same label always mints the
 * same id and a re-ingest is idempotent.
 *
 * Non `[a-z0-9]` runs collapse to `_` so the id is safe in a URL, a log line and a prompt
 * with no quoting — the same rule `jobDomainIdFor` applies.
 */
export function taxonomySkillIdFor(labelEn: string): string {
  const slug = labelEn
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `skill_${slug}`;
}

// ===========================================================================
// Loading
// ===========================================================================

function isSkillLine(line: TaxonomyCorpusLine): line is TaxonomySkillRecord {
  return (line as TaxonomySkillRecord).kind === "skill";
}

function isEdgeLine(line: TaxonomyCorpusLine): line is TaxonomyDomainSkillRecord {
  return (line as TaxonomyDomainSkillRecord).kind === "domain_skill";
}

/**
 * Read every `*.jsonl` in the corpus directory, in filename order, and partition by kind.
 *
 * READS THE DIRECTORY, NOT THREE PINNED FILENAMES. The committed layout is
 * `sample-domains.jsonl` / `skills.jsonl` / `domain-skills.jsonl`, and that layout keeps
 * working — but a batch that appends `skills-2026-08-cnc.jsonl` is then a pure ADD in the
 * diff rather than a rewrite of a growing file, which is the property that makes a corpus
 * reviewable at all. `batches/` is a subdirectory and does not end in `.jsonl`, so raw
 * model output can never be mistaken for committed corpus.
 *
 * An UNTAGGED line is a DOMAIN, matching `sample-domains.jsonl`'s pinned shape. An
 * unrecognised `kind` THROWS rather than being skipped: a silently ignored line is how a
 * corpus loses half its edges while every count still looks plausible.
 */
export function loadTaxonomyCorpus(dir: string = TAXONOMY_DATA_DIR): TaxonomyCorpus {
  const corpus: TaxonomyCorpus = { domains: [], skills: [], edges: [] };
  if (!existsSync(dir)) return corpus;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  for (const file of files) {
    const raw = readFileSync(join(dir, file), "utf8");
    raw.split(/\r?\n/).forEach((line, i) => {
      const trimmed = line.trim();
      // Blank lines and `#` comments are allowed so a corpus file can carry a provenance
      // header naming the batch it came from.
      if (trimmed.length === 0 || trimmed.startsWith("#")) return;
      let parsed: TaxonomyCorpusLine;
      try {
        parsed = JSON.parse(trimmed) as TaxonomyCorpusLine;
      } catch {
        throw new Error(`${file}:${i + 1} is not valid JSON`);
      }
      const kind = (parsed as { kind?: unknown }).kind;
      if (kind !== undefined && kind !== "domain" && kind !== "skill" && kind !== "domain_skill") {
        throw new Error(
          `${file}:${i + 1} has unknown kind ${JSON.stringify(kind)} ` +
            `(expected "domain", "skill" or "domain_skill")`,
        );
      }
      if (isSkillLine(parsed)) corpus.skills.push(parsed);
      else if (isEdgeLine(parsed)) corpus.edges.push(parsed);
      else corpus.domains.push(parsed as TaxonomyDomainRecord);
    });
  }
  return corpus;
}

// ===========================================================================
// Validation
// ===========================================================================

export interface ValidateTaxonomyCorpusOptions {
  /**
   * The domains in scope. REQUIRED, and it is the reason this is an options object rather
   * than a third positional argument: an edge cannot be checked without them, and an
   * accidental `undefined` would turn the whole `EDGE_UNKNOWN_DOMAIN` check into a no-op.
   */
  domains: readonly TaxonomyDomainRecord[];
  /**
   * The already-shipped ids to refuse. Defaults to `SKILL_CORPUS`. Injectable ONLY so the
   * tests can prove the collision check fires without depending on which ids happen to be
   * in the shipped corpus this month.
   */
  existingSkillIds?: ReadonlySet<string>;
  /** Extra single-word labels to flag, on top of `GENERIC_SKILL_STOPLIST`. */
  extraStoplist?: readonly string[];
}

/**
 * Every problem with the corpus, as human-readable strings. EMPTY MEANS SEEDABLE.
 *
 * See the file header for the `locator: CODE — prose` format and why it is machine
 * readable. See `GENERIC_SKILL_STOPLIST` and the two orphan checks for the ones that are
 * judgement calls surfaced to a human rather than hard structural faults — they are still
 * problems, because a seeder that runs "with warnings" is a seeder whose warnings nobody
 * reads.
 */
export function validateTaxonomyCorpus(
  skills: readonly TaxonomySkillRecord[],
  edges: readonly TaxonomyDomainSkillRecord[],
  opts: ValidateTaxonomyCorpusOptions,
): string[] {
  const problems: string[] = [];
  const shipped = opts.existingSkillIds ?? SHIPPED_SKILL_IDS;
  const stoplist = new Set<string>([...GENERIC_SKILL_STOPLIST, ...(opts.extraStoplist ?? [])]);

  // ── Domains ───────────────────────────────────────────────────────────────
  // Validated even though they are a thin pointer file: a mistyped `job_domain_id` here
  // makes every edge that references it an EDGE_UNKNOWN_DOMAIN, and reporting the cause
  // once beats reporting the symptom fourteen times.
  const domainById = new Map<string, TaxonomyDomainRecord>();
  const domainLabelNorms = new Map<string, string>();
  for (const d of opts.domains) {
    const id = typeof d.job_domain_id === "string" ? d.job_domain_id : "";
    const where = `domain[${id === "" ? "<no id>" : id}]`;
    if (!/^jd_[a-z0-9_]+$/.test(id)) {
      problems.push(
        problem(
          where,
          "DOMAIN_ID_FORMAT",
          `job_domain_id must match /^jd_[a-z0-9_]+$/ — this corpus points AT the occupation ` +
            `catalogue, it does not mint ids for it.`,
        ),
      );
      continue;
    }
    if (domainById.has(id)) {
      problems.push(problem(where, "DOMAIN_DUPLICATE", `this job_domain_id is listed twice.`));
      continue;
    }
    domainById.set(id, d);
    if (typeof d.label_en !== "string" || d.label_en.trim().length === 0) {
      problems.push(
        problem(
          where,
          "DOMAIN_LABEL_MISSING",
          `label_en is required — it is what the domain-name-as-skill check compares against.`,
        ),
      );
      continue;
    }
    const norm = normalizeOccupationText(d.label_en);
    if (norm.length > 0) domainLabelNorms.set(norm, id);
  }

  // ── Skills ────────────────────────────────────────────────────────────────
  /** Ids that passed identity checks — what an edge is allowed to reference. */
  const corpusSkillIds = new Set<string>();
  /** normalized label -> the skill that claimed it first. */
  const labelNormOwner = new Map<string, string>();
  /** `${lang}|${normalized alias}` -> the skill that claimed it first. */
  const aliasNormOwner = new Map<string, string>();
  const seenSkillIds = new Set<string>();

  for (const s of skills) {
    const rawId = typeof s.skill_id === "string" ? s.skill_id : "";
    const where = skillLocator(rawId === "" ? "<no id>" : rawId);

    // Identity faults are terminal for the record. Everything below them reads the id, so
    // continuing would attribute the record's other problems to a key nobody can act on.
    if (rawId.startsWith(MATCH_SKILL_PREFIX)) {
      problems.push(
        problem(
          where,
          "SKILL_ID_MATCHABLE_PREFIX",
          `'${MATCH_SKILL_PREFIX}*' is the CLOSED ${MATCH_SKILL_COUNT}-member matchable vocabulary ` +
            `(@badabhai/taxonomy MATCH_SKILLS) that the match engine consumes directly. This corpus ` +
            `is descriptive/attribute only (invariant #4) and can never mint one. Widening that ` +
            `vocabulary is an ADR + an engine_version bump, not a corpus line.`,
        ),
      );
      continue;
    }
    if (!SKILL_ID_RE.test(rawId)) {
      problems.push(
        problem(
          where,
          "SKILL_ID_FORMAT",
          `skill_id must match ${SKILL_ID_RE} — lowercase, underscore-separated, so it is safe ` +
            `unquoted in a URL, a log line and a prompt.`,
        ),
      );
      continue;
    }
    if (seenSkillIds.has(rawId)) {
      problems.push(
        problem(
          where,
          "SKILL_ID_DUPLICATE",
          `this skill_id appears twice in the corpus. Two records cannot own one immutable id; ` +
            `merge their aliases into a single record.`,
        ),
      );
      continue;
    }
    seenSkillIds.add(rawId);
    // THE INVERSE OF THE COLLISION CHECK BELOW, and it has to be its own rule because the
    // two failures look nothing alike. `reuses_existing: true` is an assertion that the id
    // is ALREADY in SKILL_CORPUS; set it on a fresh id and the record falls through every
    // identity check, the file-only gate prints "PASS — corpus is seedable", and the
    // contradiction only surfaces later against a live database — where `planSkillRows`
    // excludes the record (so no `skill` row is ever created) but `shippedDependencies`
    // still demands the id exist, and the seeder aborts with "run 'pnpm db:seed:skills'
    // first". That message names the wrong fix entirely: seeding the shipped corpus will
    // never produce an id that was never in it.
    if (s.reuses_existing === true && !shipped.has(rawId)) {
      problems.push(
        problem(
          where,
          "SKILL_ID_REUSE_UNKNOWN",
          `"reuses_existing": true claims this id is already in @badabhai/taxonomy ` +
            `SKILL_CORPUS, but it is not. Either drop the flag (and let this be minted as a ` +
            `NEW canonical skill), or correct the id to the shipped one you meant.`,
        ),
      );
      continue;
    }
    if (shipped.has(rawId) && s.reuses_existing !== true) {
      problems.push(
        problem(
          where,
          "SKILL_ID_COLLIDES_CORPUS",
          `this id is already owned by @badabhai/taxonomy SKILL_CORPUS. Reference it from a ` +
            `domain_skill edge instead of re-declaring it, or set "reuses_existing": true if you ` +
            `deliberately mean to add aliases to the SHIPPED skill (its labels and provenance stay ` +
            `authoritative; the seeder will not touch them).`,
        ),
      );
      continue;
    }
    corpusSkillIds.add(rawId);

    // ── label_en ────────────────────────────────────────────────────────────
    if (typeof s.label_en !== "string" || s.label_en.trim().length === 0) {
      problems.push(problem(where, "SKILL_LABEL_MISSING", `label_en is required.`));
      continue;
    }
    if (s.label_en.length > MAX_LABEL_LEN) {
      problems.push(
        problem(
          where,
          "SKILL_LABEL_TOO_LONG",
          `label_en is ${s.label_en.length} chars, over the ${MAX_LABEL_LEN} cap. A label this long ` +
            `is a definition, not a skill name.`,
        ),
      );
    }
    for (const [field, value] of [
      ["label_en", s.label_en],
      ["label_hi", s.label_hi],
    ] as const) {
      if (typeof value !== "string") continue;
      if (hasForbiddenAliasChars(value)) {
        problems.push(
          problem(
            where,
            "TEXT_FORBIDDEN_CHARS",
            `${field} ${JSON.stringify(value)} contains a digit, '@' or a URL. A skill name needs ` +
              `none of these, and this is the guard that stops a contact detail reaching a ` +
              `git-committed file that is then embedded and served.`,
          ),
        );
      }
      if (field === "label_hi" && value.length > MAX_LABEL_LEN) {
        problems.push(
          problem(where, "SKILL_LABEL_TOO_LONG", `label_hi is ${value.length} chars, over ${MAX_LABEL_LEN}.`),
        );
      }
    }

    const labelNorm = normalizeOccupationText(s.label_en);
    if (labelNorm.length === 0) {
      problems.push(
        problem(
          where,
          "SKILL_LABEL_NORMALIZES_EMPTY",
          `label_en ${JSON.stringify(s.label_en)} normalizes to the empty string, so nothing lexical ` +
            `could ever reach it.`,
        ),
      );
    } else {
      const owner = labelNormOwner.get(labelNorm);
      if (owner !== undefined) {
        problems.push(
          problem(
            where,
            "SKILL_LABEL_COLLIDES",
            `label_en ${JSON.stringify(s.label_en)} normalizes to ${JSON.stringify(labelNorm)}, the same ` +
              `as ${owner}. Two canonical skills for one concept split it permanently: half the ` +
              `workers who have it never match the postings that want it. Keep ONE canonical row and ` +
              `make the other an alias of it.`,
          ),
        );
      } else {
        labelNormOwner.set(labelNorm, rawId);
      }

      const domainNamed = domainLabelNorms.get(labelNorm);
      if (domainNamed !== undefined) {
        problems.push(
          problem(
            where,
            "SKILL_LABEL_IS_DOMAIN_NAME",
            `label_en ${JSON.stringify(s.label_en)} is the name of domain ${domainNamed}. That is a JOB ` +
              `TITLE restated as a skill — it adds nothing to the picker for that trade (every ` +
              `candidate has it by definition) and it is noise on every other trade.`,
          ),
        );
      }

      // EVERY token generic, not merely a lone generic token. The old rule only fired on a
      // one-word label, so `"machine work"` and `"machine/tools"` — labels made entirely of
      // filler, which is the same defect wearing two words — went straight through. Worse,
      // they went through with an EMPTY informative-token set, which makes them invisible to
      // `equivalenceEvidence`, `aliasCoherence` and the seniority detector too: unmatchable,
      // unmergeable, unflaggable. `taxonomy-convergence.ts` already documents this check as
      // the thing that catches `"machine work"`; now it does.
      const tokens = taxonomyTokens(labelNorm);
      if (tokens.length > 0 && tokens.every((t) => stoplist.has(t))) {
        problems.push(
          problem(
            where,
            "SKILL_LABEL_OVER_GENERIC",
            `${JSON.stringify(s.label_en)} is made entirely of over-generic words. It tells an employer nothing ` +
              `and it acts as an attractor during canonicalization, swallowing phrases that should ` +
              `have resolved to a real skill. Delete it or qualify it ("machine" -> "machine ` +
              `maintenance"). A HUMAN decides; the validator only refuses to let it through unseen.`,
          ),
        );
      }
    }

    // ── aliases ─────────────────────────────────────────────────────────────
    if (!Array.isArray(s.aliases)) {
      problems.push(problem(where, "ALIAS_LIST_INVALID", `aliases must be an array.`));
      continue;
    }
    if (s.aliases.length === 0) {
      problems.push(
        problem(
          where,
          "ALIAS_LIST_EMPTY",
          `zero aliases. ADR-0030 embeds the ALIASES, not the canonical label, so a skill with none ` +
            `can never be canonicalized to — it seeds fine and is unreachable forever. List at ` +
            `least the label itself.`,
        ),
      );
    }
    /** `${lang}|${norm}` already used by THIS skill. */
    const ownNorms = new Map<string, string>();
    for (const a of s.aliases) {
      const text = typeof a?.text === "string" ? a.text : "";
      const shown = JSON.stringify(text);
      if (text.trim().length === 0) {
        problems.push(problem(where, "ALIAS_TEXT_EMPTY", `an alias has empty text.`));
        continue;
      }
      if (text !== text.trim()) {
        problems.push(
          problem(where, "ALIAS_TEXT_WHITESPACE", `alias ${shown} has leading or trailing whitespace.`),
        );
      }
      if (text.length > MAX_ALIAS_LEN) {
        problems.push(
          problem(
            where,
            "ALIAS_TOO_LONG",
            `alias ${shown} is ${text.length} chars, over the ${MAX_ALIAS_LEN} cap.`,
          ),
        );
      }
      if (hasForbiddenAliasChars(text)) {
        problems.push(
          problem(
            where,
            "TEXT_FORBIDDEN_CHARS",
            `alias ${shown} contains a digit, '@' or a URL. See the label note — same guard, same ` +
              `reason.`,
          ),
        );
      }
      if (!LANGS.includes(a.lang)) {
        problems.push(
          problem(
            where,
            "ALIAS_LANG_ENUM",
            `alias ${shown} has lang ${JSON.stringify(a?.lang)}; expected one of ${LANGS.join("|")}.`,
          ),
        );
        continue;
      }
      const norm = normalizeOccupationText(text);
      if (norm.length === 0) {
        problems.push(
          problem(
            where,
            "ALIAS_NORMALIZES_EMPTY",
            `alias ${shown} normalizes to the empty string, so no lexical layer could ever match it ` +
              `(it would still cost an embedding).`,
          ),
        );
        continue;
      }
      const key = `${a.lang}|${norm}`;

      const mine = ownNorms.get(key);
      if (mine !== undefined) {
        problems.push(
          problem(
            where,
            "ALIAS_DUPLICATE_WITHIN_SKILL",
            `alias ${shown} normalizes to ${JSON.stringify(norm)}, the same as ${JSON.stringify(mine)} on ` +
              `this skill. Only one of them can win \`is_searchable\` on ` +
              `(skill_id, text_norm, lang), so the other is an unreachable row that still costs an ` +
              `embedding.`,
          ),
        );
        continue;
      }
      ownNorms.set(key, text);

      const otherSkill = aliasNormOwner.get(key);
      if (otherSkill !== undefined && otherSkill !== rawId) {
        problems.push(
          problem(
            where,
            "ALIAS_AMBIGUOUS",
            `alias ${shown} normalizes to ${JSON.stringify(norm)}, which ${otherSkill} already claims. ` +
              `Canonicalization would then be a coin flip between two skills for the same worker ` +
              `phrase. Pick one owner, or disambiguate both texts.`,
          ),
        );
        continue;
      }
      aliasNormOwner.set(key, rawId);
    }
  }

  // ── Edges ─────────────────────────────────────────────────────────────────
  const seenEdges = new Set<string>();
  const edgesPerSkill = new Map<string, number>();
  const edgesPerDomain = new Map<string, number>();

  for (const e of edges) {
    const domainId = typeof e.job_domain_id === "string" ? e.job_domain_id : "<no domain>";
    const skillId = typeof e.skill_id === "string" ? e.skill_id : "<no skill>";
    const where = edgeLocator(domainId, skillId);

    if (!domainById.has(domainId)) {
      problems.push(
        problem(
          where,
          "EDGE_UNKNOWN_DOMAIN",
          `job_domain_id is not in sample-domains.jsonl. A renamed, mistyped or out-of-batch id ` +
            `lands here; the FK to \`job_domain\` would otherwise fail mid-seed.`,
        ),
      );
      continue;
    }
    if (skillId.startsWith(MATCH_SKILL_PREFIX)) {
      problems.push(
        problem(
          where,
          "EDGE_MATCHABLE_SKILL",
          `'${MATCH_SKILL_PREFIX}*' is the closed matchable vocabulary; \`job_domain_skill\` is the ` +
            `descriptive taxonomy and must not reference it (invariant #4).`,
        ),
      );
      continue;
    }
    if (!corpusSkillIds.has(skillId) && !shipped.has(skillId)) {
      problems.push(
        problem(
          where,
          "EDGE_UNKNOWN_SKILL",
          `skill_id is in neither skills.jsonl nor SKILL_CORPUS. An edge to a skill that does not ` +
            `exist is the one fault the database WOULD catch — as an FK violation, halfway through ` +
            `a seed, naming nothing useful.`,
        ),
      );
      continue;
    }

    const pair = `${domainId}|${skillId}`;
    if (seenEdges.has(pair)) {
      problems.push(
        problem(
          where,
          "EDGE_DUPLICATE",
          `this (job_domain_id, skill_id) pair appears twice. It is the table's primary key, so the ` +
            `second row would silently overwrite the first with whatever requirement and relevance ` +
            `it happened to carry.`,
        ),
      );
      continue;
    }
    seenEdges.add(pair);
    edgesPerSkill.set(skillId, (edgesPerSkill.get(skillId) ?? 0) + 1);
    edgesPerDomain.set(domainId, (edgesPerDomain.get(domainId) ?? 0) + 1);

    if (!REQUIREMENTS.includes(e.default_requirement)) {
      problems.push(
        problem(
          where,
          "EDGE_REQUIREMENT_ENUM",
          `default_requirement is ${JSON.stringify(e.default_requirement)}; expected ` +
            `${REQUIREMENTS.join("|")} (job_domain_skill_requirement_chk).`,
        ),
      );
    }
    if (!EDGE_SOURCES.includes(e.source)) {
      problems.push(
        problem(
          where,
          "EDGE_SOURCE_ENUM",
          `source is ${JSON.stringify(e.source)}; expected ${EDGE_SOURCES.join("|")} ` +
            `(job_domain_skill_source_chk).`,
        ),
      );
    }
    if (!Number.isInteger(e.relevance) || e.relevance < 0 || e.relevance > 100) {
      problems.push(
        problem(
          where,
          "EDGE_RELEVANCE_RANGE",
          `relevance must be an integer 0..100, got ${JSON.stringify(e.relevance)} ` +
            `(job_domain_skill_relevance_chk; the column is a smallint).`,
        ),
      );
    }
    if (e.confidence !== null && e.confidence !== undefined) {
      if (!Number.isFinite(e.confidence) || e.confidence < 0 || e.confidence > 1) {
        problems.push(
          problem(
            where,
            "EDGE_CONFIDENCE_RANGE",
            `confidence must be null or a number 0..1, got ${JSON.stringify(e.confidence)} ` +
              `(job_domain_skill_confidence_chk).`,
          ),
        );
      }
    }
  }

  // ── Coverage holes ────────────────────────────────────────────────────────
  // Both of these are SILENT once seeded, which is the entire reason they are checked
  // here and not left to a dashboard nobody opens.
  for (const skillId of corpusSkillIds) {
    if ((edgesPerSkill.get(skillId) ?? 0) === 0) {
      problems.push(
        problem(
          skillLocator(skillId),
          "SKILL_ORPHAN",
          `zero domain_skill edges. Nothing reaches this skill: it is not on any trade's picker and ` +
            `no posting can be built from it. It seeds, it embeds, and it is invisible.`,
        ),
      );
    }
  }
  for (const domainId of domainById.keys()) {
    if ((edgesPerDomain.get(domainId) ?? 0) === 0) {
      problems.push(
        problem(
          `domain[${domainId}]`,
          "DOMAIN_ORPHAN",
          `zero domain_skill edges. The employer's skill picker renders EMPTY for this trade — the ` +
            `most visible failure this taxonomy has, and the one no error log would ever mention.`,
        ),
      );
    }
  }

  return problems;
}

/**
 * Load + validate the committed corpus. Throws with EVERY problem listed.
 *
 * This is what the seeder calls, and it is deliberately the only convenient path to the
 * data: a caller that wants the records without the gate has to assemble
 * `loadTaxonomyCorpus` + `validateTaxonomyCorpus` by hand, which is a visible choice in a
 * diff rather than an omission.
 */
export function resolveTaxonomyCorpus(dir: string = TAXONOMY_DATA_DIR): TaxonomyCorpus {
  const corpus = loadTaxonomyCorpus(dir);
  const problems = validateTaxonomyCorpus(corpus.skills, corpus.edges, { domains: corpus.domains });
  if (problems.length > 0) {
    throw new Error(`taxonomy corpus invalid:\n  - ${problems.join("\n  - ")}`);
  }
  return corpus;
}

/** Counts for the seed's dry-run summary and the verifier. Ids + integers only. */
export function summariseTaxonomyCorpus(corpus: TaxonomyCorpus): Record<string, number> {
  const required = corpus.edges.filter((e) => e.default_requirement === "required").length;
  const bySource: Record<string, number> = {};
  for (const e of corpus.edges) {
    bySource[`edges_${e.source}`] = (bySource[`edges_${e.source}`] ?? 0) + 1;
  }
  return {
    domains: corpus.domains.length,
    skills: corpus.skills.length,
    skills_reusing_shipped: corpus.skills.filter((s) => s.reuses_existing === true).length,
    aliases: corpus.skills.reduce((n, s) => n + (Array.isArray(s.aliases) ? s.aliases.length : 0), 0),
    edges: corpus.edges.length,
    edges_required: required,
    edges_preferred: corpus.edges.length - required,
    ...bySource,
  };
}

// ===========================================================================
// `pnpm db:verify:taxonomy` — the validator as a standalone check
// ===========================================================================

/**
 * The gate, runnable on its own. Exits 1 on any problem so it can guard a commit or a
 * deploy step, and prints a per-code tally first so a 300-problem run is readable.
 *
 * NO DATABASE. That is the distinction this file draws in the same place
 * `verify-job-domains.ts` draws it: this proves the FILES are coherent; a live-database
 * verifier proves the database got what they described. Mixing the two would make the
 * cheap check depend on a DATABASE_URL and it would stop being run.
 */
function main(): void {
  const script = "verify:taxonomy";
  const corpus = loadTaxonomyCorpus();
  const problems = validateTaxonomyCorpus(corpus.skills, corpus.edges, { domains: corpus.domains });

  const counts = summariseTaxonomyCorpus(corpus);
  console.log(`[${script}] corpus at ${TAXONOMY_DATA_DIR}`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(28)} = ${v}`);

  if (problems.length === 0) {
    // An EMPTY corpus is reported as such rather than as a pass. "0 problems" over 0
    // records is the exact shape of a silently-missing data directory, and it is the
    // failure a green check is least likely to make anyone look for.
    if (corpus.domains.length === 0 && corpus.skills.length === 0 && corpus.edges.length === 0) {
      console.log(
        `[${script}] corpus is EMPTY — no *.jsonl files found, or every line was a comment. ` +
          `Nothing was validated.`,
      );
      return;
    }
    console.log(`[${script}] PASS — corpus is seedable.`);
    return;
  }

  const byCode = new Map<string, number>();
  for (const p of problems) {
    const code = taxonomyProblemCode(p);
    byCode.set(code, (byCode.get(code) ?? 0) + 1);
  }
  console.log(`[${script}] ${problems.length} problem(s):`);
  for (const [code, n] of [...byCode.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${code.padEnd(28)} = ${n}`);
  }
  for (const p of problems) console.log(`  FAIL ${p}`);
  process.exit(1);
}

// Guarded so importing the loader/validator (the seeder, the generator, the tests) does
// not run the CLI. Same guard shape as `generate-domain-aliases.ts`.
if (process.argv[1] && /taxonomy-corpus\.ts$/.test(process.argv[1])) {
  main();
}
