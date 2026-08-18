/**
 * The retrieval-evaluation FIXTURE — a versioned, reviewed ground-truth dataset.
 *
 * ---------------------------------------------------------------------------
 * WHY GROUND TRUTH IS VALIDATED, NOT ASSERTED
 * ---------------------------------------------------------------------------
 * A retrieval fixture is the one artifact in an evaluation that nothing else checks. If a
 * case names `skill_forklit_operation`, retrieval "fails" forever and the number looks like
 * a model problem. If a case expects a skill that is not wired to the domain it queries,
 * the case is unpassable BY CONSTRUCTION and quietly drags every average down.
 *
 * So every field is checked against the committed corpus before a single query runs:
 *
 *   - `expected_skill_id` exists in the corpus (or is an explicitly declared SHIPPED id)
 *   - `job_domain_id` exists AND actually has edges
 *   - the (domain, skill) EDGE exists — the case is reachable through `job_domain_skill`
 *   - every `acceptable_skill_ids` entry is ALSO wired to that same domain
 *   - every `must_not_return_skill_ids` entry is a real id (a typo'd negative always passes,
 *     which is the worst kind of green)
 *   - `provenance` is present and, for corpus-derived cases, resolves
 *
 * `validateEvalFixture` is therefore a gate, not a lint. The harness refuses to evaluate a
 * fixture with problems, on the same reasoning as the taxonomy quality gate: a measurement
 * taken with a broken instrument is worse than no measurement, because it gets quoted.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE CATEGORIES ARE FOR
 * ---------------------------------------------------------------------------
 * Metrics are reported per category AND per domain, never as a lone headline. A fixture
 * with 40 easy exact-alias hits and 6 hard paraphrases produces a flattering average that
 * says nothing about either. The category is how a reader sees which half moved.
 */
import { existsSync, readFileSync } from "node:fs";

import type { TaxonomyCorpus } from "./taxonomy-corpus";

/** Case classes. Closed set — a new one is a deliberate change to what is measured. */
export const EVAL_CATEGORIES = [
  /** The query IS an alias of the expected skill. The floor: if these miss, nothing works. */
  "exact_alias",
  /** Latin-script paraphrase that is NOT an alias — the actual retrieval question. */
  "paraphrase_latin",
  /** Devanagari alias, exact. Proves the multilingual model indexes Hindi at all. */
  "devanagari_alias",
  /** Devanagari/Hinglish phrasing that is NOT an alias. */
  "devanagari_paraphrase",
  /** Same skill queried through a DIFFERENT domain it is legitimately wired to. */
  "multi_domain_reach",
  /** Two phrasings that must land on ONE canonical skill. */
  "canonical_convergence",
  /** NEGATIVE: an out-of-trade phrase must not pull an unrelated skill into scope. */
  "cross_domain_isolation",
  /** A skill whose `skill.domain_id` is NULL, reachable only via `job_domain_skill`. */
  "null_legacy_domain",
  /** Expected skill is SHIPPED and currently unembedded — a coverage probe, not a ranking one. */
  "unembedded_shipped",
  /** Lexically close phrases that must resolve to different skills. */
  "lexical_ambiguity",
] as const;
export type EvalCategory = (typeof EVAL_CATEGORIES)[number];

/** One evaluation query. */
export interface EvalCase {
  /** Stable id — referenced by reports and by regression tests. */
  case_id: string;
  query: string;
  lang: "en" | "hi";
  category: EvalCategory;
  /** The retrieval SCOPE. Canonical path: candidates come from `job_domain_skill`. */
  job_domain_id: string;
  /** null = NEGATIVE case: nothing relevant should come back. */
  expected_skill_id: string | null;
  /** Reviewed alternatives that are also correct. Each needs a `notes` justification. */
  acceptable_skill_ids?: string[];
  /** Skills that must NOT appear in the top-k for this query. */
  must_not_return_skill_ids?: string[];
  /** Where the ground truth came from. `corpus_alias:<skill_id>/<lang>` for derived cases,
   *  `reviewed_fixture` for hand-authored ones. Never absent. */
  provenance: string;
  /**
   * How much this case's ground truth can be trusted. Absent means "derive it from
   * provenance" — see {@link reviewStatusOf} — so existing fixtures need no rewrite.
   */
  review_status?: ReviewStatus;
  notes?: string;
}

