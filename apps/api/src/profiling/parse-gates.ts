/**
 * THE SIX "NEVER INVENT" GATES — the wall between a language model and a worker's profile.
 *
 * PURE, and that is deliberate: `(parseOutput, input) -> GateResult`. No DI, no I/O, no clock. The
 * same six checks run in the ai-service before the response leaves AND here before anything is
 * persisted — the double-wall discipline the domain match already uses — and a pure function is
 * what makes running them twice cheap and running them identically possible.
 *
 * THE FRAMING IS THE ENFORCEMENT. The model is never asked "what is this worker's salary". It is
 * asked to TYPE AND CITE the answer the deterministic map already holds, and may add coverage only
 * from transcript spans. Every gate below removes one way of answering that question dishonestly:
 *
 *   1. PROVENANCE — the quote must literally appear in the cited message.
 *   2. ROLE — the cited message must be the WORKER's, never our own question.
 *   3. TYPE/RANGE — the value must be the right shape and a survivable magnitude.
 *   4. AGREEMENT — the deterministic map wins any disagreement, always.
 *   5. VOCABULARY — a field nobody asked for is dropped.
 *   6. PII — every surviving string is re-certified before it can be stored.
 *
 * FAIL CLOSED, PER FIELD. A field that fails any gate is DROPPED and counted, never repaired and
 * never allowed through "mostly correct". Dropping is safe because of the property the whole design
 * rests on: the deterministic answer map alone is already a usable profile, so the LLM is an
 * overlay that can only ADD coverage. Losing an overlay field costs coverage; keeping a fabricated
 * one costs the worker their credibility with an employer.
 */

import type {
  AnswerRecord,
  EvidenceSpan,
  ParsedField,
  ProfileParseInput,
  ProfileParseOutput,
  TargetField,
  TranscriptLine,
} from "@badabhai/ai-contracts";
import { canonicalCity } from "@badabhai/profiling-lexicon";

/** Which gate rejected a field. Ids and counts only — never values (§2). */
export const GATE_IDS = [
  "provenance",
  "role",
  "type_range",
  "agreement",
  "vocabulary",
  "pii",
] as const;
export type GateId = (typeof GATE_IDS)[number];

/**
 * Every reason a gate may give, as a CLOSED SET.
 *
 * Declared rather than left as `string` because these same six gates run a second time in the
 * ai-service (`app/profiling/parse_gates.py`), and a rejection vocabulary that drifts between the
 * two walls is a wall that reports different things about the same field. A parity test reads this
 * array out of this file and asserts the Python mirror is identical, so a new reason has to be
 * added on both sides or CI fails — and the union type means a typo here is a compile error rather
 * than a novel code nobody's dashboard knows about.
 */
