/**
 * OCCUPATION HEAD NOUNS — the lexicon that stops "electrician" becoming a skill.
 *
 * ===========================================================================
 * THE ONE MISTAKE THIS WHOLE PIPELINE EXISTS TO NOT MAKE
 * ===========================================================================
 * `job_domain_alias` holds 9,121 rows. Read casually they look like a free skill corpus:
 * "Welder, Gas", "CNC Operator", "Mason, Building Construction". They are not. Every one
 * of them is a name for a PERSON WHO HOLDS A JOB, seeded from ISCO-08 and NCO-2015
 * occupation titles. A pipeline that maps them 1:1 into `skill` would mint 9,121 rows that
 * say nothing an employer can hire on — "welder" as a skill on a welding job is true of
 * every candidate by definition, which is the precise argument
 * `SKILL_LABEL_IS_DOMAIN_NAME` already makes inside `validateTaxonomyCorpus`.
 *
 * The skill evidence in an occupation title, when there is any, lives in the MODIFIER:
 *
 *     "Operator, Strip Mill"   occupation head `operator`   evidence {strip, mill}
 *     "Dyer, Leather"          occupation head `dyer`       evidence {leather}
 *     "Magician"               occupation head `magician`   evidence {}          <- nothing to extract
 *
 * So the first question asked of every phrase is "which of your tokens are occupation
 * identity?", and this module answers it.
 *
 * ===========================================================================
 * THE LEXICON IS MEASURED, NOT INVENTED
 * ===========================================================================
 * A hand-written list of role nouns would be an engineer's guess about Indian industrial
 * vocabulary, and it would be wrong in the places that matter (`mistri`, `karigar`,
 * `khalasi`, `beldar`). Instead the lexicon is DERIVED from the catalogue we already
 * publish: every `job_domain.label_en` and every `job_domain_alias.text` of a selectable,
 * active domain is by construction the name of an occupation, so the head of that title is
 * by construction an occupation head noun.
 *
 * Two title conventions are in the corpus and they head in OPPOSITE directions:
 *
 *     NCO inverted     "Operator, Strip Mill"                       head is the FIRST clause
 *     ISCO natural     "Glass, Ceramics and Related Plant Operators" head is the LONGEST clause
 *
 * Taking the tail token of both clauses covers both, at the cost of proposing some
 * material words ("glass", "textile") as heads. That over-proposal is then filtered.
 *
 * ===========================================================================
 * THE FILTER, AND WHY IT IS TWO LISTS AND NOT A CLEVER RULE
 * ===========================================================================
 * A proposed head is accepted when it looks like an AGENT NOUN — `-er`, `-or`, `-ist`,
 * `-man`, `-ician`, `-smith`… Measured over the 13,006 occupation texts in the live
 * catalogue (2026-08-26): 2,544 distinct proposals, 1,019 accepted by morphology.
 *
 * Morphology is wrong in both directions, and both errors are recorded as reviewable DATA
 * rather than patched into the regex, because a regex that has been bent around nineteen
 * exceptions is no longer checkable by reading it:
 *
 *   {@link HEAD_EXCLUSIONS}   morphology says agent noun, the word is a THING.
 *                             `boiler`, `compressor`, `equipment`, `paper`. Measured — every
 *                             entry appeared in the accepted set of the live derivation.
 *   {@link EXTRA_ROLE_NOUNS}  morphology says no, the word is plainly a ROLE.
 *                             `clerk`, `cook`, `nurse`, `guard`, `mistri`. Measured the same
 *                             way, from the top of the REJECTED frequency table.
 *
 * WHICH DIRECTION EACH ERROR COSTS. A missing head (an under-inclusive lexicon) turns an
 * occupation title into a false skill candidate and buys a human some review work. A false
 * head (an over-inclusive lexicon) deletes a real evidence token and hides a genuine skill.
 * Neither is free, so neither list is allowed to be a guess: both are derived from the
 * measured frequency tables this module can regenerate on demand
 * (`pnpm db:discover:skills --derive-heads`).
 *
 * PLURALS are folded before anything else. `operators`, `technicians` and `managers` sat at
 * ranks 4, 7 and 8 of the rejected table purely because the suffix test ran on the plural.
 *
 * PURE. No database, no clock, no I/O — the derivation takes an array of strings. That is
 * what lets the whole classification layer be tested without a connection.
 *
 * PRIVACY: published occupation titles only. Nothing worker-derived can reach this module —
 * the caller reads `job_domain`, never a worker row.
 */
