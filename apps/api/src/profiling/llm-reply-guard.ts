/**
 * ═══ IS THE MODEL'S NEXT LINE SAFE TO SERVE? ═══ (#1505 F5)
 *
 * The model that leads Phase A (`llm-turn.service.ts`) writes `reply_text` freely, and two
 * failure shapes reach a worker if nothing on this side reads it first:
 *
 *  - IT WRITES THE ENGINE'S OWN GATE, in its own words ("koi aur naukri hai?"). §3 says the gate
 *    is OURS, not the model's — the engine's copy is the one line `question-tts-text.ts` and the
 *    voice form can pre-render, and a model-authored twin means a worker who then taps "Nahi" has
 *    answered a question that produced no structured `experience_entry`, no gate gate re-serve,
 *    nothing: the reply is just discarded by `llm-turn.service.ts`'s own docblock warning.
 *  - IT REPEATS ITSELF, or repeats a question from earlier in the same interview. The platform's
 *    standing "AI repeats" ruling is "move on, no retry" for ANY repeated question, not only the
 *    gate — a model that re-asks a pre-gate skills question after job 1's gate is the same defect
 *    with the repeat further back in the transcript.
 *
 * `classifyLlmReply` is the READ; `llm-turn.service.ts`'s final ask branch is the ENFORCEMENT —
 * on `'gate_shaped'` or `'repeat'` it discards the model's line and falls back to the engine's own
 * gate or a close, per the "move on, no retry" ruling: NO SECOND MODEL CALL, ever. Retrying would
 * spend a worker's round trip finding out the model does the same thing twice in a row.
 *
 * COUNTS ONLY, NEVER TEXT, when this fires — §3 Privacy First: a reason code and the turn's
 * position, nothing the model or the worker actually said.
 */

import type { TranscriptLine } from "@badabhai/ai-contracts";

export type LlmReplyClass = "ok" | "gate_shaped" | "repeat";

/**
 * The engine's own experience-gate line, verbatim, exported from HERE (not `llm-turn.service.ts`,
 * which re-exports it for its existing importers) because {@link repeatsHistory} is now a second
 * reader: the STRUCTURAL job-boundary signal below needs the one line the engine appends to every
 * transcript exactly once per job, and a second hand-copied literal would drift from the string
 * that is actually served the moment either side changed its wording.
 */
export const EXPERIENCE_GATE_PROMPT = "Aur koi experience jodna hai?";

/**
 * "aur koi", "koi aur", "koi dusra/doosra", "dusri/doosri", "ek aur", "another", and the
 * Devanagari equivalents — the ADD marker that opens the engine's own gate question.
 */
const ADD_MARKER_TOKENS: ReadonlySet<string> = new Set([
  "aur",
  "koi",
  "dusra",
  "dusre",
  "dusri",
  "doosra",
  "doosre",
  "doosri",
  "another",
  "और",
  "कोई",
  "दूसरी",
  "दूसरा",
  "दूसरे",
]);

/** A JOB noun — the thing the ADD marker must be adding ANOTHER of to be gate-shaped. */
const JOB_NOUN_TOKENS: ReadonlySet<string> = new Set([
  "kaam",
  "job",
  "jobs",
  "naukri",
  "naukari",
  "naukriyan",
  "experience",
  "anubhav",
  "tajurba",
  "tajarba",
  "company",
  "factory",
  "काम",
  "नौकरी",
  "अनुभव",
  "तजुर्बा",
  "कंपनी",
  "फैक्ट्री",
]);

/**
 * Leading WH-tokens that mark an ordinary information question ("kaunsa kaam", "kitne saal") —
 * NOT a yes/no gate-shaped ask. "kya" is explicitly excepted: "kya aapke paas koi aur kaam hai?"
 * is the yes/no shape the gate itself uses, and would otherwise be misread as an information
 * question because "kya" doubles as both Hindi's "what" and its yes/no opener.
 */
const LEADING_WH_TOKENS: ReadonlySet<string> = new Set([
  "kaunsa",
  "kaunsi",
  "kaunse",
  "kaisa",
  "kaisi",
  "kaise",
  "kitna",
  "kitne",
  "kitni",
  "kahan",
  "kab",
  "kyun",
  "kyu",
  "kaun",
]);

/** Lines that ask a PER-JOB experience question — the one shape allowed to legitimately repeat. */
const PER_JOB_QUESTION_PATTERN =
  /\b(kitn[ae]\s+saal|kitn[ae]\s+(?:mahine|mahina)|kya\s+kaam|kaunsa\s+kaam|kis\s+company|kis\s+factory)\b/i;

