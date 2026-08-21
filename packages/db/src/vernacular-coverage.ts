/**
 * Vernacular register classification and fixture hygiene — the PURE core (D-6).
 *
 * ===========================================================================
 * WHY "REGISTER" AND NOT "LANGUAGE"
 * ===========================================================================
 * The fixture's `lang` field says `en` or `hi`, and that is not the distinction retrieval
 * actually faces. A worker types Hindi in Latin script — "welding ka kaam karta hun" — and
 * that string is `hi` by language and `en` by every character in it. Counting by `lang` puts
 * it in neither bucket honestly.
 *
 * So a REGISTER is script plus register-of-speech:
 *
 *   devanagari      वेल्डिंग का काम        — Hindi, Devanagari script
 *   hinglish_latin  welding ka kaam        — Hindi, Latin script (romanized / code-switched)
 *   english_latin   welding work           — English
 *
 * The middle one is the one the corpus was built for and the one nothing measures. The
 * particle list in `@badabhai/profiling-lexicon` exists precisely to strip "ka kaam karta
 * hun"; it is the sharpest available evidence that a Latin string is Hindi, so it is what
 * this classifier uses rather than a language-detection guess.
 *
 * ===========================================================================
 * SIBLING LEXICAL HYGIENE
 * ===========================================================================
 * `siblingLexicalLeaks` is the generalized form of the rule that caught TP-36 and TP-19: a
 * positive test phrase may not carry the LABEL or an ALIAS of a DIFFERENT skill wired to the
 * SAME domain, because then there is no correct answer for retrieval to find and the case
 * measures nothing. It was written inline against the 41 trainer cases; here it takes any
 * case set, so a future vernacular fixture inherits the guarantee instead of re-deriving it.
 *
 * NO IO. Inputs are values.
 */

/** Script plus register-of-speech — the distinction `lang` cannot express. */
export type Register = "devanagari" | "hinglish_latin" | "english_latin";

const DEVANAGARI = /[ऀ-ॿ]/u;

/**
 * Classify one query.
 *
 * Devanagari wins on ANY Devanagari character: a code-switched string like
 * "panel ka वायरिंग" is not English, and calling it Latin would hide it in the English
 * bucket, which is the specific miscount this function exists to prevent.
 *
 * `latinParticles` should be the Latin-script subset of the profiling-lexicon particle
 * corpus. Matching is whole-token, so "ke" matches "panel ke wiring" and not "make".
 */
export function classifyRegister(query: string, latinParticles: ReadonlySet<string>): Register {
  if (DEVANAGARI.test(query)) return "devanagari";
  for (const token of query.toLowerCase().match(/[a-z]+/gu) ?? []) {
    if (latinParticles.has(token)) return "hinglish_latin";
  }
  return "english_latin";
}

export interface RegisterCoverage {
  readonly total: number;
  readonly byRegister: Readonly<Record<Register, number>>;
  /** Registers with no case at all — the gap, stated as a list rather than inferred from a 0. */
  readonly absent: readonly Register[];
}

export function summarizeRegisters(
  queries: readonly string[],
  latinParticles: ReadonlySet<string>,
): RegisterCoverage {
  const byRegister: Record<Register, number> = {
    devanagari: 0,
    hinglish_latin: 0,
    english_latin: 0,
  };
  for (const q of queries) byRegister[classifyRegister(q, latinParticles)] += 1;
  const absent = (Object.keys(byRegister) as Register[]).filter((r) => byRegister[r] === 0);
  return { total: queries.length, byRegister, absent };
}

/* ===========================================================================
 * HYGIENE
 * =========================================================================== */

/**
 * `null` as well as `undefined`: the fixture loader models "no scope" as `null`, and a type
 * that accepted only `undefined` would force every caller to launder the value before a
 * hygiene check — which is exactly the friction that gets a check skipped.
 */
export interface HygieneCase {
  readonly case_id: string;
  readonly query: string;
  readonly job_domain_id?: string | null | undefined;
  readonly expected_skill_id?: string | null | undefined;
}

export interface SiblingLeak {
  readonly case_id: string;
  readonly job_domain_id: string;
  readonly sibling_skill_id: string;
  /** The sibling's own label or alias, found verbatim inside the query. */
  readonly token: string;
}

/**
 * Every case whose query carries a sibling skill's lexical identity.
 *
 * Substring rather than word-boundary matching, deliberately: "mig machine" leaked past a
 * word-boundary check via a bare "mig", and Devanagari has no boundaries `\b` can see. The
 * 3-character minimum keeps short ids from matching inside unrelated words.
 *
 * A case with no `job_domain_id` or no `expected_skill_id` has no sibling set to check
 * against and is skipped rather than reported — absence of scope is not a leak.
 */
export function siblingLexicalLeaks(
  cases: readonly HygieneCase[],
  identity: ReadonlyMap<string, readonly string[]>,
  siblings: ReadonlyMap<string, readonly string[]>,
): SiblingLeak[] {
  const leaks: SiblingLeak[] = [];
  for (const c of cases) {
    if (c.job_domain_id == null || c.expected_skill_id == null) continue;
    const q = c.query.toLowerCase();
    for (const sib of siblings.get(c.job_domain_id) ?? []) {
      if (sib === c.expected_skill_id) continue;
      for (const token of identity.get(sib) ?? []) {
        if (token.length >= 3 && q.includes(token)) {
          leaks.push({
            case_id: c.case_id,
            job_domain_id: c.job_domain_id,
            sibling_skill_id: sib,
            token,
          });
        }
      }
    }
  }
  return leaks;
}

/** The design rule this module encodes, stated once. */
export const HYGIENE_RULE =
  "Vernacular paraphrase quality requires sibling lexical-hygiene validation, not merely " +
  "translation quality: a positive case may not carry the label or alias of a different " +
  "skill wired to the same domain, because then no correct answer exists to retrieve.";
