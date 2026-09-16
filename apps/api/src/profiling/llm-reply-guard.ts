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
 * exactly that failure with the repeat further back in the transcript.
 *
 * THE ONE NARROW EXEMPTION: a match is NOT flagged when BOTH the current line and the matched
 * prior line fall inside the same per-job "kitne saal / kya kaam" interrogative pattern — those
 * are EXPECTED to recur, once per job, and flagging them would end Phase A the moment a worker
 * described a second job.
 */
function repeatsHistory(reply: string, history: readonly TranscriptLine[]): boolean {
  const normalizedReply = normalize(reply);
  const replyTokens = tokens(normalizedReply);
  const replyIsPerJob = PER_JOB_QUESTION_PATTERN.test(reply);

  for (const line of history) {
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

    const lineIsPerJob = PER_JOB_QUESTION_PATTERN.test(line.text);
    if (replyIsPerJob && lineIsPerJob) continue; // the one expected-to-recur exemption
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
