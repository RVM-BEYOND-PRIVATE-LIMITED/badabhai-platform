import { parseAffirmation } from "@badabhai/profiling-lexicon";

/**
 * THE SKILLS GATE, AND THE CARD THAT FOLLOWS IT (ADR-0045 §3.2–§3.3, rulings R3 and R4).
 *
 * ── WHAT IT IS ───────────────────────────────────────────────────────────────────────────
 *
 * A chat worker whose role is outside the 21 predefined roles is asked for skills — only skills —
 * by a model. That stretch ends at a DETERMINISTIC gate: the certified skills as bullets, then
 * "Kya aur koi skill jodni hai?" with [Haan] [Nahi]. Haan → the skills stage asks for more. Nahi →
 * the chat closes on a card whose button opens the offline general form. This module is the whole
 * of that gate and that card — the copy, the two chips, the one reader — and nothing else: it
 * decides nothing about WHEN the gate is served, how many rounds it gets, or what an `other` reply
 * turns into. Those are the orchestrator's, and they are counted in `profile.skills_gate_answered`.
 *
 * ── WHY THE GATE IS OURS AND NOT THE MODEL'S ─────────────────────────────────────────────
 *
 * The same reason the experience gate is (§3, AI never owns a business decision; `llm-reply-guard`
 * documents the failure): ending the skills stage moves a worker onto a form, and a model-authored
 * twin of the question is a question whose "Nahi" produces nothing structured. So the words are
 * fixed here, the model's own attempts at them are caught by `classifySkillsReply`, and the reply
 * is read by code.
 *
 * ── PURE, INERT, AND TEXT-BLIND IN EVERY SENSE THAT MATTERS ──────────────────────────────
 *
 * No I/O, no clock, no logging. The reader sees a worker's words and returns one of three closed
 * values; it never echoes, stores or logs the words themselves (§3 Privacy First — the event that
 * records a gate answer carries the closed value and a count, never the reply).
 */

/**
 * The gate question, verbatim — the one line a worker reads at the end of every skills round.
 *
 * `llm-reply-guard.ts` holds a MIRROR of this literal (`SKILLS_GATE_QUESTION_MIRROR`), because
 * the guard stays a leaf with no runtime imports; `skills-reply-guard.test.ts` pins the two equal,
 * so a reword here that forgets the mirror fails CI instead of silently weakening the guard.
 */
export const SKILLS_GATE_QUESTION = "Kya aur koi skill jodni hai?";

/** The line above the bullets. No question mark: the bubble's one question is the gate's own. */
const SKILLS_GATE_HEADER = "Aapki skills:";

/** One skill per line. Plain text — the app renders `reply` as plain text, never Markdown. */
const SKILL_BULLET = "• ";

/**
 * The two chips.
 *
 * SHORT LABELS ON PURPOSE. The trade-form offer's chips carry a verb ("Haan, form bharein")
 * because their question names two different destinations. This question is a plain yes/no about
 * the list the worker has just read, and "Haan" / "Nahi" are the words a worker would type anyway —
 * which is also why {@link readSkillsGateReply} matches the labels themselves.
 *
 * KEYS THAT CANNOT COLLIDE with anything a shipped client routes on — the résumé menu's
 * `resume_*` and `section_*` keys trigger client-side navigation, and the trade-form offer's
 * `form_offer_*` keys are answered by the orchestrator's offer branch. A chip sharing one would
 * answer the wrong question. Asserted against those sets in the test.
 */
export const SKILLS_GATE_OPTIONS = Object.freeze([
  Object.freeze({
    option_key: "skills_gate_add",
    label_text: "Haan",
    value: true,
    implies_skill_id: null,
    is_none_of_above: false,
  }),
  Object.freeze({
    option_key: "skills_gate_done",
    label_text: "Nahi",
    value: false,
    implies_skill_id: null,
    is_none_of_above: false,
  }),
]);

