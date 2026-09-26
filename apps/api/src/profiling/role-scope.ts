/**
 * IS THIS WORKER ONE OF THE 21, OR OUTSIDE THEM? (ADR-0045 §3.1, ruling R1)
 *
 * THE QUESTION THIS ANSWERS. An armed chat session runs today's Phase A until the role is known,
 * then settles into one of two lanes: `classic` (today's interview, byte for byte) or `skills`
 * (the general road — a skills-only model stage, the "Kya aur koi skill jodni hai?" gate, then the
 * offline general form). The owner's ruling R1 is that ONLY roles outside the 21 declared roles
 * take the skills lane, and "the 21" is every descriptor in `ROLE_FORM_DESCRIPTORS` — the 16 whose
 * forms ship AND the 5 polymer roles whose forms do not exist yet. This module is the read the
 * lane decision is built on. It decides nothing else, calls nothing, and nothing calls it yet.
 *
 * AI PROPOSES, CODE DECIDES (§3). The model contributes two free-text labels; retrieval
 * contributes a family pin and its catalogue label. This is a closed table and a pure function
 * over them: no network, no model, no clock, and the same answer every time for the same input.
 *
 * ── THREE ANSWERS, NOT TWO ───────────────────────────────────────────────────────────────────
 *
 *   declared  Something names one of the 21 — the lane is `classic`.
 *   outside   The model captured a role, and after every word that is not evidence has been
 *             removed, something is still left that names none of the 21 — the lane is `skills`.
 *   unknown   Nothing yet says either. The caller keeps asking Phase A, or — if Phase A has ended —
 *             stays on `classic`, as §3.1 says a Phase A that ended without a role does.
 *
 * `unknown` IS WHAT MAKES THE LEVEL-WORD RULE ENFORCEABLE. §3.1 says level words ("senior",
 * "operator", "helper") and machine words are "not evidence either way". A two-valued answer
 * cannot express "either way": "operator" would have to be declared or outside, and both are a
 * guess. So a label made only of such words is `unknown`, which is neither.
 *
 * ── THE ASYMMETRY, WHICH EVERY CHOICE BELOW LEANS ON ─────────────────────────────────────────
 *
 * The two mistakes do not cost the same.
 *
 *   A FALSE `declared` costs the worker nothing they have today. They get today's interview,
 *   exactly — the path every worker outside the 21 was on until this ADR.
 *   A FALSE `outside` takes one of the 21 off the path the owner built for them: no trade-form
 *   offer, no trade sheet, a general résumé for a turner. That is the mistake the ruling exists
 *   to prevent.
 *
 * So `declared` is easy to reach (ANY one of four independent pieces of evidence) and `outside`
 * is hard to reach (the role must be present AND must survive the strip). Every open question in
 * this file was settled in that direction, and a case that resolves the other way is a bug.
 *
 * ── WHY THE ROUTER'S VETO IS NEVER APPLIED HERE ──────────────────────────────────────────────
 *
 * `routeToTradeForm`'s conflict terms answer a DIFFERENT question: "which ONE form fits?". A
 * worker who says "CNC turning aur VMC" is vetoed there because two of the 21 claim him and the
 * honest answer is to keep talking. That is still two of the 21. Applying the veto here would
 * turn "ambiguous between two declared roles" into "outside all of them" — the false `outside`
 * above, produced by exactly the workers most certainly inside. The veto keeps its job in the
 * router, which the classic lane still runs.
 *
 * PRIVACY: this reads model labels and a catalogue label and returns one of three words. It logs
 * nothing, and a caller must not log the labels it was given — a role label is the worker's text.
 */
import { isUniversalPlaceholderLabel } from "../occupation/family-chip-labels";

import { ROLE_FORM_DESCRIPTORS } from "./roles/role-registry";
import { containsAny, normalise, routeToTradeForm } from "./trade-form-router";

export type RoleScope = "declared" | "outside" | "unknown";