import { createHash } from "node:crypto";

import { normalizeOccupationText } from "@badabhai/profiling-lexicon";

import { taxonomyTokens } from "./taxonomy-corpus";

// ===========================================================================
// Morphology
// ===========================================================================

/**
 * Suffixes that mark a noun as "a person who does X", longest first.
 *
 * ORDER IS LOAD-BEARING: `-ician` must be tested before `-ian` would be, and `-ologist`
 * before `-ist`, or the recorded suffix is the wrong one and the derivation report reads as
 * though `electrician` were an `-an` word. The acceptance decision is unaffected; the
 * AUDIT TRAIL is, which is the thing a reviewer uses to decide whether the rule is sane.
 */
export const AGENT_NOUN_SUFFIXES: readonly string[] = [
  "ographer",
  "ologist",
  "wright",
  "ician",
  "smith",
  "eer",
  "ist",
  "ess",
  "man",
  "men",
  "ant",
  "ent",
  "er",
  "or",
];

/**
 * Characters of stem that must survive the suffix.
 *
 * Guards the short-word destruction `stripParticles` guards against for the same reason:
 * without it `ant` is an `-ant` agent noun with an empty stem, and `or` is an `-or` one.
 */
export const MIN_AGENT_NOUN_STEM = 3;

/** The agent-noun suffix a token carries, or `null`. Longest match wins. */
export function agentNounSuffix(token: string): string | null {
  for (const suffix of AGENT_NOUN_SUFFIXES) {
    if (token.endsWith(suffix) && token.length - suffix.length >= MIN_AGENT_NOUN_STEM) {
      return suffix;
    }
  }
  return null;
}

/**
 * English plural → singular, for lexicon lookup only.
 *
 * Deliberately three rules and no more. This is not a stemmer and must never become one: it
 * exists so `operators` and `operator` are one lexicon entry, and every extra rule it grows
 * is another way for two genuinely different words to collapse into one head.
 */
export function depluralize(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && (token.endsWith("ses") || token.endsWith("xes") || token.endsWith("ches") || token.endsWith("shes"))) {
    return token.slice(0, -2);
  }
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

// ===========================================================================
// The two reviewed lists
// ===========================================================================

/**
 * Tokens the morphology ACCEPTS that name a thing, not a person.
 *
 * Every entry was observed in the accepted set of the live derivation on 2026-08-26, with
 * its text frequency in brackets. Nothing speculative is listed: an exclusion that never
 * fires is an exclusion nobody can check.
 */
export const HEAD_EXCLUSIONS: readonly string[] = [
  "equipment", // [36] "...and Related Equipment"
  "paper", //     [18] material
  "member", //    [13] "...Board Member" is a role, but the token also tails "Crew Member" lists
  "instrument", //[13] material/thing
  "burner", //    [10] a furnace part as often as the person tending it
  "boiler", //    [10] the vessel
  "water", //      [9] material
  "leather", //    [6] material
  "cement", //     [4] material
  "silver", //     [4] material
  "number", //     [4] scrape residue
  "power", //      [4] material/utility
  "garment", //    [4] product
  "other", //      [3] "…, Other" — the catalogue's own residual bucket marker
  "binder", //     [3] material
  "compressor", // [2] machine
  "chamber", //    [2] machine part
  "rubber", //     [2] material
  "computer", //   [1] machine
];

