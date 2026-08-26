/**
 * THE DETERMINISTIC PRE-AI CLASSIFIER — one verdict per source phrase, no model, ₹0.
 *
 * ===========================================================================
 * WHY THIS RUNS BEFORE ANY MODEL, AND NOT AFTER
 * ===========================================================================
 * The naive shape of skill discovery is "hand 9,121 alias texts to a capable model and ask
 * which are skills". That is a real cost (measured in `skill-discovery-cost.ts`), and worse,
 * it is a cost paid to re-derive things the repository already KNOWS:
 *
 *   * "Magician" is an occupation with no extractable skill — decidable from the head noun.
 *   * "…spreads skin or hide with hair" is scrape residue — `isProse` already decides it.
 *   * "arc welding" is already a `skill_alias` — decidable by an equality probe on `text_norm`.
 *
 * Every phrase this module disposes of is a phrase no model is asked about. It is the same
 * argument `mine-chat-aliases.ts` makes for filtering at the MESSAGE level rather than the
 * phrase level: the deterministic layer's job is to make the review file short enough that a
 * human actually reads it, and the AI budget small enough that the run is affordable.
 *
 * ===========================================================================
 * WHAT IT DECIDES, AND WHAT IT REFUSES TO DECIDE
 * ===========================================================================
 * It decides the SHAPE of a phrase — occupation, activity, prose, residue — from tokens,
 * heads and stoplists. It never decides that something IS a skill: the strongest verdict it
 * can reach is {@link PhraseClass} `OCCUPATION_WITH_SKILL_EVIDENCE`, which means "there is
 * something here worth extracting", not "this is a skill". Extraction is the model's job and
 * approval is a human's; see `skill-discovery-candidate.ts` for the status ladder that keeps
 * those three roles apart.
 *
 * {@link PhraseClass} `AMBIGUOUS` IS A REAL ANSWER, not a gap — the same discipline
 * `junk-label-classifier.ts` records. A phrase with no occupation head and no activity
 * marker ("bare foot technician bft", "riksha") is genuinely undecidable from shape, and
 * manufacturing a verdict for it would put an unreviewed guess into a corpus that is
 * immutable once seeded.
 *
 * ===========================================================================
 * ONE NORMALIZER, ONE TOKENIZER, ONE STOPLIST
 * ===========================================================================
 * `normalizeOccupationText`, `taxonomyTokens` and `GENERIC_SKILL_STOPLIST` are imported, never
 * restated. The last time this package grew a second tokenizer, a label was simultaneously
 * too specific to reject and too empty to compare, and was invisible to every detector
 * downstream (see the `TOKEN_SPLIT` docblock in `taxonomy-corpus.ts`). The rule is not
 * "reuse where convenient"; it is that a second definition of the same question is a bug.
 *
 * PURE. Inputs are values. No database, no clock, no I/O.
 *
 * PRIVACY: the caller is responsible for what it hands in. Worker-language sources MUST be
 * pseudonymized upstream (`mine-chat-aliases.ts` is the reference); this module additionally
 * refuses any phrase carrying digits, `@` or a URL via `hasForbiddenAliasChars`, so a contact
 * detail that survived pseudonymization still cannot become a candidate.
 */
import { normalizeOccupationText } from "@badabhai/profiling-lexicon";

import { hasForbiddenAliasChars } from "./job-domain-corpus";
import { GENERIC_SKILL_STOPLIST, taxonomyTokens } from "./taxonomy-corpus";
import { isProse } from "./junk-label-classifier";
import { occupationHeadTokens, type HeadLexicon } from "./skill-discovery-heads";

// ===========================================================================
// Vocabulary
// ===========================================================================

/**
 * The shape verdict. Ordered from "cannot be anything" to "worth extracting from".
 *
 * NO `SKILL` MEMBER, deliberately. Nothing this module can observe justifies asserting that
 * a phrase IS a canonical skill — that assertion needs an extracted label, a dedup pass
 * against the shipped catalogue, and a human. The absence of the member is the enforcement.
 */
export type PhraseClass =
  /** Not vocabulary at all: prose residue, forbidden characters, nothing left after normalization. */
  | "REJECTED_NON_SKILL"
  /** A job title and nothing more. `"Magician"`, `"Operator"`. Contributes no skill. */
  | "OCCUPATION_ONLY"
  /** A job title with a modifier that names work. `"Operator, Strip Mill"`. The extraction queue. */
  | "OCCUPATION_WITH_SKILL_EVIDENCE"
  /** Headed by an activity, not a person. `"welding"`, `"conduit bending"`. Skill-shaped. */
  | "ACTIVITY_PHRASE"
  /** Shape gives no honest signal. Human review, never a guess. */
  | "AMBIGUOUS";