/**
 * A skill as it may appear on one bullet line: whitespace (newlines included) collapsed to one
 * space, question marks removed, trimmed.
 *
 * WHY THIS MODULE TOUCHES CERTIFIED TEXT AT ALL. The skills reaching here have already passed two
 * certifiers, so this is not a safety screen — it is the prompt's own shape contract. A newline
 * inside a skill would break "one bullet per line", and a "?" inside one would give the bubble a
 * second question mark, which the persona forbids. Both promises belong to the function that
 * makes them, so both are kept here rather than trusted to every caller.
 */
function bulletText(skill: string): string {
  return skill.replace(/[?？]/gu, "").replace(/\s+/gu, " ").trim();
}

/**
 * The gate bubble: the certified skills as bullets, a blank line, then the question.
 *
 *     Aapki skills:
 *     • Tally
 *     • GST filing
 *
 *     Kya aur koi skill jodni hai?
 *
 * NO SKILLS, NO LIST — the question alone. ADR-0045 §6 sends a stage with zero certified skills
 * straight to the form without a gate, so the caller should never ask for this; if it does, an
 * empty "Aapki skills:" heading would tell the worker we heard nothing, which is worse than just
 * asking. A skill that is empty after {@link bulletText} is dropped for the same reason.
 *
 * ORDER IS THE CALLER'S. Skills are printed in the order given, with no de-duplication: the stage
 * de-duplicates before it stores (§3.2), and a second rule here could only disagree with that one.
 */
export function skillsGatePrompt(skills: readonly string[]): string {
  const bullets = skills.map(bulletText).filter((skill) => skill.length > 0);
  if (bullets.length === 0) return SKILLS_GATE_QUESTION;
  const list = bullets.map((skill) => `${SKILL_BULLET}${skill}`).join("\n");
  return `${SKILLS_GATE_HEADER}\n${list}\n\n${SKILLS_GATE_QUESTION}`;
}

/**
 * What the worker's reply to the gate means.
 *
 *   add    — a yes: ask for more skills.
 *   done   — a no: close the stage and hand over to the general form.
 *   other  — neither. NOT an unclear: the caller hands this text to the skills model as a typed
 *            answer, and decides from THAT result whether it was a skill (`typed`) or nothing
 *            (`unclear`, which ADR-0045 §6 treats as a Nahi, counted apart).
 *
 * `other` rather than `unclear` is the reason this type is not `SkillsGateReply` from
 * `@badabhai/types`: a worker who answers the gate by typing "Tally bhi aata hai" has answered it,
 * and only the skills model can say whether what they typed is a skill.
 */
export type SkillsGateRead = "add" | "done" | "other";

/**
 * Whole-message normalisation for the stop set: NFKC, lowercase, apostrophes deleted (so
 * "that's all" and "thats all" are one entry), every other non-letter/mark/digit run to one space.
 *
 * `\p{M}` STAYS IN THE KEEP SET — the bug `llm-reply-guard.ts` and `trade-form-router.ts` both
 * document: a Devanagari matra or anusvara is category `M`, and blanking it splits "नहीं" into
 * pieces that match nothing. Entries go through this same function, so a nukta written precomposed
 * in one place and decomposed in another still compares equal.
 */