/**
 * NFKC-normalize, lowercase, and blank everything but letters/digits — never `\b` on this text.
 *
 * `\p{M}` (combining marks) STAYS IN THE KEEP SET alongside `\p{L}`/`\p{N}`, not just out of the
 * blank set: a Devanagari matra like "ौ" (U+094C, inside "और") is category `Mn`, and blanking it
 * would split one word into two ("अ" + "र") and break every Devanagari token match in this file
 * (`duration-months.ts` hit the identical bug — see its `tokenize`).
 */
function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokens(normalized: string): string[] {
  return normalized.length > 0 ? normalized.split(" ") : [];
}

/**
 * Is `reply` shaped like the engine's own "Aur koi experience jodna hai?" — an ADD marker
 * followed, within three tokens, by a JOB noun, with no leading information-question WH-token?
 */
function isGateShaped(reply: string): boolean {
  const normalized = normalize(reply);
  const toks = tokens(normalized);
  if (toks.length === 0) return false;

  const first = toks[0] as string;
  if (LEADING_WH_TOKENS.has(first) && first !== "kya") return false;

  for (let i = 0; i < toks.length; i++) {
    if (!ADD_MARKER_TOKENS.has(toks[i] as string)) continue;
    const window = toks.slice(i + 1, i + 1 + 3);
    if (window.some((t) => JOB_NOUN_TOKENS.has(t))) return true;
  }
  return false;
}