/**
 * The rule that produced a verdict, as a stable machine-readable code.
 *
 * STABLE FOR THE SAME REASON `TaxonomyProblemCode` IS: the coverage report counts by code, so
 * a run six months from now stays comparable with today's even after every sentence in this
 * file has been reworded. Adding a code is additive; renaming one breaks the comparison.
 */
export type ClassifierRule =
  | "FORBIDDEN_CHARS"
  | "NORMALIZES_EMPTY"
  | "PROSE_FRAGMENT"
  | "TOO_LONG"
  | "ALL_TOKENS_GENERIC"
  | "HEAD_ONLY_NO_MODIFIER"
  | "HEAD_PLUS_EVIDENCE"
  | "ACTIVITY_HEADED"
  | "NO_HEAD_NO_ACTIVITY";

export const CLASSIFIER_RULES: readonly ClassifierRule[] = [
  "FORBIDDEN_CHARS",
  "NORMALIZES_EMPTY",
  "PROSE_FRAGMENT",
  "TOO_LONG",
  "ALL_TOKENS_GENERIC",
  "HEAD_ONLY_NO_MODIFIER",
  "HEAD_PLUS_EVIDENCE",
  "ACTIVITY_HEADED",
  "NO_HEAD_NO_ACTIVITY",
];

/**
 * Token ceiling above which a phrase is scrape prose rather than vocabulary.
 *
 * Measured, not chosen: the live `job_domain_alias` token histogram (2026-08-26) falls off a
 * cliff after 8 tokens — 9,057 of 9,121 rows sit at 8 or fewer, and the tail runs to a
 * 36-token sentence beginning "Stockist stocks goods of one or more producers…". `isProse`
 * already catches most of that by its leading-lowercase and 80-character rules; this catches
 * the capitalised ones it cannot.
 */
export const MAX_PHRASE_TOKENS = 8;

/**
 * Minimum stem for a token to count as a gerund.
 *
 * Same guard, same reason, as {@link MIN_AGENT_NOUN_STEM}: without it `ring`, `king` and
 * `wing` are activities.
 */
export const MIN_GERUND_STEM = 3;

/** True when the token is an `-ing` nominalization with a real stem. */
export function isGerund(token: string): boolean {
  return token.endsWith("ing") && token.length - 3 >= MIN_GERUND_STEM;
}

/**
 * Below this token count, the shared `isProse` rule is NOT applied.
 *
 * ── THE DEFECT THIS FIXES, AND WHY IT MATTERS MORE THAN IT LOOKS ──
 *
 * `isProse` calls a phrase prose when it STARTS LOWERCASE, and that is correct for the corpus
 * it was written against: `junk-label-classifier.ts` is looking at `job_domain.label_en` rows
 * where a leading lowercase letter means the NCO scrape captured a wrapped continuation line
 * ("...spreads skin or hide with hair").
 *
 * Applied to every phrase here it does something quite different, and quite bad. The
 * vernacular aliases in `job_domain_alias` are stored exactly as a worker would type them —
 * lowercase. Measured on the live table: `"riksha"`, `"plumbing"`, `"kharad operator"`,
 * `"silai wala"`. Under the unguarded rule every one of those is "scrape residue" and is
 * dropped before the classifier ever looks at it. That is the precise population this
 * platform exists to serve, discarded by a capitalization test.
 *
 * TWO TOKENS IS THE LINE because a wrapped SENTENCE fragment is by nature long — the shortest
 * in the live corpus runs to seven tokens — while vernacular trade names are one or two
 * ("riksha", "silai wala"). `isProse`'s other rules are unaffected and still fire at any
 * length: a trailing comma or colon, or more than 80 characters, is prose whatever its case.
 *
 * NOT A CHANGE TO `isProse` ITSELF. That function is the shared rule the junk-label audit
 * counts with, and its docblock says the rule was deliberately kept identical to the original
 * survey's so the figures stay comparable. Changing it would silently move a number on record.
 */
export const MIN_TOKENS_FOR_PROSE_TEST = 3;

const GENERIC: ReadonlySet<string> = new Set(GENERIC_SKILL_STOPLIST);