export interface RoleScopeInput {
  /** Phase A's `domain_label`. Can make a role `declared`; never makes one `outside`. */
  readonly domainLabel: string | null;
  /** Phase A's `role_label`. The ONLY field that can make a role `outside`. */
  readonly roleLabel: string | null;
  /** The family retrieval pinned, when it pinned one. */
  readonly pinFamilyId: string | null;
  /**
   * The CATALOGUE label of that pin — `OccupationPin.label`. Ignored when it is the universal
   * placeholder ("General"), which the #1691 ruling says is never a trade.
   */
  readonly pinLabel: string | null;
}

/**
 * THE ONE TEXT PREPARATION, applied to the input AND to every term in every table below.
 *
 * NFKC FIRST, because the labels are the model's words and the model echoes whatever the worker
 * typed. A phone keyboard in full-width mode sends "ＴＵＲＮＥＲ", which lowercases to
 * "ｔｕｒｎｅｒ" and matches nothing; NFKC folds it to "TURNER" before the router's `normalise`
 * lowercases it. The same fold settles the two spellings of a Devanagari nukta (U+095B ज़ is a
 * composition exclusion, so NFKC always yields ज + U+093C), which is why the TERMS are folded
 * too: a table term typed with one spelling must match a label written with the other.
 *
 * THE ROUTER'S `normalise`, NOT A SECOND ONE. It carries the `\p{M}` lesson — a class without
 * combining marks silently strips every Devanagari vowel sign and virama — and a copy here would
 * be free to forget it the day somebody "simplified" one of the two.
 */
function prepare(value: string | null): string {
  return value === null ? "" : normalise(value.normalize("NFKC"));
}

/** One letter and nothing else — what `normalise` leaves of each letter of "C.N.C" or "Q.C.". */
const SINGLE_LETTER = /^\p{L}$/u;

/**
 * A prepared text with every run of two or more single-letter tokens joined back into one token.
 *
 * DOTTED ABBREVIATIONS ARE HOW THE TRADE IS WRITTEN. "C.N.C operator", "V.M.C operator" and "Q.C.
 * inspector" are ordinary Indian spellings, and `normalise` turns the dots into spaces: "c n c",
 * "v m c", "q c". Joined, they are the "cnc", "vmc operator" and "qc" every table already holds.
 * This is the classifier's own step, not the router's: `normalise` is shared, and joining there
 * would move routes this module has no say over.
 */
function joinLetterRuns(prepared: string): string {
  if (prepared.length === 0) return prepared;
  const tokens: string[] = [];
  let run = "";
  for (const token of prepared.trim().split(" ")) {
    if (SINGLE_LETTER.test(token)) {
      run += token;
      continue;
    }
    if (run.length > 0) tokens.push(run);
    run = "";
    tokens.push(token);
  }
  if (run.length > 0) tokens.push(run);
  return ` ${tokens.join(" ")} `;
}

/**
 * Every way a prepared text can be read: as written, and with its letter runs joined.
 *
 * BOTH, BECAUSE A JOIN CAN SWALLOW A WORD. "I am a C.N.C operator" joins to "i am acnc operator":
 * the article "a" is a single letter too, and "acnc" names nothing. Read as written, the same label
 * is "i am a c n c operator", which strips to nothing. So each reading is asked and the asymmetry
 * in the header picks the answer: `declared` if ANY reading names one of the 21, `unknown` if ANY
 * reading strips to nothing, and `outside` only when EVERY reading still has a role left.
 */
function readings(prepared: string): readonly string[] {
  const joined = joinLetterRuns(prepared);
  return joined === prepared ? [prepared] : [prepared, joined];
}

/**
 * A table term in the SAME form the haystack takes, unpadded.
 *
 * FOLDING THE TERMS IS A STRENGTHENING, and only ever in the safe direction for occupation terms:
 * "tool & die maker" can never match a normalised haystack as written (the `&` is gone from the
 * haystack), and "tool die maker" can. Every term is NFKC-stable today; the fold is there so an
 * authored term never has to be.
 */
function prepareTerms(terms: Iterable<string>): readonly string[] {
  const prepared = new Set<string>();
  for (const term of terms) {
    const folded = prepare(term).trim();
    if (folded.length > 0) prepared.add(folded);
  }
  return Object.freeze([...prepared]);
}

