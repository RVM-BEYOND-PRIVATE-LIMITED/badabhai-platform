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
  /**
   * The second statutory number, and it sits beside `uan_pf` because they are the same fact about
   * a worker: whether he is already inside the formal system.
   *
   * MEASURED, NOT ASSUMED. It appears on THIRTEEN of the twenty-one ratified reference pages —
   * more often than `experience_letter` (3) and `passport_photos` (2), both of which have had a
   * slug here since the beginning. Every other document those pages print was already in this
   * dictionary; ESIC was the only one missing, so a worker who has one had no way to say so and
   * the row simply never mentioned it.
   *
   * IT IS HIRING FRICTION, WHICH IS WHAT THIS BLOCK IS FOR. An employer reading "documents ready"
   * is asking how fast this man can start. A worker who already holds an ESIC number joins on the
   * existing registration; one who does not needs a fresh enrolment before he is covered, and on
   * a factory floor that is a real delay somebody has to own.
   */
  esic: "ESIC",
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
 * WHICH trade credential the worker holds — an ITI trade certificate or a polytechnic diploma
 * (R11 §3.1).
 *
 * THE SAME SHAPE AS {@link EDUCATION_COUNCILS} AND FOR THE SAME REASON. `qp_universal`'s
 * education question offers ONE option covering both ("ITI ya diploma", `value_text`
 * `iti_diploma`), so the distinction has no representation anywhere in the corpus and Zone 5's
 * most-checked line prints "ITI / Diploma" where the ratified sheet prints "ITI". Like the
 * council, this is not a rule that was implemented badly — until this dictionary existed there
 * was no value to collapse.
 *
 * WHY IT MATTERS TO A SUPERVISOR. A two-year ITI trade certificate and a three-year polytechnic
 * diploma are different credentials with different entry routes and different pay bands, and a
 * job advertisement that says "ITI Turner" means the first one. A slash tells the reader we do
 * not know which — on the one line an employer checks hardest.
 *
 * ON THE FORM, NOT IN A NEW PACK VERSION, and that is a deliberate routing call rather than the
 * cheap option. Pack versions are IMMUTABLE and sit beside each other: a session pins
 * `(pack_id, version)` for its whole length, so splitting the option in place is not available
 * and publishing `qp_universal@3` would leave every worker mid-interview on @2 still answering
 * the merged option. The form reaches those workers too, and it reaches the ones who already
 * finished — which a new pack version never can.
 *
 * BACKWARD COMPATIBLE BY CONSTRUCTION. `education_level` keeps its stored `iti_diploma` value and
 * its meaning; this is an ADDITIONAL, narrower fact. A worker who never answers the form still
 * prints "ITI / Diploma", which is true of him — it is unspecific, not wrong.
 *
 * ═══ #1447 — THE CLIENT STOPPED ASKING; THIS DID NOT BECOME DEAD ═══
 *
 * The trade form's "Availability & terms" marker no longer collects the credential, and #1447
 * asked whether this dictionary and the four `education_*` attribute keys could now be dropped.
 * They cannot, for two independent reasons.
 *
 * FIRST, THE WRITE HAS NOT ACTUALLY STOPPED. Two client surfaces PUT to /workers/me/work-preferences
 * and only one of them changed: the finishing form still sends all four
 * (`finishing_models.dart:221-227`).
 *
 * SECOND — and this holds even if both stopped — "no client writes it" and "nothing reads it" are
 * different facts, and only the first would be true.
 *
 * READ PATH, STILL LIVE: `resume-preference-facts.ts:146` composes `educationCredential` /
 * `educationDetail` from these keys, and `resume-render-input.ts` resolves Zone 5's education
 * headline as `tradeSheet?.qualification?.educationHeadline ?? <that composition>` (:627, :902).
 * The `??` is a FALLBACK, not a leftover — it is what a worker with no `worker_education` rows
 * renders from, and that is every worker who answered the old form plus every worker who
 * completes the trade form without reaching the qualifications marker.
 *
 * WHAT DELETING IT WOULD COST, measured rather than guessed. `educationLevelText` narrows the
 * merged `iti_diploma` level to the credential ONLY when this value is present; without it a
 * worker whose interview stored `iti_diploma` renders "ITI / Diploma — Machinist" instead of
 * "ITI — Machinist" — the exact R11 §3.1 defect this dictionary was built to fix, on the one line
 * an employer checks hardest. `yadav-parity.contract.test.ts` pins both halves of that already.
 * The council, year and institute segments would go with it.
 *
 * SO THE CORRECT STATE IS: write path retired at the client's discretion, read path retained and
 * load-bearing. Retiring the READ is a migration of historical worker data onto
 * `worker_education` rows, not a deletion.
 */
export const EDUCATION_CREDENTIALS: PreferenceVocabulary = {
  iti: "ITI",
  diploma: "Diploma",
};