/**
 * Tokens the morphology REJECTS that plainly name a role.
 *
 * Taken from the top of the rejected frequency table of the same derivation, plus the
 * Indian-vernacular role nouns that the ISCO/NCO titles do not carry but a worker says
 * out loud. The vernacular entries are the ONLY ones not attested in the English catalogue,
 * and they are listed because the pipeline's second source is literally worker language —
 * omitting them would let "silai wala" arrive as a skill candidate.
 */
export const EXTRA_ROLE_NOUNS: readonly string[] = [
  // Attested heads of the live catalogue (frequency in brackets).
  "clerk", //         [236]
  "man", //           [184]
  "professional", //  [100]
  "mechanic", //       [99]
  "executive", //      [75]
  "analyst", //        [50]
  "agent", //          [39]
  "guard", //          [37]
  "salesperson", //    [33]
  "secretary", //      [27]
  "official", //       [26]
  "steward", //        [26]
  "cook", //           [23]
  "aide", //           [22]
  "hand", //           [21]
  "representative", // [19]
  "associate", //      [18]
  "guide", //          [18]
  "nurse", //          [16]
  "captain", //        [16]
  "pilot", //          [16]
  "head", //           [15]
  "chef",
  "crew",
  "staff",
  "apprentice",
  "trainee",
  "midwife",
  "smith",
  "mate",
  "boy",
  "girl",
  "person",
  // Indian vernacular role nouns. NOT in the English catalogue; present in worker language.
  "mistri",
  "mistry",
  "karigar",
  "khalasi",
  "beldar",
  "majdoor",
  "mazdoor",
  "thekedar",
  "munshi",
  "chowkidar",
  "driverji",
  "helperji",
];

/**
 * DEVANAGARI OCCUPATION HEADS — measured from the live `lang='hi'` alias rows.
 *
 * ── WHY THIS LIST HAD TO EXIST, AND WHY IT IS SMALL ──
 *
 * The morphology above is Latin-script by construction: `-er`, `-or`, `-ist`, `-man` never
 * match Devanagari, and every entry in {@link EXTRA_ROLE_NOUNS} is a transliteration. So before
 * this list, EVERY Devanagari phrase had zero occupation heads and fell through to `AMBIGUOUS`.
 * Measured in the 2026-08-26 dry run, that put `मैकेनिक` (7 candidates), `ड्राइवर` (4) and
 * `वेल्डिंग` (4) in the ambiguous tier — a mechanic, a driver and a welding skill, all three
 * decidable, all three queued as "shape gives no signal".
 *
 * The population is 142 rows: every Devanagari alias in `job_domain_alias` carries
 * `lang='hi'` and `source='rvm'` (measured — there are no ISCO/NCO Devanagari titles, and all
 * 4,071 `job_domain.label_hi` are NULL). That is small enough to enumerate honestly, and the
 * counts below are the head-token frequencies over exactly those rows.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──
 *
 * No transliteration engine, and no attempt to fold `मिस्त्री` onto `mistri`. Both scripts stay
 * separate alias rows by design (`skeletonKey`'s docblock states that explicitly), so folding
 * them here would create a normalization the retrieval path does not perform — the drift that
 * silently breaks L0. `मिस्त्री` earns its place in this list on its own evidence, beside
 * `mistri` in the list above, and neither knows about the other.
 */
export const DEVANAGARI_ROLE_NOUNS: readonly string[] = [
  "मैकेनिक", //    [7] mechanic
  "मिस्त्री", //     [4] mistri — the mason/fitter role noun
  "ड्राइवर", //     [4] driver
  "ऑपरेटर", //     [3] operator
  "हेल्पर", //      [3] helper
  "फिटर", //       [3] fitter
  "दर्जी", //       [2] tailor
  "मेकर", //       [2] maker
  "चौकीदार", //    [1] chowkidar — watchman
  "किसान", //      [1] farmer
  "गार्ड", //       [1] guard
  "कर्मचारी", //    [1] employee/worker
  "गेटमैन", //      [1] gateman
  "जुलाहा", //      [1] weaver
  "कुली", //       [1] porter
  "माली", //       — gardener; attested in worker language, not in these 142 rows
  "नाई", //        — barber
  "धोबी", //       — launderer
  "रसोइया", //     — cook
  "बढ़ई", //        — carpenter
  "लोहार", //      — blacksmith
  "सुनार", //      — goldsmith
  "कुम्हार", //     — potter
  "मजदूर", //      — labourer
  "ठेकेदार", //     — contractor
  "मुनीम", //      — accountant/clerk
];