/** Token-set Jaccard similarity. */
function jaccard(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter((t) => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Does `reply` repeat a prior MODEL (`assistant`) line in `history`?
 *
 * COMPARED AGAINST THE FULL HISTORY BY DEFAULT (critique-5's major finding) — not scoped to
 * "since the last gate prompt". Scoping there produced false negatives for the model re-asking a
 * PRE-gate question (domain/role/skills) after the gate: the "AI repeats" ruling is "move on, no
 * retry" for ANY repeated question, and a pre-gate skills question repeated after job 1's gate is
 * exactly that failure with the repeat further back in the transcript. See the exact-repeat skills
 * fixture in `llm-reply-guard.test.ts`: it crosses a job boundary too and STAYS flagged, because
 * the widened exemption below never reaches an exact match — see why there.
 *
 * TWO EXEMPTIONS, both narrowed to the `similar` (near-duplicate, non-exact) match only:
 *
 *  1. THE NARROW KEYWORD ONE (unchanged): both lines match {@link PER_JOB_QUESTION_PATTERN} —
 *     duration/trade-role/employer-name phrasing, which this file has always recognized.
 *  2. THE WIDENED STRUCTURAL ONE (#1517 review, MAJOR 2): a job gate — the engine's own
 *     {@link EXPERIENCE_GATE_PROMPT} line — closed SOMEWHERE BETWEEN the matched prior line and
 *     now. That is what "a legitimate question about a DIFFERENT job" means structurally, and it
 *     covers skills/certifications/role-detail phrasing the keyword list was never going to
 *     enumerate exhaustively, WITHOUT adding more keywords: "Us company mein aapka role kya tha?"
 *     scores high Jaccard against job 1's differently-worded "Is naukri mein aapki responsibility
 *     kya thi?" and is about job 2, not a stall.
 *
 * NEITHER EXEMPTION EVER APPLIES TO AN EXACT (`equal`) MATCH. A model that asks the LITERAL SAME
 * WORDS twice has no legitimate reason tied to which job it is on — a rephrase is what a model
 * asking about a genuinely new job actually produces, and an unchanged sentence is what a model
 * that is simply stuck produces. That is the line the exact-repeat skills fixture sits on: same
 * words, crosses a gate, still a repeat.
 */
function repeatsHistory(reply: string, history: readonly TranscriptLine[]): boolean {
  const normalizedReply = normalize(reply);
  const replyTokens = tokens(normalizedReply);
  const replyIsPerJob = PER_JOB_QUESTION_PATTERN.test(reply);

  for (let i = 0; i < history.length; i++) {
    const line = history[i] as TranscriptLine;
    if (line.role !== "assistant") continue;
    const normalizedLine = normalize(line.text);
    if (normalizedLine.length === 0) continue;

    const equal = normalizedLine === normalizedReply;
    let similar = false;
    if (!equal) {
      const lineTokens = tokens(normalizedLine);
      similar =
        replyTokens.length >= 4 && lineTokens.length >= 4 && jaccard(replyTokens, lineTokens) >= 0.8;
    }
    if (!equal && !similar) continue;

    // exemption 1: the narrow keyword pair — UNCHANGED, applies to `equal` and `similar` alike,
    // exactly as it always has (the "kitne saal" fixture below is an EXACT repeat across a job
    // boundary and stays exempted through this one).
    const lineIsPerJob = PER_JOB_QUESTION_PATTERN.test(line.text);
    if (replyIsPerJob && lineIsPerJob) continue;

    // exemption 2 (#1517 review, MAJOR 2): a job gate closed between this line and now — a
    // STRUCTURAL "different job" signal that needs no keyword at all. `EXPERIENCE_GATE_PROMPT` is
    // the engine's own text, never the model's, so this can never be satisfied by anything the
    // model itself wrote. NEVER for an `equal` match — see the docblock above.
    if (similar) {
      const gateClosedSince = history
        .slice(i + 1)
        .some((later) => later.role === "assistant" && later.text === EXPERIENCE_GATE_PROMPT);
      if (gateClosedSince) continue;
    }

    return true;
  }
  return false;
}

/**
 * Classify a model-authored `reply_text` before it is served.
 *
 * ORDER: gate-shaped is checked first. A gate-shaped line is ALSO, trivially, a repeat of any
 * earlier gate-shaped line — but "the model wrote our gate in its own words" is the more useful
 * diagnostic, and the caller's fallback for the two classes only differs by log reason, not by
 * behaviour, so the order is cosmetic rather than load-bearing.
 */
export function classifyLlmReply(reply: string, history: readonly TranscriptLine[]): LlmReplyClass {
  if (isGateShaped(reply)) return "gate_shaped";
  if (repeatsHistory(reply, history)) return "repeat";
  return "ok";
}

/**
 * ═══ THE SAME READ, FOR THE SKILLS STAGE ═══ (ADR-0045 §3.2)
 *
 * On the general road a skills-only model asks for skills and the ENGINE ends each round with its
 * own gate — "Kya aur koi skill jodni hai?" [Haan] [Nahi] (`skills-gate.ts`). The two failure
 * shapes at the top of this file recur there with one noun changed: the model writes that gate in
 * its own words ("Aur koi skill add karni hai?"), whose "Nahi" closes nothing and hands the worker
 * nowhere; or it asks a question it has already asked. `classifySkillsReply` is the read for that
 * stage, and the enforcement is the caller's, under the same "move on, no retry" ruling.
 *
 * A SEPARATE FUNCTION, NOT A FLAG ON `classifyLlmReply`, because the two stages disagree about one
 * word class: "Koi aur cheez batana chahenge?" is an ordinary question during Phase A (its fixture
 * pins it `ok`), and in a stage that asks for nothing BUT skills it is the gate. Every constant
 * above is shared unchanged; the skills stage only adds its own nouns and two refinements of the
 * WH-exemption (a WH-word inside the marker's window; the exemption judged per sentence), all below.
 */

/**
 * MIRROR of `skills-gate.ts`'s `SKILLS_GATE_QUESTION` — the engine's own skills-gate line.
 *
 * DUPLICATED, NOT IMPORTED, so this guard stays a leaf that imports types only. Exported so
 * `skills-reply-guard.test.ts` can pin it byte-equal to the original: a reword of the gate that
 * forgets this line fails CI. Import the gate's text from `skills-gate.ts`, never from here.
 */
export const SKILLS_GATE_QUESTION_MIRROR = "Kya aur koi skill jodni hai?";

/**
 * A SKILL noun — the thing an ADD marker must be adding another of for a skills-stage line to be
 * gate-shaped. "cheez" belongs here and not in {@link JOB_NOUN_TOKENS}: in a stage that asks only
 * for skills, "koi aur cheez" can mean nothing else. Normalised on the way in, so a Devanagari
 * nukta written either way matches the tokens {@link normalize} produces.
 */
const SKILL_NOUN_TOKENS: ReadonlySet<string> = new Set(
  [
    "skill",
    "skills",
    "hunar",
    "kaushal",
    "cheez",
    "cheezein",
    "cheezen",
    "cheeze",
    "स्किल",
    "स्किल्स",
    "हुनर",
    "कौशल",
    "चीज़",
    "चीज",
    "चीज़ें",
    "चीजें",
  ].map(normalize),
);

/**
 * The WH-tokens that make a skills-stage line an OPEN question — {@link LEADING_WH_TOKENS}, plus the
 * common "konsi" spellings and the Devanagari forms a model echoing a Hindi speaker writes.
 *
 * WHY THE SKILLS STAGE NEEDS MORE THAN THE LEADING POSITION. The line a skills-only model writes
 * most is "Aur kaunsi skill aati hai?" — WH in the middle, an ADD marker in front of it. That is
 * the stage doing its job (ruling R3: as many skills as possible), not the gate: it asks WHICH,
 * and the gate asks WHETHER. The Phase A rule only exempts a leading WH-token, and under it that
 * line would be discarded every round — the worker would see the gate after the model's first
 * question, every time. So a WH-token BETWEEN the marker and the noun exempts that match too.
 */
const SKILLS_WH_TOKENS: ReadonlySet<string> = new Set([
  ...LEADING_WH_TOKENS,
  "konsa",
  "konsi",
  "konse",
  "kis",
  "kin",
  ...[
    "कौन",
    "कौनसा",
    "कौनसी",
    "कौनसे",
    "किस",
    "किन",
    "कितना",
    "कितने",
    "कितनी",
    "कैसे",
    "कहाँ",
    "कब",
  ].map(normalize),
]);

/**
 * "kya" / "क्या" — excepted at the HEAD of a line, exactly as {@link LEADING_WH_TOKENS} excepts it,
 * because there it opens a yes/no question ("Kya aur koi skill jodni hai?" is the gate itself).
 * BETWEEN an ADD marker and its noun it can only be the interrogative "what" — "aur kya cheezein
 * aati hain?" asks which — so there, and only there, it exempts like any WH-token.
 */
const WHAT_TOKENS: ReadonlySet<string> = new Set(["kya", ...["क्या"].map(normalize)]);

const NORMALIZED_SKILLS_GATE = normalize(SKILLS_GATE_QUESTION_MIRROR);

/**
 * Where one sentence of a model line ends: "?", "!", the danda, a newline — and "." only when a
 * space or the end of the line follows it, so "B.Com", "Node.js" and "2.5 saal" stay one sentence.
 *
 * WHY THE SKILLS READ SPLITS AT ALL. The leading-WH exemption says "this line asks WHICH", and that
 * is only ever true of the sentence the WH-word opens. Applied to the whole line it waved through
 * "Kaunsa software chalate hain? Aur koi skill bhi hai?" — a WHICH question, then the gate's twin —
 * and a worker's "Nahi" would then answer a gate the model wrote, the failure this guard exists to
 * stop. The one-question-per-reply rule that would forbid that line is a prompt instruction, not an
 * enforcement, so the line is reachable. Each sentence is judged on its own; the gate's twin in ANY
 * of them makes the line `gate_shaped`.
 */
const SENTENCE_BREAK = /[?？!！।॥\n\r]+|\.(?=\s|$)/u;

/**
 * Is `reply` shaped like the engine's own skills gate — the gate's words exactly, or, in any one
 * sentence, an ADD marker followed within three tokens by a SKILL noun, with no WH-token leading
 * THAT sentence or standing between that marker and that noun?
 */
function isSkillsGateShaped(reply: string): boolean {
  const normalized = normalize(reply);
  if (normalized.length === 0) return false;
  // The engine's own words. Today's wording is ALSO caught by the marker rule below; this is what
  // keeps the guard honest the day the gate is reworded into something the marker rule misses.
  if (normalized === NORMALIZED_SKILLS_GATE) return true;

  return reply.split(SENTENCE_BREAK).some(isSkillsGateSentence);
}

/** One sentence of {@link isSkillsGateShaped}: the WH-exemption and the marker rule, both local. */
function isSkillsGateSentence(sentence: string): boolean {
  const toks = tokens(normalize(sentence));
  if (toks.length === 0) return false;
  if (SKILLS_WH_TOKENS.has(toks[0] as string)) return false;

  for (let i = 0; i < toks.length; i++) {
    if (!ADD_MARKER_TOKENS.has(toks[i] as string)) continue;
    const window = toks.slice(i + 1, i + 1 + 3);
    const nounAt = window.findIndex((t) => SKILL_NOUN_TOKENS.has(t));
    if (nounAt === -1) continue;
    const asksWhich = window
      .slice(0, nounAt)
      .some((t) => SKILLS_WH_TOKENS.has(t) || WHAT_TOKENS.has(t));
    if (!asksWhich) return true;
  }
  return false;
}

/**
 * Classify a skills-stage model `reply_text` before it is served.
 *
 * `gate_shaped` — the model asked the engine's add-more-skills question (see
 * {@link isSkillsGateShaped}). "Kaunsi skill jodni hai?", asked after a Haan, is NOT: it asks
 * which, and that is the stage's own question. "Kaunsa software chalate hain? Aur koi skill bhi
 * hai?" IS: the WH-word excuses only the sentence it opens ({@link SENTENCE_BREAK}).
 * `repeat` — {@link repeatsHistory}, unchanged: the full history, both exemptions, and never an
 * exemption for an exact repeat.
 *
 * ORDER as in {@link classifyLlmReply}, and cosmetic for the same reason.
 */
export function classifySkillsReply(
  reply: string,
  history: readonly TranscriptLine[],
): LlmReplyClass {
  if (isSkillsGateShaped(reply)) return "gate_shaped";
  if (repeatsHistory(reply, history)) return "repeat";
  return "ok";
}