export const REJECTION_REASONS = [
  "message_index_out_of_range",
  "quote_not_in_message",
  "span_not_from_worker",
  "value_absent",
  "not_a_number",
  "not_a_string",
  "not_a_boolean",
  "not_an_array",
  "experience_years_out_of_range",
  "salary_out_of_range",
  "availability_not_in_enum",
  "value_not_in_enum",
  "disagrees_with_answer_map",
  "field_id_not_requested",
  "pii_blocked",
  "pii_altered",
  "gate_error",
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export interface Rejection {
  readonly fieldId: string;
  readonly gate: GateId;
  /** PII-FREE. A reason code from the closed set above, never the offending value. */
  readonly reason: RejectionReason;
}

export interface GateResult {
  /** The fields that survived all six gates. */
  readonly accepted: Readonly<Record<string, ParsedField>>;
  readonly rejections: readonly Rejection[];
  /**
   * Field ids where the LLM disagreed with the deterministic map. The map's value stands; these
   * feed `profile.parse_disagreement` (ids and counts only, never values).
   */
  readonly disagreements: readonly string[];
}

/** The bounds the plan fixes. Stated once, here, so the gate and its tests cannot drift. */
export const EXPERIENCE_YEARS_RANGE = { min: 0, max: 60 } as const;
export const SALARY_INR_PER_MONTH_RANGE = { min: 1_000, max: 500_000 } as const;
export const AVAILABILITY_VALUES = [
  "immediate",
  "notice_period",
  "not_looking",
  "unknown",
] as const;

/**
 * Whitespace-normalized containment.
 *
 * The model reflows whitespace constantly — a newline becomes a space, a double space collapses —
 * and rejecting on that would fail honest citations while catching no fabrications. Everything
 * else about the quote must be literal.
 */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function quoteAppearsIn(line: string, quote: string): boolean {
  return normalizeWhitespace(line).includes(normalizeWhitespace(quote));
}

/**
 * The cited line, found BY ITS `i` — never by array position.
 *
 * The contract is explicit that "`i` is what evidence spans point at", and the difference is not
 * academic: the transcript reaching a parse is a WINDOW (CHAT_HISTORY_WINDOW_TURNS), so array
 * position and `i` diverge the moment an interview is longer than the window. Indexing the array
 * would then check the provenance and the ROLE of a different message than the one cited — which
 * can pass an assistant line off as a worker line purely by offset.
 */
function lineAt(
  transcript: readonly TranscriptLine[],
  messageIndex: number,
): TranscriptLine | undefined {
  return transcript.find((line) => line.i === messageIndex);
}

// ---------------------------------------------------------------------------
// Gate 1 — PROVENANCE
// ---------------------------------------------------------------------------

/**
 * The quote must be a literal substring of the message it cites.
 *
 * THE STRONGEST GATE, because it inverts the burden: a hallucinated value has no span to point at.
 * A model that invents "12 years" cannot produce a message containing it, so the fabrication is
 * caught structurally rather than by anyone judging plausibility.
 */
export function checkProvenance(
  evidence: EvidenceSpan,
  transcript: readonly TranscriptLine[],
): Rejection["reason"] | null {
  const line = lineAt(transcript, evidence.message_index);
  if (!line) return "message_index_out_of_range";
  if (!quoteAppearsIn(line.text, evidence.quote)) return "quote_not_in_message";
  return null;
}

// ---------------------------------------------------------------------------
// Gate 2 — ROLE
// ---------------------------------------------------------------------------

/**
 * The cited span must come from a `role: "worker"` line.
 *
 * THIS IS A DEFECT WE HAVE ALREADY PAID FOR: a controller question that listed example controllers
 * produced five controllers for a worker who named one. The examples were in OUR text, the quote
 * was perfectly real, and provenance alone happily passed it. Sourcing from the assistant's own
 * words is how a system interviews itself.
 */
export function checkRole(
  evidence: EvidenceSpan,
  transcript: readonly TranscriptLine[],
): Rejection["reason"] | null {
  const line = lineAt(transcript, evidence.message_index);
  if (!line) return "message_index_out_of_range";
  if (line.role !== "worker") return "span_not_from_worker";
  return null;
}

// ---------------------------------------------------------------------------
// Gate 3 — TYPE / ENUM / RANGE
// ---------------------------------------------------------------------------

/**
 * The value must be the declared type, inside the declared range, and inside the declared enum.
 *
 * `current_city` is the ONE field kept on failure rather than dropped: an unrecognized city is
 * still evidence of where a worker lives, and deleting it would lose a strong matching signal over
 * a gazetteer gap. It is flagged `city_unrecognized` so a human can extend the gazetteer, which is
 * the recoverable direction.
 */
export function checkTypeRange(
  fieldId: string,
  value: unknown,
  target: TargetField | undefined,
): Rejection["reason"] | null {
  if (value === null || value === undefined) return "value_absent";

  switch (fieldId) {
    case "experience_years": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "not_a_number";
      if (value < EXPERIENCE_YEARS_RANGE.min || value > EXPERIENCE_YEARS_RANGE.max) {
        return "experience_years_out_of_range";
      }
      return null;
    }
    case "salary_expected":
    case "salary_current": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "not_a_number";
      if (value < SALARY_INR_PER_MONTH_RANGE.min || value > SALARY_INR_PER_MONTH_RANGE.max) {
        // Catches the 12x period error in both directions: an annual figure read as monthly, and
        // a monthly figure read as annual.
        return "salary_out_of_range";
      }
      return null;
    }
    case "availability": {
      if (typeof value !== "string") return "not_a_string";
      if (!(AVAILABILITY_VALUES as readonly string[]).includes(value)) return "availability_not_in_enum";
      return null;
    }
    case "current_city": {
      if (typeof value !== "string" || value.trim().length === 0) return "not_a_string";
      // ALWAYS ACCEPTED once it is a non-empty string. An unrecognized city is still evidence of
      // where the worker lives, and dropping it would lose a strong matching signal over a
      // gazetteer gap. Recognition is reported separately by `isCityUnrecognized` so a human can
      // extend the gazetteer — deliberately NOT a rejection, and written as a plain return rather
      // than a `canonicalCity(...) ? null : null` that only looks like a decision.
      return null;
    }
    default:
      break;
  }

  // Generic checks from the declared target, for every other field.
  if (!target) return null;
  if (target.type === "number" && typeof value !== "number") return "not_a_number";
  if (target.type === "boolean" && typeof value !== "boolean") return "not_a_boolean";
  if (target.type === "string" && typeof value !== "string") return "not_a_string";
  if (target.type === "string_array") {
    if (!Array.isArray(value)) return "not_an_array";
    // THE ITEMS, TOO. `Array.isArray` alone let `["lathe", { note: "call 9876543210" }]` through as
    // a valid string_array, and gate 6 then skipped the object because it only inspected string
    // members — so a nested object walked out with the wall reporting every counter at zero. A
    // "string array" whose items are not strings is not the declared type.
    if (value.some((item) => typeof item !== "string")) return "not_a_string";
  }
  if (target.type === "enum") {
    if (typeof value !== "string") return "not_a_string";
    if (target.enum && !target.enum.includes(value)) return "value_not_in_enum";
  }
  return null;
}