/**
 * Every occupation term of ALL 21 — enabled or not.
 *
 * ALL 21, NOT `ENABLED_ROLE_DESCRIPTORS`. The router routes only the 16 whose forms ship; the
 * ruling's "21" includes the 5 polymer roles, and a worker who says "injection moulding" has
 * named one of them. Those five keep today's chat (R1), which is precisely `declared`.
 */
export const DECLARED_OCCUPATION_TERMS: readonly string[] = prepareTerms(
  ROLE_FORM_DESCRIPTORS.flatMap((descriptor) => descriptor.detection.occupationTerms),
);

/**
 * WORDS THAT NAME ONE OF THE 21 BUT THAT THE ROLE FILES LEAVE OUT ON PURPOSE — this module's own
 * recall list, never the router's.
 *
 * WHY THE REGISTRY'S TERMS ARE NOT ENOUGH HERE. An occupation term answers the ROUTER's question,
 * "which ONE form?", and routes with no pin at all, so every role file tunes its terms for
 * PRECISION: `press-operator.role.ts` bans bare "press" (a printing press), `fitter.role.ts` bans
 * "mechanical fitter" (a control-panel fitter's catalogue title), and the polymer roles list only
 * compounds. This module asks a RECALL question — "could this be one of the 21?" — and reading a
 * precision list for recall is exactly how "Moulder" and "Machinist" became a false `outside`.
 * So the gap is closed HERE, where a false `declared` costs nothing, and NEVER in a role file,
 * where the same word would route a form.
 *
 * A STEM COVERS ITS COMPOUNDS. Terms match on whole tokens, so "moulding" already matches
 * "moulding machine", "plastic moulding" and "moulding helper"; the compounds are cases in the
 * test, not entries here (the test holds that no entry shadows another).
 *
 * EVERY ENTRY IS AN ACCEPTED FALSE `declared` SOMEWHERE — a POP cornice "moulding", a "sewing
 * machine mechanic" — and each is accepted on the header's asymmetry; the test names them.
 */
export const SCOPE_DECLARED_TERMS: readonly string[] = prepareTerms([
  // ── THE 5 POLYMER ROLES (R1: they keep today's path). The registry has only the compounds
  // ("injection moulding", "moulding operator", "rubber moulding", "blow moulding"), and "mould" /
  // "mold" / "मोल्ड" are stripped as the mould maker's machine words — so the bare stem was left
  // over as proof of `outside`. Retrieval does not save them: the committed corpus pins nothing for
  // "Moulder" or "Plastic moulding", so `fam_rubber_plastic` is never reached.
  "moulding",
  "molding",
  "moulder",
  "molder",
  "मोल्डिंग",
  "मोल्डर",
  // ── MACHINIST. `conventional-machinist.role.ts` lists the bare Devanagari "मशीनिस्ट" but not the
  // Latin word, so the lane depended on the script. A bare machinist is one of the 21 whichever
  // machining role he is.
  "machinist",
  // ── ASSEMBLY. The same script split: the bare Devanagari "असेंबली" is the assembly line's term,
  // the Latin word is not. And bare "assembler" reaches NO single pin offline — it ties between
  // `fam_assemblers_other` and `fam_assembly_line` — so the adjacent pin cannot rescue it either.
  "assembly",
  "assembler",
  "assemblers",
  "असेंबलर",
  // ── THE INDUSTRIAL ELECTRICIAN'S RUNG, QUALIFIED. "electrician" and "wireman" are ruled rungs
  // (see `OUTSIDE_RULED_RUNGS`), so they are never stripped and bare they read `outside`. Qualified
  // by the panel or by maintenance they are the plant electrician the ruling keeps inside; the
  // registry holds "panel electrician" and "panel wiring" but not these two orders of it.
  "panel wireman",
  "maintenance electrician",
  "मेंटेनेंस इलेक्ट्रीशियन",
  // ── MAINTENANCE, QUALIFIED. "maintenance" is the maintenance technician's machine word, so it is
  // stripped and whatever stands beside it — "mechanic", or a discipline — was read as the role.
  // The discipline is the maintenance technician's own first row ("Mechanical · Hydraulic ·
  // Pneumatic · Basic electrical"), and a machine mechanic is that trade in other words.
  "maintenance mechanic",
  "mechanical maintenance",
  "electrical maintenance",
  "machine mechanic",
  // ── THE MECHANICAL FITTER. `fitter.role.ts` keeps "mechanical fitter" out of its terms because
  // retrieval lands it on a control-panel fitter's code (7412.0202, `fam_electrical_equipment`),
  // and records that he "keeps the generic interview" — which is today's path, i.e. `declared`.
  "mechanical fitter",
  // ── THE CAD DRAUGHTSMAN, IN THE OTHER WORD ORDER. The registry has "mechanical draftsman" and
  // "draughtsman mechanical" but not "draftsman mechanical", and "design engineer" is the CAD
  // draughtsman's top rung, so "mechanical design engineer" is that ladder named in full.
  "draftsman mechanical",
  "mechanical design engineer",
  // ── QUALITY. "qc" and "qa qc" are the quality inspector's terms; "qa" alone was not, so "QA
  // inspector" read `outside` while "QC inspector" read `declared`. ("QA QC inspector" is already
  // inside "qa qc".)
  "qa inspector",
]);

