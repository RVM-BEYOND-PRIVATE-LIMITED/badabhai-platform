/**
 * The closed vocabulary of the post-interview finishing form (R6 §4).
 *
 * WHY THESE FIELDS ARE A FORM AND NOT INTERVIEW QUESTIONS. Every one of them is a closed-set
 * multi-select. They need no model, they cost nothing to answer, and they cannot be misparsed
 * because there is nothing to parse — so spending an engine ask on one is spending the scarcest
 * budget we have on the cheapest question we have. The interview's budget belongs to trade
 * capability, durations, and anything where the worker's own phrasing carries meaning.
 *
 * ONE DICTIONARY, TWO READERS, AND THAT IS THE POINT. `worker-preferences.dto.ts` derives its
 * zod enums from these keys, and `resume-render-input.ts` prints these labels. A second copy of
 * either half is a slug reaching a printed sheet the first time someone adds an option to one
 * list and not the other — the exact failure `trade-resume-map.ts` documents for pack answers.
 *
 * THE LABEL IS THE ANSWER OF RECORD, in English, because this half of the sheet is read by a
 * hiring supervisor. The worker sees Hinglish chip text in the app; that text lives in the
 * client and is never what gets printed.
 */

/** A closed option set: slug → the English printed on the sheet. */
export type PreferenceVocabulary = Readonly<Record<string, string>>;

/**
 * Languages the worker SPEAKS. §4.5 puts this on the sheet; nothing in the 143-pack corpus asks
 * it, and `crosswalk.ts` records `draftPath: null` — so before this form there was neither an ask
 * nor a column, and the row could never render for anybody.
 *
 * REGIONAL LANGUAGES ARE FIRST-CLASS, not an "other" bucket. Both ratified samples list one
 * (Haryanvi, Bhojpuri) beside Hindi and English, because a supervisor staffing a Faridabad shop
 * floor reads "Haryanvi" as a fact about how the man will be understood on the line.
 */
export const LANGUAGES: PreferenceVocabulary = {
  hindi: "Hindi",
  english: "English",
  haryanvi: "Haryanvi",
  bhojpuri: "Bhojpuri",
  punjabi: "Punjabi",
  marathi: "Marathi",
  gujarati: "Gujarati",
  bengali: "Bengali",
  tamil: "Tamil",
  telugu: "Telugu",
  kannada: "Kannada",
  malayalam: "Malayalam",
  odia: "Odia",
  urdu: "Urdu",
  assamese: "Assamese",
  rajasthani: "Rajasthani",
};

/**
 * Documents the worker SAYS he can bring. §5.1 ranks this ninth of eleven because it removes the
 * most common walk-in failure before it happens.
 *
 * SELF-DECLARED, AND NOTHING HERE SAYS OTHERWISE — the masthead badge is the only thing on the
 * sheet that speaks to verification, and it is deliberately separate. A worker ticking "Aadhaar"
 * is claiming he can produce it at a gate, never that anyone has seen it.
 */
export const DOCUMENTS_READY: PreferenceVocabulary = {
  aadhaar: "Aadhaar",
  pan: "PAN",
  bank_account: "Bank account",
  uan_pf: "UAN / PF",
  iti_certificate: "ITI certificate",
  experience_letter: "Experience letter",
  passport_photos: "Passport photos",
  driving_licence: "Driving licence",
};

/**
 * Employment type. §4.4 — the commercial block "every competitor omits", and the ratified sheet
 * prints it beside the shift ("Rotational shifts · Permanent").
 */
export const JOB_TYPES: PreferenceVocabulary = {
  permanent: "Permanent",
  contract: "Contract",
  apprentice: "Apprenticeship",
  daily_wage: "Daily wage",
};

/**
 * Shift. THE FORM'S SET IS A DELIBERATE SUPERSET OF THE PACK'S.
 *
 * `qp_universal`'s `shift_preference` offers `day` / `night` / `any`, and this form writes the
 * SAME attribute key — so a worker who answered in the interview and then answers here upserts
 * one row rather than accumulating two. `rotational` is added because it is a different fact
 * from `any`: "any" is what a man will accept, "rotational" is what he actually works, and the
 * ratified sheet prints the second. One dictionary covers both vocabularies, which is what keeps
 * a pack-written value and a form-written value printable by the same reader.
 */