/** Did gate 3 accept `current_city` but fail to recognize it? Flagged, never dropped. */
export function isCityUnrecognized(fieldId: string, value: unknown): boolean {
  return fieldId === "current_city" && typeof value === "string" && !canonicalCity(value);
}

// ---------------------------------------------------------------------------
// Gate 4 — ANSWER-MAP AGREEMENT
// ---------------------------------------------------------------------------

/**
 * Where the deterministic map holds a live value, the LLM must agree with it — or be discarded.
 *
 * THIS IS THE MECHANISM THAT MAKES THE MODEL STRUCTURALLY INCAPABLE OF OVERRIDING THE RECORD. It
 * can reformat, translate and type what the worker said; it cannot change it. Every other gate
 * removes a way of inventing; this one removes the ability to contradict.
 *
 * Compared on the NORMALIZED value, and only against a live record — a `superseded` history entry
 * is a value the worker themselves replaced, so a parse matching the NEW value must not be judged
 * against the old one.
 */
export function checkAgreement(
  fieldId: string,
  value: unknown,
  answerMap: readonly AnswerRecord[],
): Rejection["reason"] | null {
  const record = answerMap.find(
    (r) => (r.target_field ?? r.question_key) === fieldId && r.status === "answered",
  );
  if (!record) return null;
  if (record.value_normalized === null || record.value_normalized === undefined) return null;
  return sameValue(record.value_normalized, value) ? null : "disagrees_with_answer_map";
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  // Case- and whitespace-insensitive for strings: "pune" and "Pune " are the SAME answer, and
  // treating them as a disagreement would discard a correct parse and emit a false event.
  if (typeof a === "string" && typeof b === "string") {
    return normalizeWhitespace(a).toLowerCase() === normalizeWhitespace(b).toLowerCase();
  }
  return Object.is(a, b);
}

// ---------------------------------------------------------------------------
// Gate 5 — CLOSED VOCABULARY
// ---------------------------------------------------------------------------

/** A field id outside `target_fields` was never asked for, and is dropped and counted. */
export function checkVocabulary(
  fieldId: string,
  targets: readonly TargetField[],
): Rejection["reason"] | null {
  return targets.some((t) => t.field_id === fieldId) ? null : "field_id_not_requested";
}

// ---------------------------------------------------------------------------
// Gate 6 — PII RE-CERTIFICATION
// ---------------------------------------------------------------------------

/**
 * Every surviving string goes back through pseudonymization; blocked or ALTERED ⇒ rejected.
 *
 * ALTERED IS THE LOAD-BEARING WORD. "Blocked" catches the obvious case, but a value the
 * pseudonymizer silently rewrites — a phone number turned into a token — is a value that CONTAINED
 * PII, and storing the rewritten form would record that the worker said something they did not.
 * The certifier is injected because pseudonymization lives on the ai-service boundary; this file
 * stays pure and the caller supplies the wall.
 */
export type PiiCertifier = (text: string) => { blocked: boolean; text: string };

export function checkPii(value: unknown, certify: PiiCertifier): Rejection["reason"] | null {
  for (const item of stringsIn(value)) {
    const certified = certify(item);
    if (certified.blocked) return "pii_blocked";
    if (certified.text !== item) return "pii_altered";
  }
  return null;
}

/**
 * Every string reachable inside `value`, INCLUDING object keys. Order is deterministic.
 *
 * AT ANY DEPTH, and that was learned the hard way. An earlier version inspected only top-level
 * strings, so `["lathe", { note: "call 9876543210" }]` had the object quietly skipped: the phone
 * number was certified by nothing, the field was ACCEPTED, and the per-gate counters reported a
 * clean pass. Keys are walked because the model chooses those too. JSON has no cycles and the
 * parser above this already refuses pathological nesting, so the recursion is bounded.
 */