/** The 21 descriptors' own families. A pin to any of them is one of the 21 on the pin alone. */
export const DECLARED_FAMILY_IDS: ReadonlySet<string> = new Set(
  ROLE_FORM_DESCRIPTORS.map((descriptor) => descriptor.familyId),
);

/**
 * GENERIC SIBLING FAMILIES whose members are overwhelmingly the 21's trades (ADR-0045 §6, "added
 * while building").
 *
 * WHY A PIN HERE IS ENOUGH. These are the generic unit families the 21's own families sit beside
 * — `fam_machining` ("kharad aur CNC"), `fam_fitting`, `fam_toolmaking`, `fam_sheet_metal`,
 * `fam_assembly`, `fam_rubber_plastic`, `fam_welding` (a role pack sits beside the family pack,
 * never instead of it). A worker pinned into one of them is almost always a turner, a fitter, a
 * die maker or a moulding hand who phrased it in a way the narrower family's aliases missed.
 * `fam_rubber_plastic` matters most: the 5 polymer roles' own families are never pinned (ADR-0045
 * §6), so this generic family is where those workers land, and without it a moulding operator
 * who said "plastic ka kaam" would be sent down the general road — the false `outside`.
 *
 * TWO MORE, NAMED BY THE ROLE FILES THEMSELVES. `fam_assemblers_other` ("Assembly Work", ISCO
 * minor 821) is the generic pack `assembly-line-worker.role.ts` says that role sits beside, exactly
 * as it does `fam_assembly`. `fam_machinery_repair` ("Machinery Repair", minor 723) is the generic
 * pack `maintenance-technician.role.ts` sits beside, with `fam_fitting`. Minor 723's vehicle
 * mechanics are NOT in it: unit 7231 binds `fam_auto_mechanic`, which stays outside.
 *
 * WHAT IS DELIBERATELY NOT HERE. `fam_electrical`, `fam_electrical_equipment` and `fam_painting`
 * are the domestic electrician and the house painter, and an earlier ruling puts both outside the
 * 21 (ruling A2 for the electrician; `painter-coating.role.ts` for the painter). Adding them
 * would keep exactly the workers the general road is for off it.
 */
export const ADJACENT_FAMILY_IDS: ReadonlySet<string> = new Set([
  "fam_machining",
  "fam_fitting",
  "fam_toolmaking",
  "fam_sheet_metal",
  "fam_assembly",
  "fam_assemblers_other",
  "fam_machinery_repair",
  "fam_rubber_plastic",
  "fam_welding",
]);