/**
 * The three grades of ground truth, kept apart because they are earned differently.
 *
 * `mechanical` — the query IS an alias of the expected skill, so correctness is tautological.
 *   Cheap and unlimited, and worth almost nothing as evidence: the run already warns that
 *   44.7% of queries are exact-alias hits, "a floor under R@1 that retrieval did not earn".
 *   Generating more of them raises the headline without improving the measurement.
 * `reviewed` — a human judged that this query should resolve to this skill. The only grade
 *   that makes a paraphrase result mean anything.
 * `pending_review` — authored, plausible, and NOT YET JUDGED. Scoring these would let the
 *   author of the cases decide the score, which is how DC-18 became a ground-truth dispute
 *   instead of a model finding. They are carried in the fixture so a reviewer has something
 *   concrete to work on, and excluded from every metric until promoted.
 */
export const REVIEW_STATUSES = ["reviewed", "mechanical", "pending_review"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/**
 * Read a case's review status, deriving it from `provenance` when the field is absent.
 *
 * The derivation is not a guess: `corpus_alias:*` provenance means the case was generated
 * from a corpus alias, which is exactly what `mechanical` denotes, and every other existing
 * value was hand-authored into a reviewed fixture. Defaulting instead to `pending_review`
 * would silently drop all 127 existing cases out of the metrics.
 */
export function reviewStatusOf(c: Pick<EvalCase, "provenance" | "review_status">): ReviewStatus {
  if (c.review_status !== undefined) return c.review_status;
  return c.provenance.startsWith("corpus_alias:") ? "mechanical" : "reviewed";
}

/** Cases whose ground truth is settled enough to produce a number. */
export function isScoreable(c: Pick<EvalCase, "provenance" | "review_status">): boolean {
  return reviewStatusOf(c) !== "pending_review";
}

/** The fixture manifest — what this dataset IS, so a report can name its instrument. */
export interface EvalFixtureManifest {
  fixture_id: string;
  version: number;
  /** The corpus this ground truth was authored against. */
  corpus_batch: string;
  description: string;
}

export interface EvalFixture {
  manifest: EvalFixtureManifest;
  cases: EvalCase[];
}

const CATEGORY_SET = new Set<string>(EVAL_CATEGORIES);
const REVIEW_STATUS_SET = new Set<string>(REVIEW_STATUSES);
/** Minimum rationale length for a case that widens its own target with alternatives. */
export const MIN_ALTERNATIVE_RATIONALE = 40;

/** Parse a fixture JSONL. Line 1 is the manifest; the rest are cases. `#` lines ignored. */
export function parseEvalFixture(raw: string): EvalFixture {
  const lines: { text: string; n: number }[] = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (t.length === 0 || t.startsWith("#")) return;
    lines.push({ text: t, n: i + 1 });
  });
  if (lines.length === 0) throw new Error("[eval:fixture] file is empty");
  const first = lines[0] as { text: string; n: number };
  let manifest: EvalFixtureManifest;
  try {
    manifest = JSON.parse(first.text) as EvalFixtureManifest;
  } catch {
    throw new Error(`[eval:fixture] line ${first.n}: manifest is not valid JSON`);
  }
  if (typeof manifest.fixture_id !== "string" || typeof manifest.version !== "number") {
    throw new Error(`[eval:fixture] line ${first.n}: manifest needs fixture_id + version`);
  }
  const cases: EvalCase[] = [];
  for (const { text, n } of lines.slice(1)) {
    let c: EvalCase;
    try {
      c = JSON.parse(text) as EvalCase;
    } catch {
      throw new Error(`[eval:fixture] line ${n}: not valid JSON`);
    }
    cases.push(c);
  }
  return { manifest, cases };
}

/** A fixture fault, with the case it belongs to. */
export interface FixtureProblem {
  case_id: string | null;
  code: string;
  message: string;
}

/**
 * Validate every case against the corpus. Returns problems; empty means seedable.
 *
 * `shippedSkillIds` are the ids that exist in the shipped catalogue but not in the
 * generated corpus files. They are legal targets (a domain can reuse one) but they are NOT
 * in `corpus.skills`, so without this set every reuse case would look like a typo.
 */