function normaliseStop(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’‘`ʼ]/gu, "")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

/**
 * THE WHOLE-MESSAGE STOPS — replies that can only mean "no more skills".
 *
 * WHY A SECOND LIST EXISTS BESIDE THE LEXICON. `parseAffirmation` is the platform's one yes/no
 * reader and {@link readSkillsGateReply} still defers to it, but it has no word for the most
 * common way a Hindi speaker ends a list: "bas" ("that's it") is not in
 * `packages/profiling-lexicon/data` at all, and nor are "itna hi", "yahi", "khatam", "ho gaya",
 * "done" or "that's all". Every one of those, typed at this gate, would otherwise fall through to
 * `other` and cost a model call to learn that the worker said they were finished. Adding "bas" to
 * the lexicon is not the fix: `negation.json` uses it as a CLAUSE SPLITTER ("setting nahi aati,
 * bas chalata hoon"), and a yes/no cue with that spelling would read in every boolean pack answer.
 *
 * WHOLE MESSAGE, NEVER A SUBSTRING — the property this set exists to have. "excel nahi aata" is a
 * worker telling us about a skill, not ending the list; "bas welding" is a skill with a filler
 * word. Membership of the normalised whole reply is the only test, so a skill sentence can never be
 * read as a stop because it happens to contain "nahi" or "bas".
 *
 * CLOSED. A phrase belongs here only if, as the WHOLE reply to "Kya aur koi skill jodni hai?", it
 * cannot mean anything but no. A reply that misses the set is not lost — it reaches the lexicon
 * next, then the model.
 *
 * THE "KOI NAHI" FAMILY IS THE QUESTION'S OWN NEGATION. The gate asks "aur KOI skill", so "aur koi
 * nahi" / "koi nahi" is the most literal no there is — and before the review that added it, each
 * one cost a skills-model call and was recorded in `profile.skills_gate_answered` as `unclear`
 * instead of `done`. The spelling variants beside it ("bs", "hogaya", "that's it") are the same
 * words as typed on a phone keyboard.
 */
const SKILLS_STOP_UTTERANCES: ReadonlySet<string> = new Set(
  [
    // "that's it / only this"
    "bas",
    "bs",
    "bas bas",
    "bas bhai",
    "bas itna",
    "bas itna hi",
    "bas itna hi hai",
    "bas itni",
    "bas itni hi",
    "bas yahi",
    "bas yahi hai",
    "bas yehi",
    "bas ji",
    "itna hi",
    "itna hi hai",
    "itna hi tha",
    "itni hi",
    "sirf itna",
    "sirf itna hi",
    "yahi",
    "yahi hai",
    "yahi tha",
    "yahi sab",
    "yahi sab hai",
    "thats it",
    "enough",
    // "no / nothing more" — the "koi nahi" family is the literal negation of the question
    "koi nahi",
    "aur koi nahi",
    "koi aur nahi",
    "koi skill nahi",
    "aur koi skill nahi",
    "kuch aur nahi",
    "nothing more",
    "nahi",
    "nahin",
    "nhi",
    "nai",
    "na",
    "no",
    "nope",
    "nahi ji",
    "ji nahi",
    "kuch nahi",
    "kuch nahin",
    "kuch nhi",
    "kuch nahi hai",
    "aur nahi",
    "aur nahi hai",
    "aur kuch nahi",
    "aur kuch nahin",
    "aur kuch nhi",
    "aur kuch nahi hai",
    "nothing",
    "nothing else",
    "no more",
    "thats all",
    // "finished"
    "done",
    "finished",
    "khatam",
    "ho gaya",
    "ho gya",
    "hogaya",
    "hogya",
    "bas ho gaya",
    "bas ho gya",
    "bas hogaya",
    "ho gya bas",
    "sab ho gaya",
    // Devanagari
    "बस",
    "बस इतना",
    "बस इतना ही",
    "बस यही",
    "इतना ही",
    "यही",
    "नहीं",
    "नही",
    "नहीं जी",
    "जी नहीं",
    "कुछ नहीं",
    "कुछ नही",
    "कोई नहीं",
    "और नहीं",
    "और कुछ नहीं",
    "और कुछ नही",
    "और कोई नहीं",
    "हो गया",
    "खत्म",
  ].map(normaliseStop),
);

/**
 * The longest stop, in words — so a scan that asks "is the REST of this reply a stop?" at every
 * position can skip the join for a rest that is already too long to be one. Computed, never
 * hand-kept: a longer entry added above must not silently stop matching.
 */
const SKILLS_STOP_LONGEST = longestEntry(SKILLS_STOP_UTTERANCES);

/**
 * Is the WHOLE reply one of the closed "no more skills" utterances? See
 * {@link SKILLS_STOP_UTTERANCES} for why this is a set and never a substring scan.
 */
export function isSkillsStop(text: string): boolean {
  const normalised = normaliseStop(text);
  return normalised.length > 0 && SKILLS_STOP_UTTERANCES.has(normalised);
}

/**
 * THE WHOLE-MESSAGE YESES — replies that can only mean "yes, there is another skill".
 *
 * WHY THE LEXICON IS NOT ENOUGH ON THIS SIDE EITHER. `parseAffirmation` leaves out bare "ha" on
 * purpose (`affirmation.json`: one edit from the copula "hai", so it would fire inside sentences
 * that are not answers). As the WHOLE reply that risk is gone — "ha" alone answers nothing but the
 * question on screen, and it is how a phone keyboard spells haan. Worse, "ha ji" / "ha bhai" DO
 * reach a lexicon cue — "ji" / "bhai" at index 3 — which {@link cueLeadsReply} rightly refuses, so
 * they fell to `other`: the skills model found no skill in them, ADR-0045 §6 reads that `unclear`
 * as a Nahi, and a worker who said YES was handed the form with the stage closed — the costly
 * error this module is built to avoid.
 *
 * THE GATE'S OWN WORDS BELONG HERE TOO. "jodni hai" echoes the question's verb, "aur hai" / "ek
 * aur" / "one more" answer it directly, and "add" is the English word a worker reaches for. None of
 * them names a skill, so the skills model could only have returned `unclear` for them — the same
 * wrong Nahi.
 *
 * WHOLE MESSAGE, NEVER A SUBSTRING, CLOSED — the stop set's three properties, for its reasons: "aur
 * hai" inside "tally aur excel hai" is a list of skills, not a yes. DISJOINT from the stop set
 * (the test walks every entry here through `isSkillsStop`), so the order of the two checks decides
 * nothing.
 */
const SKILLS_YES_UTTERANCES: ReadonlySet<string> = new Set(
  [
    // yes, as typed on a phone keyboard — the lexicon's "ha" gap
    "ha",
    "haa",
    "ha ji",
    "ha jee",
    "han ji",
    "ha bhai",
    "ha sir",
    "hn",
    "hnji",
    "हा",
    "हाँ जी",
    "हा जी",
    // "there is one more" — the question answered in its own terms
    "aur",
    "aur hai",
    "ek aur",
    "ha aur hai",
    "haan aur hai",
    "jodni hai",
    "jodna hai",
    "jodni h",
    "more",
    "add",
    "add karo",
    "add more",
    "one more",
    "और है",
    "जोड़नी है",
  ].map(normaliseStop),
);

/**
 * Is the WHOLE reply one of the closed "yes, one more" utterances? See
 * {@link SKILLS_YES_UTTERANCES}; the same whole-message contract as {@link isSkillsStop}.
 */
export function isSkillsYes(text: string): boolean {
  const normalised = normaliseStop(text);
  return normalised.length > 0 && SKILLS_YES_UTTERANCES.has(normalised);
}

/** A normalised string's words. "" has none — `"".split(" ")` would claim one empty word. */
function words(normalised: string): string[] {
  return normalised.length > 0 ? normalised.split(" ") : [];
}

/** The most words any entry of a closed phrase set has. */
function longestEntry(set: ReadonlySet<string>): number {
  let longest = 0;
  for (const entry of set) longest = Math.max(longest, words(entry).length);
  return longest;
}

/**
 * A closed set of short phrases matched word-by-word at a position — the unit the opener reader
 * below is built from. `longest` is computed from the entries so a two-word entry ("theek hai",
 * "thank you") is tried before its first word alone.
 */
interface OpenerPhrases {
  readonly entries: ReadonlySet<string>;
  readonly longest: number;
}

function openerPhrases(entries: readonly string[]): OpenerPhrases {
  const set: ReadonlySet<string> = new Set(entries.map(normaliseStop));
  return Object.freeze({ entries: set, longest: longestEntry(set) });
}

/** How many words of `phrases` begin at `toks[at]` — the longest entry that fits, else 0. */
function phraseAt(toks: readonly string[], at: number, phrases: OpenerPhrases): number {
  for (let n = Math.min(phrases.longest, toks.length - at); n >= 1; n--) {
    if (phrases.entries.has(toks.slice(at, at + n).join(" "))) return n;
  }
  return 0;
}

/**
 * THE LEADING YES — an acknowledgement a worker puts IN FRONT of their real answer: "haan, bas itna
 * hi", "ok thats all", "ji bas", "theek hai bas itna hi".
 *
 * WHY IT IS READ BEFORE THE LEXICON. The lexicon's cue for these is the leading yes, and its
 * verdict is `add` — so "ji bas" (a no) read `add` while "bas ji" (the same words) read `done`. A
 * yes-word that opens a reply is manners, not the answer, when what follows it is a whole stop.
 *
 * CLOSED, AND DELIBERATELY ONLY THE PLAIN YES / OK / JI FAMILY — the lexicon's explicit cues, plus
 * the keyboard spellings {@link SKILLS_YES_UTTERANCES} adds. Never a verb claim ("karta hoon bas"
 * says the worker does something; whether that ends the list is the model's to read).
 */
const LEADING_ACKS = openerPhrases([
  "haan",
  "han",
  "haa",
  "ha",
  "hn",
  "hnji",
  "hanji",
  "haanji",
  "ji",
  "jee",
  "ok",
  "okay",
  "okey",
  "okk",
  "yes",
  "yeah",
  "yep",
  "yup",
  "sure",
  "theek",
  "thik",
  "theek hai",
  "thik hai",
  "acha",
  "accha",
  "achha",
  "sahi",
  "sahi hai",
  "bilkul",
  "bilkool",
  "हाँ",
  "हां",
  "हा",
  "जी",
  "हाँजी",
  "हांजी",
  "ठीक",
  "ठीक है",
  "अच्छा",
  "सही",
  "बिल्कुल",
  "ओके",
]);

/**
 * Words that may follow a leading yes without changing it — "haan bhai, bas", "ok sir itna hi".
 * Only AFTER a yes: a reply that opens with "bhai" has not acknowledged anything.
 */
const ACK_HONORIFICS = openerPhrases(["bhai", "sir", "madam", "yaar", "भाई", "सर", "यार"]);

/**
 * THE LEADING NO — the negations that can open a reply: the stop set's own bare no-words, in both
 * scripts. One word each; repeated ("nahi nahi") they are still one no.
 */
const LEADING_NEGATIONS = openerPhrases([
  "nahi",
  "nahin",
  "nahee",
  "nahii",
  "nhi",
  "nai",
  "na",
  "no",
  "nope",
  "नहीं",
  "नही",
  "नहि",
  "ना",
  "न",
]);

/**
 * "na" AFTER A YES IS A TAG, NOT A NO. "haan na" is an emphatic yes ("of course"), and the lexicon
 * — whose negation engine demotes these to tag-only negators for exactly this reason — reads it
 * `add`. Only at the head of a reply is "na" a no.
 */
const TAG_PARTICLES: ReadonlySet<string> = new Set(["na", "ना", "न"].map(normaliseStop));

/**
 * What may follow a leading no and still leave it a plain no: "nahi bas", "nahi ji", "nahi
 * chahiye", "no thank you". CLOSED, and only these — every word a worker adds after "nahi" that is
 * not one of them is a word the skills model must see, because it may be the skill.
 */
const NEGATION_FILLERS = openerPhrases([
  "bas",
  "itna",
  "hi",
  "ji",
  "bhai",
  "sir",
  "yaar",
  "chahiye",
  "thanks",
  "thank you",
  "shukriya",
  "बस",
  "इतना",
  "ही",
  "जी",
  "भाई",
  "सर",
  "यार",
  "चाहिए",
  "शुक्रिया",
  "धन्यवाद",
]);

/**
 * Are the words from `at` to the end a whole stop ({@link SKILLS_STOP_UTTERANCES})? The length is
 * checked before the join, so asking this at every position of a long reply stays linear.
 */
function isStopFrom(toks: readonly string[], at: number): boolean {
  const remaining = toks.length - at;
  return (
    remaining > 0 &&
    remaining <= SKILLS_STOP_LONGEST &&
    SKILLS_STOP_UTTERANCES.has(toks.slice(at).join(" "))
  );
}

/**
 * Does what follows a leading no add nothing to it — only fillers, or fillers and then a whole stop
 * ("nahi, bas itna hi hai", "nahi ji, aur kuch nahi")? One unlisted word anywhere and the answer is
 * no: that word may be a skill, and only the skills model can say.
 */
function addsNothing(toks: readonly string[], from: number): boolean {
  let at = from;
  while (at < toks.length) {
    if (isStopFrom(toks, at)) return true;
    const filler = phraseAt(toks, at, NEGATION_FILLERS);
    if (filler === 0) return false;
    at += filler;
  }
  return true;
}

/**
 * What the reply's OPENING — a yes, a no, or a yes then a no — says, or `null` when it opens with
 * neither and the lexicon should read it.
 *
 *   yes… no, then nothing new  → `done`   ("nahi", "nahi bas", "haan nahi", "ji nahi, thank you")
 *   yes… no, then anything     → `other`  ("nahi, excel bhi", "no wait excel bhi", "nahi ek aur hai")
 *   yes…, then a whole stop    → `done`   ("haan bas itna hi", "ok thats all", "ji bas")
 *   anything else              → `null`
 *
 * WHY A NO FOLLOWED BY MORE IS `other` AND NOT `done`. "nahi, excel bhi" is "no wait — Excel too":
 * a correction, and the skill after it is the point. Read as `done` it closed the stage and the
 * skill was never stored — the costly error. Before this, which way such a reply went depended on
 * where the lexicon happened to find its cue ("nahi, tally bhi aata hai" reached a later verb cue
 * and survived; "nahi, excel bhi" had none and was dropped), which is not a rule. `other` hands the
 * whole reply to the skills model: it stores the skill if there is one, and reads `unclear` — a Nahi
 * under §6 — if there is not, so a plain no that took an unexpected shape costs one model call.
 *
 * Every step consumes at least one word, so the scan is linear in the reply.
 */
function readOpener(text: string): "done" | "other" | null {
  const toks = words(normaliseStop(text));

  let afterAcks = 0;
  for (;;) {
    const ack = phraseAt(toks, afterAcks, LEADING_ACKS);
    const step = ack > 0 ? ack : afterAcks > 0 ? phraseAt(toks, afterAcks, ACK_HONORIFICS) : 0;
    if (step === 0) break;
    afterAcks += step;
  }

  let afterNegations = afterAcks;
  for (;;) {
    const word = toks[afterNegations];
    if (word === undefined || (afterAcks > 0 && TAG_PARTICLES.has(word))) break;
    const negation = phraseAt(toks, afterNegations, LEADING_NEGATIONS);
    if (negation === 0) break;
    afterNegations += negation;
  }

  if (afterNegations > afterAcks) return addsNothing(toks, afterNegations) ? "done" : "other";

  const next = toks[afterAcks];
  if (afterAcks > 0 && next !== undefined && !TAG_PARTICLES.has(next)) {
    if (isStopFrom(toks, afterAcks)) return "done";
  }
  return null;
}

/**
 * Does the lexicon's yes/no cue OPEN the reply — nothing but spaces and punctuation before it?
 *
 * WHY THE LEXICON'S VERDICT NEEDS THIS AND THE TRADE-FORM OFFER'S DOES NOT. `parseAffirmation`
 * reads a yes or a no ANYWHERE in a sentence, including a first-person verb claim ("karta hoon",
 * "aata hai") and a negated one. That is right for a boolean pack question, where the sentence is
 * about the thing asked. At this gate the most likely sentence is a worker naming a skill, and the
 * lexicon reads those as answers to the wrong question — measured against the shipped parser:
 *
 *   "excel nahi aata"         → false (a negated verb claim)       — would close the stage
 *   "tally aata hai"          → true  (a verb claim)               — would drop the skill
 *   "welding bhi karta hoon"  → true                               — would drop the skill
 *
 * A cue that OPENS the reply is an answer to the gate ("haan", "haan photoshop bhi", "nahi,
 * bas", "हाँ"); a cue later in it belongs to a sentence about a skill, and the skills model is the
 * right reader for that sentence. The lexicon stays the one arbiter of WHAT counts as a yes or a
 * no; this only decides whether its cue is answering THIS question.
 */
function cueLeadsReply(text: string, cueStart: number): boolean {
  return !/[\p{L}\p{N}]/u.test(text.slice(0, cueStart));
}

/**
 * What the worker's reply to the gate means.
 *
 * ORDER, first match wins:
 *   1. a chip key, exactly;
 *   2. a chip label, case-insensitive and trimmed ("haan", "HAAN", "Nahi");
 *   3. a whole-message stop ({@link isSkillsStop}) → `done`;
 *   4. a whole-message yes ({@link isSkillsYes}) → `add` — disjoint from 3, so 3 and 4 commute;
 *   5. the reply's opening ({@link readOpener}): a leading no → `done` when nothing new follows it
 *      and `other` when something does; a leading yes followed by a whole stop → `done`;
 *   6. the lexicon's yes/no, when its cue OPENS the reply ({@link cueLeadsReply}) → `add` / `done`;
 *   7. otherwise `other` — including "" and a bare skill ("photoshop").
 *
 * THE LEAN IS TOWARD `add`, AND THAT IS THE SAFE DIRECTION HERE, the reverse of the résumé-update
 * offer. A wrong `add` costs the worker one more question, which they can end with "bas". A wrong
 * `done` closes the only stretch of the interview that asks for skills. So the lexicon's generous
 * yes ("theek hai", "ok") is taken as it is, and a no is `done` only when it is ALL the worker said.
 *
 * "haan photoshop bhi" IS `add`, not `other`: the worker said yes first. What the caller does with
 * the words after the yes is the caller's decision — this reader returns a closed value only.
 */
export function readSkillsGateReply(text: string): SkillsGateRead {
  const trimmed = text.trim();

  const byKey = SKILLS_GATE_OPTIONS.find((option) => option.option_key === trimmed);
  if (byKey) return byKey.value ? "add" : "done";

  // Today both labels are also read by steps 3 and 6 ("Nahi" is a stop, "Haan" a lexicon yes), so this
  // step changes no outcome yet. It is what keeps a tapped label readable on an old client the
  // day a label is reworded into something neither of those knows.
  const lowered = trimmed.toLowerCase();
  const byLabel = SKILLS_GATE_OPTIONS.find((option) => option.label_text.toLowerCase() === lowered);
  if (byLabel) return byLabel.value ? "add" : "done";

  if (isSkillsStop(trimmed)) return "done";
  if (isSkillsYes(trimmed)) return "add";

  const opener = readOpener(trimmed);
  if (opener !== null) return opener;

  const parsed = parseAffirmation(trimmed);
  if (parsed !== null && cueLeadsReply(trimmed, parsed.span.start)) {
    return parsed.value ? "add" : "done";
  }
  return "other";
}

/**
 * The card the chat closes on when the worker says Nahi at the gate (ADR-0045 §3.3). Mapped onto
 * the wire's `general_form_offer: { headline, cta_label }` by the caller; `reply` is the chat
 * bubble and the TTS line, for a client that draws no card.
 */
export interface GeneralFormOffer {
  readonly headline: string;
  readonly ctaLabel: string;
  readonly reply: string;
}

/**
 * THE SAME BUTTON LABEL AS EVERY TRADE FORM'S — a duplicate, deliberately, of
 * `trade-form-router.ts`'s private `FORM_CTA_LABEL`.
 *
 * The same words because it is the same act: fill a form, finish the résumé. A worker who has seen
 * one card should recognise the other. Duplicated rather than imported because that constant is
 * private to its module and exporting it is outside this change; `skills-gate.test.ts` asserts
 * this literal equals `TRADE_FORM_OFFERS[kind].ctaLabel` for every kind, so the two cannot drift
 * apart without a red test.
 */
const GENERAL_FORM_CTA_LABEL = "Form bharkar resume pura karein";

/**
 * What we tell the worker we have done. NOT "profile detected", which the trade cards say: a
 * general-road worker's trade was not recognised as one of ours, and claiming it was would be
 * untrue. What IS true at this point is that their skills are written down.
 */
const GENERAL_FORM_HEADLINE = "Skills note ho gayi";

/**
 * The card. `reply` has exactly the shape of `TRADE_FORM_OFFERS[kind].reply` —
 * `${headline}. Ab ${ctaLabel.toLowerCase()}.` — so the bubble a card-less client shows reads
 * like the trade road's.
 */
export const GENERAL_FORM_OFFER: GeneralFormOffer = Object.freeze({
  headline: GENERAL_FORM_HEADLINE,
  ctaLabel: GENERAL_FORM_CTA_LABEL,
  reply: `${GENERAL_FORM_HEADLINE}. Ab ${GENERAL_FORM_CTA_LABEL.toLowerCase()}.`,
} satisfies GeneralFormOffer);

/**
 * Narrow an untrusted (Redis-round-tripped) value back to the card.
 *
 * REBUILT FROM THE CONSTANT, NEVER READ OFF THE STORED OBJECT — `narrowTradeFormOffer`'s posture:
 * the copy is ours, not the session's, and replaying a headline a since-retired build wrote would
 * put words on screen that no longer exist anywhere in the source. There is only one card, so the
 * only fact that survives the round trip is that one was offered — any non-null object.
 */
export function narrowGeneralFormOffer(value: unknown): GeneralFormOffer | null {
  if (typeof value !== "object" || value === null) return null;
  // TWO CARDS NOW (the no-skills one below), so the stored HEADLINE picks which constant is
  // rebuilt — never the stored copy itself. Anything else is the default card.
  const headline = (value as { headline?: unknown }).headline;
  return headline === GENERAL_FORM_HEADLINE_NO_SKILLS
    ? GENERAL_FORM_OFFER_NO_SKILLS
    : GENERAL_FORM_OFFER;
}

/**
 * The card for a handover with NO certified skills (ADR-0045 review, Phase 2b).
 *
 * "Skills note ho gayi" is a CLAIM, and on the `no_skills` / zero-skill `unavailable` /
 * `turn_cap` paths it is false — the worker would read that their skills were saved when none
 * were, and the general form never asks for skills again. Same CTA, a headline that claims
 * nothing.
 */
const GENERAL_FORM_HEADLINE_NO_SKILLS = "Baaki jaankari form mein";

export const GENERAL_FORM_OFFER_NO_SKILLS: GeneralFormOffer = Object.freeze({
  headline: GENERAL_FORM_HEADLINE_NO_SKILLS,
  ctaLabel: GENERAL_FORM_CTA_LABEL,
  reply: `${GENERAL_FORM_HEADLINE_NO_SKILLS}. Ab ${GENERAL_FORM_CTA_LABEL.toLowerCase()}.`,
} satisfies GeneralFormOffer);

/** The card whose headline is TRUE for this many certified skills. */
export function generalFormOfferFor(skillsCount: number): GeneralFormOffer {
  return skillsCount > 0 ? GENERAL_FORM_OFFER : GENERAL_FORM_OFFER_NO_SKILLS;
}

/**
 * The ENGINE's own follow-up to a "Haan" at the gate, served when the model's reply cannot be:
 * a repeat of the line the skills prompt itself tells it to ask, a gate-shaped question, or one
 * off the skills topic. Deterministic, like the gate — a worker who said "yes, I want to add
 * more" is asked WHICH skill, never shown the same locked gate again.
 */
export const SKILLS_ADD_PROMPT = "Kaunsi skill jodni hai?";

/**
 * Bare negations — a stop at the GATE ("Kya aur koi skill jodni hai?" → "nahi" is a no), but NOT
 * mid-stage, where the question on screen is an open per-area one ("Kaunse database use karte
 * hain?"): there "nahi" means "none in THIS area", and the skills prompt tells the model to move
 * on to the next area. Ending the whole stage on it would cut a worker off after one empty area.
 */
const BARE_NEGATIONS: ReadonlySet<string> = new Set(
  [
    "nahi",
    "nahin",
    "nhi",
    "nai",
    "na",
    "no",
    "nope",
    "ji nahi",
    "koi nahi",
    "kuch nahi",
    "kuch nhi",
    "नहीं",
    "नही",
    "कोई नहीं",
    "कुछ नहीं",
  ].map(normaliseStop),
);

/**
 * A MID-STAGE stop: {@link isSkillsStop} minus the bare negations. Only an unambiguous
 * list-ender ("bas", "itna hi", "aur kuch nahi", "that's all") ends the stage without a model
 * call; a bare "nahi" goes to the model, which reads it as an empty area.
 */
export function isSkillsStageStop(text: string): boolean {
  return isSkillsStop(text) && !BARE_NEGATIONS.has(normaliseStop(text));
}