/**
 * LEVEL RUNGS THAT AN OWNER RULING PLACES OUTSIDE THE 21 WHEN THEY STAND ALONE — the one
 * exception to "level words are not evidence".
 *
 * WHY THE EXCEPTION EXISTS. These words are on a declared role's ladder only as a RUNG, and
 * they were put there as rungs precisely because the bare word belongs to another trade:
 *
 *   electrician, wireman   `industrial-electrician.role.ts`: the bare word "stays on the domestic
 *                           wireman (7411, `fam_electrical`)" — owner ruling A2. The industrial
 *                           role claims only its qualifiers ("industrial", "panel", "plant").
 *   painter                `painter-coating.role.ts`: "a man who types only 'painter' is more
 *                           likely to be a building painter", and `fam_painting` is his family.
 *
 * Stripping them as rungs would read "Electrician" as `unknown` and keep a domestic electrician
 * off the road the ruling built for him. The industrial and powder-coating workers are still
 * `declared` on their own evidence — an occupation term ("industrial electrician", "powder
 * coating") or a pin to their family — because that check runs before this list is consulted.
 *
 * NOT EXTENDED TO OTHER SHARED RUNGS. "fitter", "draughtsman", "programmer", "inspector" and
 * "technician" are shared too, but no ruling says their bare form lives outside — "fitter" is
 * one of the highest-volume ITI trades and most of the men who say it ARE the 21's fitter. They
 * stay stripped, so bare they are `unknown` and qualified they are decided by the qualifier
 * ("pipe fitter" and "AC technician" are `outside`, as their own role files already rule).
 */
export const OUTSIDE_RULED_RUNGS: readonly string[] = prepareTerms([
  "electrician",
  "इलेक्ट्रीशियन",
  "wireman",
  "painter",
  "पेंटर",
]);

/**
 * PLACE WORDS THAT TAKE A RULED RUNG OUT OF "STANDS ALONE" — a ruled rung next to one of these is
 * `unknown`, not `outside`.
 *
 * WHY. The exemption above is for the BARE word: `industrial-electrician.role.ts` rules that the
 * industrial qualifier ("industrial", "plant") is exactly what makes an electrician one of the 21.
 * But these words are also {@link NOT_EVIDENCE_WORDS}, and the occupation terms match only one
 * word order — so "Electrician industrial", "Electrician in plant" or "Factory painter" stripped to
 * the bare rung and read `outside`. With a place word anywhere in the role, the rung no longer
 * stands alone, and the honest answer is "not yet known": the classic lane, where Phase A asks.
 *
 * "factory" and "company" carry less than "industrial" does, and are here anyway: the rung beside
 * them is the question, and on the asymmetry a doubt resolves to `unknown`. Every entry is a
 * not-evidence word (the test holds that), so it can never be the part of a role that survives.
 */
export const RULED_RUNG_QUALIFIERS: readonly string[] = prepareTerms([
  "industrial",
  "plant",
  "factory",
  "company",
  "इंडस्ट्रियल",
  "प्लांट",
  "फैक्ट्री",
  "कंपनी",
]);

/**
 * WORDS THAT SAY WHERE, WHO, AT WHAT RANK OR IN WHAT GRAMMAR — never WHAT THE WORK IS.
 *
 * Authored here, and CLOSED. The registry's machine and level terms are the 21's own vocabulary;
 * these are the words every role label is padded with regardless of trade. A label made only of
 * them has not told us a role, so it must be `unknown` rather than `outside`: "CNC operator",
 * "machine operator", "factory worker", "mazdoor", "khraad chalata hoon".
 *
 * GROWING THIS LIST IS THE SAFE DIRECTION — a word added here can only turn an `outside` into an
 * `unknown`, which keeps a worker on today's path. Removing one is the direction that needs a
 * reason. It must never hold one of the 21's occupation terms (the test holds that), though it
 * cannot matter: occupation terms are read before anything is stripped.
 *
 * EVERY LATIN WORD HAS ITS DEVANAGARI TWIN, where the twin is a word people type. The model copies
 * the worker's script into `role_label`, so a word listed in one script only makes the lane depend
 * on the keyboard: "मशीन चलाता हूँ" read `outside` while "machine chalata hoon" read `unknown`.
 * The one twin that cannot be here is "प्रेस" — it is the press operator's own occupation term.
 */