export function validateEvalFixture(
  fixture: EvalFixture,
  corpus: TaxonomyCorpus,
  shippedSkillIds: ReadonlySet<string> = new Set(),
): FixtureProblem[] {
  const problems: FixtureProblem[] = [];
  const p = (case_id: string | null, code: string, message: string): void => {
    problems.push({ case_id, code, message });
  };

  const corpusSkills = new Set(corpus.skills.map((s) => s.skill_id));
  const knownSkill = (id: string): boolean => corpusSkills.has(id) || shippedSkillIds.has(id);
  const domains = new Set(corpus.domains.map((d) => d.job_domain_id));
  const edges = new Set(corpus.edges.map((e) => `${e.job_domain_id} ${e.skill_id}`));
  const domainsWithEdges = new Set(corpus.edges.map((e) => e.job_domain_id));

  const seenIds = new Set<string>();
  // (query, lang, domain) must be unique. The same query twice in one scope is either a
  // copy-paste or two contradictory expectations, and it also silently double-weights
  // whatever it asserts in the average.
  const seenQueries = new Set<string>();

  for (const c of fixture.cases) {
    const id = typeof c.case_id === "string" ? c.case_id : "(missing case_id)";
    if (typeof c.case_id !== "string" || c.case_id.length === 0) {
      p(null, "CASE_ID_MISSING", "a case has no case_id");
    } else if (seenIds.has(c.case_id)) {
      p(id, "CASE_ID_DUPLICATE", `case_id ${c.case_id} is used twice`);
    } else {
      seenIds.add(c.case_id);
    }

    if (typeof c.query !== "string" || c.query.trim().length === 0) {
      p(id, "QUERY_EMPTY", "query is empty");
    }
    if (c.lang !== "en" && c.lang !== "hi") {
      p(id, "LANG_ENUM", `lang must be en|hi, got ${JSON.stringify(c.lang)}`);
    }
    if (!CATEGORY_SET.has(c.category)) {
      p(id, "CATEGORY_UNKNOWN", `category ${JSON.stringify(c.category)} is not a known category`);
    }
    if (typeof c.provenance !== "string" || c.provenance.trim().length === 0) {
      p(id, "PROVENANCE_MISSING", "provenance is required — ground truth must be traceable");
    }
    if (c.review_status !== undefined && !REVIEW_STATUS_SET.has(c.review_status)) {
      p(
        id,
        "REVIEW_STATUS_ENUM",
        `review_status must be one of ${REVIEW_STATUSES.join("|")}, got ${JSON.stringify(c.review_status)}`,
      );
    }
    if (c.review_status === "mechanical" && !c.provenance.startsWith("corpus_alias:")) {
      // "mechanical" asserts the query is literally an alias of the expected skill, which is
      // what makes its correctness tautological. Claiming it without corpus provenance would
      // let a hand-authored paraphrase into the metrics under a grade that skips review.
      p(
        id,
        "MECHANICAL_WITHOUT_CORPUS_PROVENANCE",
        "review_status=mechanical requires provenance corpus_alias:<skill_id>/<lang> — the grade " +
          "means the query IS an alias, and nothing else may claim it",
      );
    }

    const qkey = `${c.query} ${c.lang} ${c.job_domain_id}`;
    if (seenQueries.has(qkey)) {
      p(id, "QUERY_DUPLICATE", `query ${JSON.stringify(c.query)} is already asked in ${c.job_domain_id}`);
    }
    seenQueries.add(qkey);

    if (!domains.has(c.job_domain_id)) {
      p(id, "DOMAIN_UNKNOWN", `job_domain_id ${c.job_domain_id} is not in the corpus`);
    } else if (!domainsWithEdges.has(c.job_domain_id)) {
      // Scope with no candidates: retrieval can only ever return nothing, so the case
      // measures the fixture rather than the system.
      p(id, "DOMAIN_HAS_NO_EDGES", `job_domain_id ${c.job_domain_id} has no skills wired to it`);
    }

    if (c.expected_skill_id !== null) {
      if (typeof c.expected_skill_id !== "string" || !knownSkill(c.expected_skill_id)) {
        p(id, "EXPECTED_SKILL_UNKNOWN", `expected_skill_id ${String(c.expected_skill_id)} does not exist`);
      } else if (!edges.has(`${c.job_domain_id} ${c.expected_skill_id}`)) {
        p(
          id,
          "EXPECTED_SKILL_NOT_IN_SCOPE",
          `${c.expected_skill_id} is not wired to ${c.job_domain_id}; the canonical query ` +
            `scopes candidates through job_domain_skill, so this case is unpassable by construction`,
        );
      }
    } else if (c.category !== "cross_domain_isolation") {
      p(id, "NEGATIVE_CATEGORY", `expected_skill_id is null but category is ${c.category}`);
    }

    for (const alt of c.acceptable_skill_ids ?? []) {
      if (!knownSkill(alt)) {
        p(id, "ALTERNATIVE_UNKNOWN", `acceptable_skill_ids contains unknown ${alt}`);
        continue;
      }
      if (!edges.has(`${c.job_domain_id} ${alt}`)) {
        p(id, "ALTERNATIVE_NOT_IN_SCOPE", `acceptable alternative ${alt} is not wired to ${c.job_domain_id}`);
      }
      if (alt === c.expected_skill_id) {
        p(id, "ALTERNATIVE_REDUNDANT", `${alt} is both expected and an alternative`);
      }
    }
    // A non-empty `notes` is not a justification — one character satisfies it, and the same
    // boilerplate can be pasted across every case. Since a domain carries 6-11 wired skills,
    // four unexplained in-scope alternatives would make any non-empty top-5 a rank-1 hit.
    // So: EVERY alternative must be named in the notes, and the notes must say something.
    for (const alt of c.acceptable_skill_ids ?? []) {
      const notes = (c.notes ?? "").trim();
      if (notes.length < MIN_ALTERNATIVE_RATIONALE) {
        p(
          id,
          "ALTERNATIVE_UNJUSTIFIED",
          `acceptable_skill_ids needs a real rationale (>= ${MIN_ALTERNATIVE_RATIONALE} chars) ` +
            `explaining why ${alt} is ALSO correct, not merely a non-empty note`,
        );
        break;
      }
    }

    // ── the in-scope / out-of-scope rule for forbidden ids ────────────────
    //
    // Retrieval INNER JOINs job_domain_skill, so a forbidden skill that is NOT wired to the
    // queried domain CANNOT be returned — the assertion is satisfied by the WHERE clause and
    // measures nothing. Left unchecked, an entire negative category reports leak = 0.0% for
    // any model, embedded or not, and a reader concludes isolation was measured and passed.
    //
    // The rule therefore differs by case kind, and both directions are required:
    //   POSITIVE case  -> forbidden ids MUST be in scope. That is a real leak risk: two
    //                     skills competing inside one domain is the only place a ranking
    //                     mistake can actually surface.
    //   NEGATIVE case  -> forbidden ids MUST be OUT of scope. That is the point of a
    //                     cross-domain case, and it is a STRUCTURAL regression guard on the
    //                     scoping — reported as such, never as a measured leak rate.
    for (const neg of c.must_not_return_skill_ids ?? []) {
      if (!knownSkill(neg)) {
        // A typo'd negative can never be returned, so the assertion passes forever.
        p(id, "NEGATIVE_SKILL_UNKNOWN", `must_not_return_skill_ids contains unknown ${neg}`);
      } else {
        const wired = edges.has(`${c.job_domain_id} ${neg}`);
        if (c.expected_skill_id !== null && !wired) {
          p(
            id,
            "NEGATIVE_NOT_IN_SCOPE",
            `${neg} is not wired to ${c.job_domain_id}, so retrieval could never return it and ` +
              `this assertion is vacuous. A positive case's forbidden ids must be in-scope ` +
              `competitors, or the case measures nothing.`,
          );
        }
        if (c.expected_skill_id === null && wired) {
          p(
            id,
            "NEGATIVE_IN_SCOPE",
            `${neg} IS wired to ${c.job_domain_id}, so this is not a cross-domain case — ` +
              `it is an in-scope competitor and belongs on a positive case.`,
          );
        }
      }
      if (neg === c.expected_skill_id) {
        p(id, "NEGATIVE_CONTRADICTS_EXPECTED", `${neg} is both expected and forbidden`);
      }
      if ((c.acceptable_skill_ids ?? []).includes(neg)) {
        p(id, "NEGATIVE_CONTRADICTS_ALTERNATIVE", `${neg} is both an alternative and forbidden`);
      }
    }
  }
  return problems;
}

/** Count cases per category and per domain — printed beside every metric so a strong
 *  group cannot hide a weak one behind a single average. */
export function fixtureDistribution(fixture: EvalFixture): {
  byCategory: Record<string, number>;
  byDomain: Record<string, number>;
  byLang: Record<string, number>;
} {
  const tally = (pick: (c: EvalCase) => string): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const c of fixture.cases) out[pick(c)] = (out[pick(c)] ?? 0) + 1;
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
  };
  return {
    byCategory: tally((c) => c.category),
    byDomain: tally((c) => c.job_domain_id),
    byLang: tally((c) => c.lang),
  };
}

/** Read a fixture from disk. */
export function loadEvalFixture(path: string): EvalFixture {
  if (!existsSync(path)) throw new Error(`[eval:fixture] ${path} does not exist`);
  return parseEvalFixture(readFileSync(path, "utf8"));
}