/**
 * A WHOLE credential, for a `worker_education` row (migration 0098).
 *
 * ═══ WHY THIS IS NOT {@link EDUCATION_CREDENTIALS} ═══
 *
 * That dictionary answers a NARROWER question — "the option you tapped names two credentials,
 * which is yours" — and holds exactly two values because a third would make it a competing answer
 * to `education_level` rather than a refinement of it. This one answers the whole question,
 * because a `worker_education` row is a credential in its own right rather than a narrowing of
 * one the interview already captured.
 *
 * ═══ IT IS THE SHIPPED LEVEL SET WITH ONE SPLIT, NOT A NEW TAXONOMY ═══
 *
 * Four of these six are `KNOWN_EDUCATION_LEVELS`'s own labels, character for character, and the
 * remaining two are `iti_diploma` finally separated into the two real credentials R11 §3.1 said
 * must never be collapsed. A worker's stored level and a worker's stored education row therefore
 * print the SAME words for the same schooling — which is the whole reason to reuse the labels
 * rather than write better ones here.
 *
 * ═══ WHAT IT DELIBERATELY DOES NOT DO ═══
 *
 * It does not grow a value for every credential a worker might hold. A B.Tech maps to "Graduate",
 * exactly as it does through `education_level` today, so this is the platform's existing
 * expressiveness plus one refinement rather than a new promise. Widening it is a data change with
 * no migration behind it — but a value added here starts printing on résumés immediately, so it
 * is a ratification decision (`docs/registers/trade-content-ratification.md`), not a typing one.
 */
export const EDUCATION_QUALIFICATIONS: PreferenceVocabulary = {
  // ── THE LABELS ARE `KNOWN_EDUCATION_LEVELS`'s OWN; THE SLUGS DELIBERATELY ARE NOT ──────────
  //
  // The printed English matches that map character for character, so a worker's stored level and
  // their stored education row name the same schooling the same way. The SLUGS differ for two
  // reasons, and the correspondence is written out below so a future join has it in one place:
  //
  //   `class_10` ↔ `KNOWN_EDUCATION_LEVELS["10"]`      `iti`      ↘ both ↔ `iti_diploma`
  //   `class_12` ↔ `KNOWN_EDUCATION_LEVELS["12"]`      `diploma`  ↗ (R11 §3.1's split)
  //   `below_10`, `graduate` are identical on both sides.
  //
  // FIRST, `^[a-z_]+$` IS THE PLATFORM'S SLUG SHAPE. Attribute keys enforce it (`wa_attribute_key_chk`)
  // and `slugKey` refuses digits at runtime — which is why the pack authoring guide lists
  // "no digits in question_key / option_key" as a trap that passes the corpus validator and then
  // makes a whole pack unparseable. This column has no CHECK to enforce it, and following the
  // convention anyway is what keeps one shape of slug on the platform.
  //
  // SECOND, AND CONCRETELY: JavaScript hoists integer-like keys to the FRONT of an object. With
  // "10" and "12" as keys, `Object.keys` — which is exactly what the options endpoint serves and
  // what the DTO builds its enum from — returns them BEFORE `below_10`, so the client renders
  // "10th pass · 12th pass · Below 10th · ITI …". The ladder reads out of order for every worker,
  // and no amount of care at the call site can fix it while the keys are numeric.
  below_10: "Below 10th",
  class_10: "10th pass",
  class_12: "12th pass",
  iti: "ITI",
  diploma: "Diploma",
  graduate: "Graduate",
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
  // R11 §3.1 — WHICH of the two credentials the merged `iti_diploma` option covers. Not a
  // replacement for `education_level`: that key keeps its value and its meaning, and this one
  // narrows it when the worker says which.
  education_credential: "text",
  education_council: "text",
  education_year: "number",
  education_institute: "text",
} as const;

export type PreferenceKey = keyof typeof PREFERENCE_KEYS;

/**
 * Print an option through its dictionary. An unknown slug yields null and is DROPPED.
 *
 * THE `typeof` CHECK IS NOT DEFENSIVE PADDING — it is the same one {@link labelsFor} has always
 * had one function below, and this one was missing it. These dictionaries are plain object
 * literals, so a slug naming an `Object.prototype` member — `toString`, `constructor`, `valueOf`,
 * `hasOwnProperty` — resolves to a FUNCTION rather than to `undefined`, and `?? null` does not
 * catch a function. The caller then hands it to a string composer and the render throws
 * `p?.trim is not a function`: a 500 instead of the dropped segment this function's own contract
 * promises, which is the exact inversion of the safety property.
 *
 * NOT REACHABLE THROUGH AN API WRITE TODAY — every caller's slug comes from a `z.enum` built over
 * these same keys. It is reachable through the DATABASE: `worker_education.credential` and
 * `.council` are plain `text` with no format check, so a hand-written row, a backfill or a future
 * writer can put one there. A row that cannot be printed must cost its segment, never the sheet.
 */
export function labelFor(vocabulary: PreferenceVocabulary, slug: string): string | null {
  const label = vocabulary[slug];
  return typeof label === "string" ? label : null;
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