export const NOT_EVIDENCE_WORDS: readonly string[] = prepareTerms([
  // ── WHERE: the shop floor, not the trade on it. "CNC" and "machine" are the words the level
  // ruling names; a CNC shop runs every one of the machining roles, and several outside them.
  "cnc",
  "machine",
  "machines",
  "machinery",
  "plant",
  "factory",
  "industry",
  "industrial",
  "manufacturing",
  "production",
  "workshop",
  "shop floor",
  "line",
  "unit",
  "company",
  "सीएनसी",
  "मशीन",
  "मशीनें",
  "मशीनरी",
  "प्लांट",
  "फैक्ट्री",
  "इंडस्ट्री",
  "इंडस्ट्रियल",
  "मैन्युफैक्चरिंग",
  "प्रोडक्शन",
  "वर्कशॉप",
  "लाइन",
  "यूनिट",
  "कंपनी",
  // ── THE PRESS FAMILY, IN LATIN. `press-operator.role.ts` bans bare "press" from its terms for
  // PRECISION — a printing press, a hydraulic press on a maintenance bench — and so "Press machine
  // operator", "Press helper", "Punching operator" and "Stamping operator" were left with a word
  // that named no role and read `outside`, while the Devanagari "प्रेस" is an occupation term and
  // read `declared`. Not declared here either, because the Latin word really is ambiguous (the
  // ironing "press wala" says it too); `unknown` is the classic lane without claiming the man.
  "press",
  "press shop",
  "punching",
  "stamping",
  "पंचिंग",
  "स्टैम्पिंग",
  // ── A DISCIPLINE, NOT A TRADE. "Mechanical" and "electrical" qualify the maintenance technician,
  // the fitter, the CAD draughtsman and the industrial electrician alike, and "qa" is the quality
  // inspector's other half; beside a stripped rung or machine word ("Mechanical technician", "QA
  // engineer") each was left over and read as the role. A trade beside them still stands:
  // "Electrical contractor" keeps its "contractor".
  "mechanical",
  "electrical",
  "qa",
  "मैकेनिकल",
  "इलेक्ट्रिकल",
  // ── WHO: a worker, not a trade.
  "worker",
  "workers",
  "labour",
  "labor",
  "labourer",
  "laborer",
  "mazdoor",
  "majdoor",
  "karigar",
  "kaarigar",
  "kamgar",
  "mistri",
  "staff",
  "employee",
  "वर्कर",
  "लेबर",
  "मजदूर",
  "मज़दूर",
  "कारीगर",
  "मिस्त्री",
  "स्टाफ",
  "कर्मचारी",
  // ── RANK: a rung on somebody's ladder, whose ladder it does not say. "engineer" is the top rung
  // of three of the 21 ("design engineer", "process engineer", "qc engineer") exactly as
  // "technician" is a rung of two; "software engineer" still keeps its "software".
  "senior",
  "junior",
  "sr",
  "jr",
  "trainee",
  "apprentice",
  "fresher",
  "experienced",
  "unskilled",
  "semi skilled",
  "head",
  "chief",
  "assistant",
  "general",
  "engineer",
  // Where he trained, not which trade: `fitter.role.ts` keeps "iti fitter" out of its terms because
  // "any trade's ITI pass-out" says it. Without this, "I.T.I. fitter" read `unknown` (its letters
  // are dropped) and "ITI fitter" read `outside` — the 21's highest-volume ITI trade.
  "iti",
  "आईटीआई",
  // "सीनियर", "हेल्पर" and "ऑपरेटर" are also on some role's ladder today — listed anyway, so the
  // Devanagari rank words do not stay generic only for as long as a role file happens to list them.
  "सीनियर",
  "जूनियर",
  "ट्रेनी",
  "अप्रेंटिस",
  "फ्रेशर",
  "हेड",
  "असिस्टेंट",
  "जनरल",
  "इंजीनियर",
  "हेल्पर",
  "ऑपरेटर",
  // ── THE JOB ITSELF, as a noun or a verb, with no content.
  "job",
  "jobs",
  "naukri",
  "naukari",
  "kaam",
  "work",
  "working",
  "duty",
  "operating",
  "chalata",
  "chalati",
  "chalate",
  "chalana",
  "जॉब",
  "नौकरी",
  "काम",
  "वर्क",
  "ड्यूटी",
  "चलाता",
  "चलाती",
  "चलाते",
  "चलाना",
  // ── HINGLISH GRAMMAR. A model that copies "khraad par kaam karta hoon" into `role_label` — the
  // router's own test table has that label — has written one trade word and five of these.
  "ka",
  "ki",
  "ke",
  "ko",
  "se",
  "me",
  "mein",
  "main",
  "mai",
  "par",
  "pe",
  "kar",
  "karna",
  "karta",
  "karti",
  "karte",
  "kiya",
  "raha",
  "rahi",
  "rahe",
  "hoon",
  "hu",
  "hun",
  "hai",
  "hain",
  "tha",
  "thi",
  "wala",
  "wali",
  "wale",
  "aur",
  "ya",
  "bhi",
  "का",
  "की",
  "के",
  "को",
  "से",
  "में",
  "मे",
  "मैं",
  "मै",
  "पर",
  "पे",
  "कर",
  "करना",
  "करता",
  "करती",
  "करते",
  "किया",
  "रहा",
  "रही",
  "रहे",
  "हूँ",
  "हूं",
  "है",
  "हैं",
  "था",
  "थी",
  "वाला",
  "वाली",
  "वाले",
  "और",
  "या",
  "भी",
  // ── ENGLISH GRAMMAR. "cum" joins two rungs ("setter cum operator") and names neither.
  "and",
  "or",
  "the",
  "of",
  "in",
  "at",
  "on",
  "for",
  "with",
  "to",
  "as",
  "a",
  "an",
  "i",
  "am",
  "my",
  "is",
  "cum",
]);