/**
 * ENGLISH FUNCTION WORDS AND NCO SCRAPE CONNECTIVES.
 *
 * ── WHY THIS IS NOT AN ADDITION TO `GENERIC_SKILL_STOPLIST` ──
 *
 * That list answers a different question, and folding these into it would break three other
 * detectors. `GENERIC_SKILL_STOPLIST` means "a real trade word that carries no trade
 * INFORMATION" — `machine`, `quality`, `operation` — and `validateTaxonomyCorpus` uses it to
 * reject an all-generic LABEL while `taxonomy-lexical.ts` uses it to decide which tokens count
 * as evidence of two skills being the same concept. `and` and `of` are not weak trade words;
 * they are not trade words at all, and a skill labelled `"and"` is not a corpus defect the
 * reuse analyzer should be reasoning about.
 *
 * ── WHY IT EXISTS AT ALL: A MEASURED DEFECT ──
 *
 * Without it, the first full dry run (2026-08-26, 13,053 source rows) reported its top
 * evidence signatures as `and` (27 domains), `other` (22), `and other` (16) and
 * `and other related` (12). Those come from ISCO's own residual-bucket titles — "Managers,
 * Other", "Metal Workers and Related Trades" — and every one of them was being read as an
 * occupation title WITH skill evidence, when the honest reading is a title with no modifier
 * naming work at all. 77.7% of distinct phrases landed in `new_skill_candidate` on the back
 * of it.
 *
 * The list is deliberately CLOSED-CLASS ONLY — determiners, prepositions, conjunctions,
 * copulas — plus the four connectives the NCO/ISCO scrape uses to mark a residual bucket
 * (`other`, `related`, `nec`, `classified`, `elsewhere`, `including`). No content word is in
 * here; a content word that carries little information belongs in the stoplist above, where
 * the other detectors can see it.
 */
export const PHRASE_FUNCTION_WORDS: readonly string[] = [
  // determiners and pronouns
  "a", "an", "the", "this", "that", "these", "those", "its", "their", "his", "her", "your",
  "all", "any", "each", "every", "some", "such", "no", "none",
  // prepositions
  "of", "in", "on", "at", "to", "for", "with", "by", "from", "into", "onto", "upon",
  "under", "over", "above", "below", "between", "among", "through", "during", "per",
  // conjunctions and copulas
  "and", "or", "but", "nor", "as", "than", "then", "if", "when", "where", "while",
  "is", "are", "was", "were", "be", "been", "being", "am",
  // degree / residue
  "not", "also", "only", "more", "most", "less", "least", "very", "own",
  // NCO / ISCO residual-bucket connectives
  "other", "others", "related", "nec", "classified", "elsewhere", "including", "include",
  "etc", "misc", "miscellaneous",
];

const FUNCTION_WORDS: ReadonlySet<string> = new Set(PHRASE_FUNCTION_WORDS);

/**
 * Is this token capable of being EVIDENCE of work?
 *
 * A token must be none of: an occupation head (that is identity, not work), a generic trade
 * word, or a function word. The three exclusions are three different arguments and are kept
 * as three lists for exactly that reason.
 */
export function isEvidenceToken(token: string, isHead: (t: string) => boolean): boolean {
  return !GENERIC.has(token) && !FUNCTION_WORDS.has(token) && !isHead(token);
}

// ===========================================================================
// The verdict
// ===========================================================================

export interface PhraseVerdict {
  readonly phraseClass: PhraseClass;
  readonly rule: ClassifierRule;
  /** `normalizeOccupationText(original)` — the SAME key `skill_alias.text_norm` stores. */
  readonly normalized: string;
  readonly tokens: readonly string[];
  /** Tokens that are occupation identity. Never evidence. */
  readonly occupationHeads: readonly string[];
  /**
   * Tokens that carry trade meaning after heads and stoplist are removed.
   *
   * THIS IS THE INPUT TO EXTRACTION, and the reason an occupation title can still yield a
   * skill: `"Operator, Strip Mill"` contributes `{mill, strip}`, from which a model may
   * propose "strip mill operation" — a skill an employer can actually hire on.
   */
  readonly evidenceTokens: readonly string[];
  /** Why, in words, for the reviewer. Never parsed. */
  readonly rationale: string;
}

/**
 * Classify one source phrase.
 *
 * ORDER ENCODES PRECEDENCE, not convenience, and each step is placed where it is because the
 * step below it would give a WORSE answer for the same input:
 *
 *   1. forbidden characters   — a privacy rule outranks every taxonomy question.
 *   2. normalizes empty       — nothing to reason about.
 *   3. prose / too long       — a sentence is not vocabulary, whatever tokens it contains.
 *   4. all-generic            — `"machine work"` has heads and evidence by the letter of the
 *                               later rules and means nothing; catching it here stops it
 *                               becoming an `OCCUPATION_WITH_SKILL_EVIDENCE` candidate.
 *   5. occupation head        — the load-bearing one. See `skill-discovery-heads.ts`.
 *   6. activity               — only reachable once we know there is no person-noun, which is
 *                               what stops `"welding inspector"` reading as an activity.
 */