export const SHIFTS: PreferenceVocabulary = {
  day: "Day shift",
  night: "Night shift",
  rotational: "Rotational shifts",
  any: "Any shift",
};

/**
 * The awarding COUNCIL of a trade credential (R9 §3).
 *
 * §4.5 FORBIDS COLLAPSING NCVT AND SCVT, and until this existed the rule was unenforceable
 * rather than merely unimplemented: nothing in the pack corpus, the contract or the schema could
 * represent the distinction at all, so there was no value to collapse. The ratified sheet prints
 * it as its own segment — "ITI — Machinist · NCVT · 2018 · Govt. ITI, Faridabad".
 *
 * WHY IT MATTERS TO A SUPERVISOR, which is the only reason a row earns space: NCVT is the
 * national certificate and SCVT the state one, and they are not interchangeable for a job that
 * requires a specific trade certificate. Printing "ITI" alone throws away the distinction the
 * employer is actually checking.
 *
 * A CLOSED SET WITH NO "OTHER". A council the list does not know yields no segment rather than a
 * raw slug — the same rule every other dictionary here follows.
 */
export const EDUCATION_COUNCILS: PreferenceVocabulary = {
  ncvt: "NCVT",
  scvt: "SCVT",
  nsqf: "NSQF",
  aicte: "AICTE",
  state_board: "State board",
  cbse: "CBSE",
  icse: "ICSE",
  open_school: "NIOS / Open school",
};

/**
 * Every attribute key this form writes, and the storage kind each one takes.
 *
 * KEYS MATCH `wa_attribute_key_chk` (`^[a-z_]+$`, ≤ 40) and two of them deliberately match keys
 * that already exist elsewhere: `shift_preference` is `qp_universal`'s, and
 * `relocation_willingness` was `qp_universal@1`'s before v2 dropped the ask. Reusing the key is
 * what makes the form an ANSWER to the same question rather than a second, competing fact.
 */
export const PREFERENCE_KEYS = {
  languages: "text_list",
  documents_ready: "text_list",
  preferred_locations: "text_list",
  job_type: "text",
  shift_preference: "text",
  relocation_willingness: "boolean",
  accommodation_needed: "boolean",
  // R9 §3 — the three components of a credential the sheet prints and nothing captured. The
  // TRADE is not here: `education_field` already holds it, it rides the answer-map crosswalk onto
  // the draft, and adding a second key for the same fact is how two sources start disagreeing
  // about one worker's ITI.
  // R10 R-1 — the BAND's upper end. The lower end stays `salary_expected`, the interview's
  // existing ask, whose stored meaning is unchanged: it is the figure the worker said he wants,
  // and it is the number he will not go below.
  //
  // ON THE FORM RATHER THAN IN THE INTERVIEW, DELIBERATELY. This pack's own `_v2` note records an
  // owner ruling dated 2026-08-11: "the template tail is SIX questions." A seventh would break it
  // silently. It also fails R9 section 3's routing rule — a salary figure needs no language, so it
  // does not earn an engine ask when abandonment is the binding constraint (R-4's own reasoning).
  // If the ruling is that it belongs in the interview instead, that is a pack-data change plus a
  // ruling on the six-question tail.
  salary_expected_max: "number",
  education_council: "text",
  education_year: "number",
  education_institute: "text",
} as const;

export type PreferenceKey = keyof typeof PREFERENCE_KEYS;

/** Print an option through its dictionary. An unknown slug yields null and is DROPPED. */
export function labelFor(vocabulary: PreferenceVocabulary, slug: string): string | null {
  return vocabulary[slug] ?? null;
}

/**
 * Print a list of options, dropping anything the dictionary does not know.
 *
 * DROPPING IS THE SAFETY PROPERTY, not an oversight — the same rule `trade-resume-map.ts`
 * states for pack answers. A slug like `uan_pf` on a printed sheet is worse than an absent row,
 * and an option removed from a dictionary must stop printing rather than start printing raw.
 */
export function labelsFor(vocabulary: PreferenceVocabulary, slugs: readonly string[]): string[] {
  return slugs.map((s) => vocabulary[s]).filter((l): l is string => typeof l === "string");
}