/**
 * EVERYTHING THAT IS STRIPPED from the role before asking "is anything left?", longest phrase
 * first.
 *
 * THE 21's MACHINE AND LEVEL TERMS, because §3.1 says they are not evidence either way: "lathe"
 * is two of the 21 and a man who runs one outside them, and "operator" is everybody. Plus the
 * authored {@link NOT_EVIDENCE_WORDS}, minus the {@link OUTSIDE_RULED_RUNGS} exemption.
 *
 * LONGEST PHRASE FIRST, because a phrase is not the sum of its words. "Machine repair" is the
 * maintenance technician's equipment word; strip "machine" first and "repair" is left standing
 * as if it named a trade. The same holds for "mixing mill", "drawing office", "nut runner",
 * "setter cum programmer" — each has a word that is not evidence on its own and a word that
 * would be. Ties break by length, then alphabetically, so the order is a fact of the table and
 * not of import order.
 */
export const STRIPPED_TERMS: readonly string[] = (() => {
  const exempt = new Set(OUTSIDE_RULED_RUNGS);
  const terms = prepareTerms([
    ...ROLE_FORM_DESCRIPTORS.flatMap((descriptor) => [
      ...descriptor.detection.machineTerms,
      ...descriptor.detection.levelTerms,
    ]),
    ...NOT_EVIDENCE_WORDS,
  ]).filter((term) => !exempt.has(term));
  const tokenCount = (term: string): number => term.split(" ").length;
  return Object.freeze(
    terms.sort(
      (a, b) =>
        tokenCount(b) - tokenCount(a) || b.length - a.length || (a < b ? -1 : a > b ? 1 : 0),
    ),
  );
})();

/**
 * Does anything name one of the 21? ANY ONE of four pieces of evidence is enough — see the
 * asymmetry in the header.
 *
 *   (a) an occupation term of any of the 21, or one of {@link SCOPE_DECLARED_TERMS}, anywhere in
 *       domain + role + pin label, in any of its {@link readings};
 *   (b) a pin to one of the 21's own families;
 *   (c) a pin to an adjacent generic family ({@link ADJACENT_FAMILY_IDS});
 *   (d) the live router would route it.
 *
 * (d) IS REDUNDANT BY CONSTRUCTION TODAY, and is here so it stays that way. Every route the
 * router can return is an occupation term of an enabled role (inside (a)) or a corroborated term
 * under that role's own family pin (inside (b)). If the router ever learns a route from anything
 * else, this check keeps the lane in lockstep with the offer: a worker the router would offer a
 * form to is never on the skills lane. It is called WITHOUT `workerText` — that field only ever
 * withholds a route — and its `null` is never read as `outside`: a vetoed, ambiguous or formless
 * trade returns `null` too.
 */