export function classifyPhrase(original: string, lexicon: HeadLexicon): PhraseVerdict {
  const normalized = normalizeOccupationText(original);
  const tokens = taxonomyTokens(normalized);

  const base = { normalized, tokens } as const;

  if (hasForbiddenAliasChars(original)) {
    return {
      ...base,
      phraseClass: "REJECTED_NON_SKILL",
      rule: "FORBIDDEN_CHARS",
      occupationHeads: [],
      evidenceTokens: [],
      rationale:
        "carries a digit, '@' or a URL — refused before anything else, because a contact " +
        "detail that reached a committed corpus is a privacy incident, not a taxonomy defect",
    };
  }

  if (tokens.length === 0) {
    return {
      ...base,
      phraseClass: "REJECTED_NON_SKILL",
      rule: "NORMALIZES_EMPTY",
      occupationHeads: [],
      evidenceTokens: [],
      rationale: "nothing survives normalization — there is no phrase here to classify",
    };
  }

  if (tokens.length >= MIN_TOKENS_FOR_PROSE_TEST && isProse(original)) {
    return {
      ...base,
      phraseClass: "REJECTED_NON_SKILL",
      rule: "PROSE_FRAGMENT",
      occupationHeads: [],
      evidenceTokens: [],
      rationale:
        "a wrapped sentence fragment by the shared `isProse` rule — NCO scrape residue, " +
        "not something a worker would say as their trade",
    };
  }

  if (tokens.length > MAX_PHRASE_TOKENS) {
    return {
      ...base,
      phraseClass: "REJECTED_NON_SKILL",
      rule: "TOO_LONG",
      occupationHeads: [],
      evidenceTokens: [],
      rationale: `${tokens.length} tokens, above the ${MAX_PHRASE_TOKENS}-token vocabulary ceiling`,
    };
  }

  const occupationHeads = occupationHeadTokens(tokens, lexicon);
  const headSet = new Set(occupationHeads);
  const isHead = (t: string): boolean => headSet.has(t) || headSet.has(t.replace(/s$/, ""));
  const evidenceTokens = [...new Set(tokens.filter((t) => isEvidenceToken(t, isHead)))];

  const informative = tokens.filter((t) => !GENERIC.has(t) && !FUNCTION_WORDS.has(t));
  if (informative.length === 0) {
    return {
      ...base,
      phraseClass: "REJECTED_NON_SKILL",
      rule: "ALL_TOKENS_GENERIC",
      occupationHeads,
      evidenceTokens: [],
      rationale:
        "every token is a generic trade word or a function word — the label means nothing to " +
        "an employer and would act as an attractor during canonicalization",
    };
  }

  if (occupationHeads.length > 0) {
    if (evidenceTokens.length === 0) {
      return {
        ...base,
        phraseClass: "OCCUPATION_ONLY",
        rule: "HEAD_ONLY_NO_MODIFIER",
        occupationHeads,
        evidenceTokens,
        rationale:
          `an occupation title (${occupationHeads.join(", ")}) with no modifier naming work. ` +
          "Restating it as a skill adds nothing: every candidate for that trade has it by definition",
      };
    }
    return {
      ...base,
      phraseClass: "OCCUPATION_WITH_SKILL_EVIDENCE",
      rule: "HEAD_PLUS_EVIDENCE",
      occupationHeads,
      evidenceTokens,
      rationale:
        `an occupation title (${occupationHeads.join(", ")}) whose modifier ` +
        `(${evidenceTokens.join(", ")}) names the work. The TITLE is not a skill; what the ` +
        "modifier describes may be one",
    };
  }

  if (tokens.some(isGerund)) {
    return {
      ...base,
      phraseClass: "ACTIVITY_PHRASE",
      rule: "ACTIVITY_HEADED",
      occupationHeads,
      evidenceTokens,
      rationale:
        "names an activity rather than a person — the shape a canonical skill actually takes",
    };
  }

  return {
    ...base,
    phraseClass: "AMBIGUOUS",
    rule: "NO_HEAD_NO_ACTIVITY",
    occupationHeads,
    evidenceTokens,
    rationale:
      "no occupation head and no activity marker. Shape gives no honest signal either way; " +
      "this is a reviewer's call, not a classifier's",
  };
}

/**
 * Does this verdict justify spending a model call?
 *
 * The single question the cost model and the batch builder both ask, defined ONCE so they
 * cannot disagree about the size of the bill. `AMBIGUOUS` is included: it is exactly the
 * population where a human needs a proposal to react to, and it is the population a purely
 * deterministic pipeline would otherwise silently drop.
 */
export function warrantsExtraction(verdict: PhraseVerdict): boolean {
  return (
    verdict.phraseClass === "OCCUPATION_WITH_SKILL_EVIDENCE" ||
    verdict.phraseClass === "ACTIVITY_PHRASE" ||
    verdict.phraseClass === "AMBIGUOUS"
  );
}