// ===========================================================================
// Derivation
// ===========================================================================

/** Why a token is in the lexicon. Recorded per entry so a reviewer can audit the rule. */
export type HeadAcceptance = "morphology" | "reviewed_role_noun";

/** One accepted occupation head. */
export interface DerivedHead {
  /** Singular, normalized. */
  readonly token: string;
  /** How many source titles this token headed. Evidence weight, never a threshold. */
  readonly texts: number;
  readonly accepted_by: HeadAcceptance;
  /** The agent-noun suffix, when that is why it was accepted. */
  readonly suffix: string | null;
}

/** The lexicon plus everything it declined, so the rejection is reviewable too. */
export interface HeadLexicon {
  readonly heads: ReadonlyMap<string, DerivedHead>;
  /** Proposed heads that neither morphology nor {@link EXTRA_ROLE_NOUNS} accepted. */
  readonly rejected: ReadonlyMap<string, number>;
  /** How many source titles were read. */
  readonly sourceTexts: number;
}

/**
 * The head positions of one occupation title.
 *
 * Returns the tail token of the FIRST clause and of the LONGEST clause — see the header for
 * why both. A single-clause title yields one token; the set collapses duplicates.
 */
export function clauseHeads(text: string): string[] {
  const clauses = text
    .split(/[,(){}[\]]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (clauses.length === 0) return [];
  const longest = clauses.reduce((a, b) => (b.length > a.length ? b : a));
  const out = new Set<string>();
  for (const clause of new Set([clauses[0] as string, longest])) {
    const tokens = taxonomyTokens(normalizeOccupationText(clause));
    const head = tokens[tokens.length - 1];
    if (head !== undefined && head.length > 0) out.add(depluralize(head));
  }
  return [...out];
}

/**
 * Build the lexicon from occupation titles.
 *
 * `texts` must be occupation titles and nothing else — `job_domain.label_en` and the alias
 * texts of selectable, active domains. Feeding it a mixed corpus would teach it that skill
 * words are occupation heads, which is the exact inversion the pipeline is built to avoid.
 */
export function deriveOccupationHeads(texts: readonly string[]): HeadLexicon {
  const frequency = new Map<string, number>();
  for (const text of texts) {
    for (const head of clauseHeads(text)) {
      frequency.set(head, (frequency.get(head) ?? 0) + 1);
    }
  }

  const excluded = new Set(HEAD_EXCLUSIONS);
  // Devanagari heads join the SAME reviewed set rather than getting their own branch: the rule
  // ("this token names a role, and the morphology cannot see it") is identical, and a second
  // code path would be a second place for the acceptance logic to drift.
  const extra = new Set([...EXTRA_ROLE_NOUNS, ...DEVANAGARI_ROLE_NOUNS].map((t) => depluralize(t)));

  const heads = new Map<string, DerivedHead>();
  const rejected = new Map<string, number>();

  for (const [token, count] of frequency) {
    if (excluded.has(token)) {
      rejected.set(token, count);
      continue;
    }
    const suffix = agentNounSuffix(token);
    if (suffix !== null) {
      heads.set(token, { token, texts: count, accepted_by: "morphology", suffix });
    } else if (extra.has(token)) {
      heads.set(token, { token, texts: count, accepted_by: "reviewed_role_noun", suffix: null });
    } else {
      rejected.set(token, count);
    }
  }

  // Reviewed role nouns that the corpus never happened to head with — the vernacular ones,
  // above all. They belong in the lexicon regardless: the pipeline's worker-language source
  // will produce them, and a lexicon that only knows the words the catalogue used is exactly
  // the English-only blind spot this project cannot afford.
  for (const token of extra) {
    if (heads.has(token)) continue;
    heads.set(token, {
      token,
      texts: frequency.get(token) ?? 0,
      accepted_by: "reviewed_role_noun",
      suffix: null,
    });
    rejected.delete(token);
  }

  return { heads, rejected, sourceTexts: texts.length };
}

// ===========================================================================
// Lookup
// ===========================================================================

/** Is this token an occupation head? Depluralizes before looking up. */
export function isOccupationHead(token: string, lexicon: HeadLexicon): boolean {
  return lexicon.heads.has(depluralize(token));
}

/** The occupation-identity tokens of an already-tokenized phrase, in order, deduped. */
export function occupationHeadTokens(
  tokens: readonly string[],
  lexicon: HeadLexicon,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const singular = depluralize(token);
    if (!lexicon.heads.has(singular) || seen.has(singular)) continue;
    seen.add(singular);
    out.push(singular);
  }
  return out;
}