function namesOneOfThe21(input: RoleScopeInput, pinLabel: string | null): boolean {
  const haystack = prepare(`${input.domainLabel ?? ""} ${input.roleLabel ?? ""} ${pinLabel ?? ""}`);
  const named = readings(haystack).some(
    (reading) =>
      containsAny(reading, DECLARED_OCCUPATION_TERMS) || containsAny(reading, SCOPE_DECLARED_TERMS),
  );
  if (named) return true;

  if (input.pinFamilyId !== null) {
    if (DECLARED_FAMILY_IDS.has(input.pinFamilyId)) return true;
    if (ADJACENT_FAMILY_IDS.has(input.pinFamilyId)) return true;
  }

  return (
    routeToTradeForm({
      draft: {
        domain_label: input.domainLabel?.normalize("NFKC") ?? null,
        role_label: input.roleLabel?.normalize("NFKC") ?? null,
        skills: [],
        experiences: [],
      },
      occupationFamilyId: input.pinFamilyId,
      occupationLabel: pinLabel?.normalize("NFKC") ?? null,
    }) !== null
  );
}

/**
 * The role with every non-evidence term removed, as bare text ("" when nothing is left).
 *
 * `role` arrives padded (` a b `), and replacing ` term ` with a single space keeps it padded, so
 * the next term is still matched on whole-token boundaries. The inner loop is what removes a term
 * that appears twice in a row — a single replace consumes the space the second match needs.
 *
 * A LEFTOVER SINGLE LETTER IS NOT A ROLE. It is what is left of a dotted abbreviation in the
 * as-written reading ("c n c"), or a stray initial; no trade is one letter long.
 */
function withoutNonEvidence(role: string): string {
  let rest = role;
  for (const term of STRIPPED_TERMS) {
    const needle = ` ${term} `;
    while (rest.includes(needle)) rest = rest.replace(needle, " ");
  }
  return rest
    .trim()
    .split(" ")
    .filter((token) => !SINGLE_LETTER.test(token))
    .join(" ");
}

/**
 * A ruled rung that does not stand alone: a place word is beside it. See
 * {@link RULED_RUNG_QUALIFIERS}.
 */
function isQualifiedRuledRung(role: string): boolean {
  return containsAny(role, OUTSIDE_RULED_RUNGS) && containsAny(role, RULED_RUNG_QUALIFIERS);
}

/**
 * Is this worker's role one of the 21, outside them, or not known yet? See the header.
 *
 * THE ORDER IS THE RULE. `declared` is decided FIRST, on the unstripped text, because several
 * occupation terms are also level terms — "welder", "mould maker", "tool maker", "process
 * technician" — and stripping first would read a welder as `unknown`. Only then does a missing
 * role make the answer `unknown`: the domain and the pin can prove a worker is one of the 21, but
 * they can never prove one is not, because §3.1 requires that the model captured the role.
 */
export function classifyRoleScope(input: RoleScopeInput): RoleScope {
  const pinLabel = isUniversalPlaceholderLabel(input.pinLabel) ? null : input.pinLabel;
  if (namesOneOfThe21(input, pinLabel)) return "declared";

  // BLANK AFTER PREPARATION, not merely after `trim()`: a label of "—" or "?" carries no more of
  // a role than "   " does, and must not reach the strip as if it did.
  const role = prepare(input.roleLabel);
  if (role.length === 0) return "unknown";

  // The ruled rungs' exemption is for the bare word only. A qualifier the strip would remove
  // leaves the rung looking bare when it was not.
  if (isQualifiedRuledRung(role)) return "unknown";

  // `outside` only when EVERY reading still has a role left — see `readings`.
  return readings(role).some((reading) => withoutNonEvidence(reading).length === 0)
    ? "unknown"
    : "outside";
}