export function stringsIn(value: unknown): string[] {
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      found.push(node);
    } else if (Array.isArray(node)) {
      for (const item of node) visit(item);
    } else if (node !== null && typeof node === "object") {
      for (const [key, item] of Object.entries(node)) {
        found.push(key);
        visit(item);
      }
    }
  };
  visit(value);
  return found;
}

// ---------------------------------------------------------------------------
// The wall
// ---------------------------------------------------------------------------

/**
 * Run all six gates over a parse output. Pure, total, and never throws.
 *
 * ORDER IS DELIBERATE: vocabulary first (cheapest, and a field nobody asked for should not be
 * examined at all), then provenance and role (which need no domain knowledge), then type, then
 * agreement, then PII last — because PII re-certification is the only gate with a real cost, and
 * it should only ever run on values that have already earned the right to be stored.
 */
export function applyParseGates(
  // `Pick`, matching `input` below, because this function reads `fields` and nothing else.
  // Taking the whole `ProfileParseOutput` made every caller — including a dozen tests that care
  // only about gate behaviour — construct fields the gates never look at, so adding `ai_metadata`
  // to the contract broke them all. A parameter should name what it uses.
  output: Pick<ProfileParseOutput, "fields">,
  input: Pick<ProfileParseInput, "answer_map" | "transcript" | "target_fields">,
  certify: PiiCertifier,
): GateResult {
  const accepted: Record<string, ParsedField> = {};
  const rejections: Rejection[] = [];
  const disagreements: string[] = [];

  for (const [fieldId, field] of Object.entries(output.fields ?? {})) {
    // A null field is the model saying "I looked and found nothing citable" — an honest answer,
    // not a rejection, and not something to count as a failure.
    if (field === null || field === undefined) continue;

    const reject = (gate: GateId, reason: RejectionReason) => {
      rejections.push({ fieldId, gate, reason });
    };

    try {
      gateOne(fieldId, field, input, certify, reject, accepted, disagreements);
    } catch {
      // "PURE, TOTAL, AND NEVER THROWS" IS A CLAIM THIS MAKES TRUE, and the difference is not
      // theoretical: the sibling Python wall raised `OverflowError` on a 401-digit integer from
      // the model, which escaped and returned HTTP 500 — one fabricated number destroying every
      // honest field in the same response, the exact opposite of per-field fail-closed. An
      // unforeseen throw must cost ONE field, never the interview. Not silent: the field is
      // DROPPED and counted under its own `gate_error`, so a wall failing this way appears in the
      // counters instead of looking like a clean pass.
      reject("type_range", "gate_error");
    }
  }

  return { accepted, rejections, disagreements };
}

/**
 * One field through all six gates, in order.
 *
 * Extracted so the caller can wrap exactly ONE field's work in the totality guard. A `try` around
 * the whole loop would let one bad field skip every field after it — a worse failure than the one
 * being guarded against.
 */
function gateOne(
  fieldId: string,
  field: ParsedField,
  input: Pick<ProfileParseInput, "answer_map" | "transcript" | "target_fields">,
  certify: PiiCertifier,
  reject: (gate: GateId, reason: RejectionReason) => void,
  accepted: Record<string, ParsedField>,
  disagreements: string[],
): void {
  const vocabulary = checkVocabulary(fieldId, input.target_fields ?? []);
  if (vocabulary) return reject("vocabulary", vocabulary);

  const provenance = checkProvenance(field.evidence, input.transcript ?? []);
  if (provenance) return reject("provenance", provenance);

  const role = checkRole(field.evidence, input.transcript ?? []);
  if (role) return reject("role", role);

  const target = (input.target_fields ?? []).find((t) => t.field_id === fieldId);
  const typeRange = checkTypeRange(fieldId, field.value, target);
  if (typeRange) return reject("type_range", typeRange);

  const agreement = checkAgreement(fieldId, field.value, input.answer_map ?? []);
  if (agreement) {
    // NOT merely a rejection: the deterministic value stands and this is reported so
    // `profile.parse_disagreement` can be emitted with ids and counts only.
    reject("agreement", agreement);
    disagreements.push(fieldId);
    return;
  }

  const pii = checkPii(field.value, certify);
  if (pii) return reject("pii", pii);

  accepted[fieldId] = field;
}

/** Rejection counts per gate — the shape observability wants. Ids and counts only. */
export function countByGate(rejections: readonly Rejection[]): Record<GateId, number> {
  const counts = Object.fromEntries(GATE_IDS.map((g) => [g, 0])) as Record<GateId, number>;
  for (const r of rejections) counts[r.gate] += 1;
  return counts;
}