/**
 * The ACTION STEM of an occupation head — `turner` -> `turn`, `operator` -> `operat`.
 *
 * WHY AN OCCUPATION HEAD IS NOT PURE NOISE, WHICH IS WHAT THE FIRST DESIGN ASSUMED.
 *
 * `occupationHeadTokens` exists to stop a job title becoming a skill, and it works. But the
 * first discovery run keyed candidates on the leftover EVIDENCE tokens alone, and that threw
 * away something the head was carrying: the VERB. Measured on 2026-08-26, "wood turner",
 * "wood sawyer", "wood driller", "wood patternmaker" and "wood treater" all reduced to the
 * key `"wood"` — one candidate holding 35 distinct phrases and five genuinely different
 * trades, with the word "wood" as its only proposal.
 *
 * An agent noun is a person AND an action: a turner turns, a sawyer saws, a welder welds. The
 * IDENTITY half must not become a skill; the ACTION half is exactly what a skill label needs.
 * So the head is stripped from `evidenceTokens` (it is not a thing that gets done TO something)
 * and its stem is reintroduced in the clustering key, where it separates "wood turning" from
 * "wood sawing" without ever proposing "turner" as a skill.
 *
 * CRUDE ON PURPOSE. This removes the suffix and stops; it is not a lemmatizer and must never
 * become one. `operator` -> `operat` is not a word, and it does not need to be — the stem is a
 * CLUSTERING KEY, never shown to anyone and never a proposed label. A real stemmer would buy
 * prettier keys and a new class of bug where two distinct trades stem alike.
 */
export function agentStem(head: string): string {
  const singular = depluralize(head);
  const suffix = agentNounSuffix(singular);
  if (suffix === null) return singular;
  const stem = singular.slice(0, singular.length - suffix.length);
  return stem.length >= MIN_AGENT_NOUN_STEM ? stem : singular;
}

/**
 * A stable digest of WHICH lexicon a classification used.
 *
 * Two runs that disagree about whether "fitter" is an occupation head produce different
 * candidate sets from identical inputs, and without this the difference is invisible. The
 * digest goes into the candidate's corpus fingerprint for the same reason
 * `corpus-fingerprint.ts` exists: freshness is proved by equality, never by a timestamp.
 *
 * Covers the accepted tokens only. The rejected table is diagnostics — it changes with every
 * source-corpus edit and folding it in would make every fingerprint unique and therefore
 * useless.
 */
export function headLexiconFingerprint(lexicon: HeadLexicon): string {
  const tokens = [...lexicon.heads.keys()].sort();
  return createHash("sha256").update(tokens.join("\u0001")).digest("hex").slice(0, 32);
}
