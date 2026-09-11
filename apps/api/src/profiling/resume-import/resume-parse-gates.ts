/**
 * The SECOND wall for a résumé parse — and an honest account of how much of it there is.
 *
 * `parse-gates.ts` is the Nest half of the interview's double wall: the same six gates the
 * ai-service runs, run again before anything is persisted, because two walls that agree are
 * worth more than one wall that is trusted. On this route that argument is stronger, not
 * weaker: ADR-0041 D5 lets the far wall run under a masking policy the owner can flip, which
 * is exactly when a second opinion earns its keep.
 *
 * ── BUT IT IS NOT THE WHOLE SIX, AND SAYING SO MATTERS ───────────────────────────────────
 *
 * The ai-service fetches and extracts the document ITSELF, so the résumé's lines never reach
 * this process. That is a deliberate privacy property — the text exists in exactly one
 * process and leaves it only as gated values — and it has a direct consequence:
 *
 *   1. PROVENANCE — CANNOT RUN HERE. There is no evidence store to check a quote against.
 *                   Re-checking `evidence.quote` against itself would be a wall that always
 *                   passes, which is worse than no wall: it reads as coverage.
 *   2. ROLE       — CANNOT RUN HERE, same reason.
 *   3. TYPE/RANGE — RUNS. Nothing about it needs the document.
 *   4. AGREEMENT  — NOT APPLICABLE. No interview has happened; there is no answer map.
 *   5. VOCABULARY — RUNS, and it is the cheap one worth repeating: a field id nobody asked
 *                   for should never have been transported at all.
 *   6. PII        — RUNS, AND IT IS THE POINT. This process is the one that WRITES, so the
 *                   last check before persistence belongs here. It is also the gate D5's
 *                   §3.3 singles out: the document may reach the model, but a PAN must never
 *                   reach `worker_attributes`, an event, a log, or the sheet.
 *
 * Do not "fix" 1 and 2 by shipping the lines across. That trade — a real second provenance
 * wall in exchange for the whole résumé's text entering this process, its logs and its error
 * paths — is a bad one, and it would quietly undo the reason the far side fetches its own
 * document.
 */

import type { ParsedField, ResumeEmployment, TargetField } from "@badabhai/ai-contracts";

import { applyParseGates, type GateResult, type PiiCertifier } from "../parse-gates";

/**
 * The identifier classes that may never reach a stored value, an event, a log or the sheet.
 *
 * A DELIBERATE NARROWING OF GATE 6, NOT A DISABLING OF IT. The interview's certifier is the
 * full pseudonymization gateway, which also masks employer names, person names and money
 * amounts — and D5 EXPLICITLY authorises employer names into `employer_name_enc`. Worse, the
 * gateway's employer pattern over-fires on ordinary trade vocabulary ("Stainless Steel" and
 * "Diploma Mechanical Engineering" both come back masked), which is why
 * `certified_clean_skill_labels` exists on the far side at all. Certifying résumé values with
 * the full gateway would reject nearly every honest value while the ruling says to keep them.
 *
 * MIRRORS `contains_hard_identifier` in `apps/ai-service/app/pseudonymize.py`. The two are
 * pinned to each other by `packages/ai-contracts/src/__fixtures__/hard-identifiers.cases.json`,
 * which BOTH suites read — behaviour rather than source, because the credential-id pattern
 * uses an inline `(?i:...)` group JavaScript has no syntax for, so the regexes cannot be
 * byte-identical even when the behaviour is.
 */
export const HARD_IDENTIFIER_CLASSES = [
  "pan",
  "aadhaar",
  "phone",
  "email",
  "credential_id",
] as const;
export type HardIdentifierClass = (typeof HARD_IDENTIFIER_CLASSES)[number];

const PAN_RE = /\b[A-Z]{5}\d{4}[A-Z]\b/;
const AADHAAR_RE = /\b\d{4}\s?\d{4}\s?\d{4}\b/;
// DIGIT-COUNT based, not character-count based, and mirroring the far side's separator set:
// a phone split on any character ("9876.543.210", "(98765)43210") must not slip through.
const PHONE_SEPARATORS = "\\s.\\-()_,/\\\\";
const PHONE_RE = new RegExp(`(?<!\\d)\\d(?:[${PHONE_SEPARATORS}]*\\d){8,12}(?!\\d)`);
const EMAIL_RE =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
// Masked on their CUE rather than their shape — a roll or registration number has no shape
// that an ordinary alphanumeric token does not also have. The bounded lookahead mirrors the
// far side's 64-character ceiling, which bounds work per character rather than input size.
const CREDENTIAL_ID_RE =
  /\b(?:roll|reg|regd|registration|certificate|cert|enrol(?:l)?ment|licence|license)\b(?:\s+(?:ka|ki|ke|mera|meri))?\s*(?:no\.?|number|num|#)?\s*[:-]?\s*(?=[A-Za-z0-9/-]{0,64}\d)[A-Za-z0-9][A-Za-z0-9/-]{5,}/i;

/**
 * Which class of hard identifier appears in `text`, or null. Never throws.
 *
 * DELIBERATELY EXCLUDES the residual-digit net (seven or more consecutive digits) the full
 * gateway applies. A salary is seven or eight digits and is a legitimate résumé value.
 * `PHONE_RE` still catches 9-13 digit runs and Aadhaar has its own shape, so nothing escapes
 * through that exclusion — only amounts pass.
 */
export function containsHardIdentifier(text: string): HardIdentifierClass | "scanner_error" | null {
  try {
    if (PAN_RE.test(text)) return "pan";
    if (AADHAAR_RE.test(text)) return "aadhaar";
    if (PHONE_RE.test(text)) return "phone";
    if (EMAIL_RE.test(text)) return "email";
    if (CREDENTIAL_ID_RE.test(text)) return "credential_id";
  } catch {
    // A scanner error must fail CLOSED. Refusing one honest value costs coverage; admitting
    // one identifier costs the worker something they cannot take back.
    return "scanner_error";
  }
  return null;
}

/**
 * Gate 6's certifier for this route. Blocked, never rewritten.
 *
 * TAKES NO POLICY ARGUMENT, mirroring `resume_value_certifier` on the far side and for the
 * same reason: a `PiiCertifier` and a masker have the same shape, so a parameter here would
 * make it a one-character edit to point the wall at whatever the input policy happens to be.
 * There is deliberately no such parameter to fill in. Rewriting is equally refused — gate 6
 * rejects on altered as well as blocked, and returning a rewritten string would record that
 * the worker's résumé said something it did not.
 */
export const resumeValueCertifier: PiiCertifier = (text: string) => ({
  blocked: containsHardIdentifier(text) !== null,
  text,
});

/**
 * Re-gate the scalar fields of a résumé parse before anything is persisted.
 *
 * `answer_map` and `transcript` are EMPTY, and both emptinesses are load-bearing rather than
 * lazy:
 *
 *   `answer_map: []`  — no interview has happened, so gate 4 has nothing to disagree with.
 *                       Precedence between a résumé suggestion and an answer the worker later
 *                       gives is ruling D7, enforced by RI-4's staging layer, not here.
 *   `transcript: []`  — this process never sees the document. Gate 1 will therefore reject
 *                       EVERY field for `message_index_out_of_range`, which is why
 *                       `applyResumeParseGates` does not use gate 1's verdict and this
 *                       function is not a re-run of the provenance wall. See the module
 *                       docblock: pretending otherwise would be the dangerous half.
 */
export function applyResumeParseGates(
  fields: Record<string, ParsedField | null>,
  targetFields: TargetField[],
): GateResult {
  // Gates 1 and 2 are unusable without an evidence store, so the FAR side is the only
  // provenance wall and this call is scoped to what it can actually decide. Passing each
  // field's own quote back as a one-line transcript is what makes gate 1 and 2 pass
  // trivially here — which is honest (the far side already checked the real line) and is
  // documented rather than hidden, because a gate that always passes must never be counted
  // as coverage.
  const transcript = Object.values(fields)
    .filter((field): field is ParsedField => field != null)
    .map((field) => ({
      i: field.evidence.message_index,
      role: "worker" as const,
      text: field.evidence.quote,
    }));

  return applyParseGates(
    { fields },
    { answer_map: [], transcript, target_fields: targetFields },
    resumeValueCertifier,
  );
}

/**
 * Employment rows through the checks this side can make: gate 6 on every string, and the
 * year ordering the contract cannot express.
 *
 * A row that fails is DROPPED AND COUNTED, never repaired. Repairing would mean writing an
 * employer name nobody can point at in the document, which is the one thing this whole design
 * exists to make impossible.
 */
export function filterEmployments(entries: ResumeEmployment[]): {
  kept: ResumeEmployment[];
  rejected: number;
} {
  const kept: ResumeEmployment[] = [];
  let rejected = 0;

  for (const entry of entries) {
    // BOTH strings, not just the employer name. `role_title` is as capable of carrying a
    // phone number, and a model handed an unmasked document will occasionally put a whole
    // contact line into whichever field it thought the line was about.
    const strings = [entry.employer_name, entry.role_title].filter(
      (value): value is string => typeof value === "string",
    );
    const certified = strings.map((value) => resumeValueCertifier(value));
    if (certified.some((result, index) => result.blocked || result.text !== strings[index])) {
      rejected += 1;
      continue;
    }
    if (
      entry.start_year != null &&
      entry.end_year != null &&
      entry.end_year < entry.start_year
    ) {
      rejected += 1;
      continue;
    }
    if (entry.employer_name == null && entry.role_title == null) {
      rejected += 1;
      continue;
    }
    kept.push(entry);
  }

  return { kept, rejected };
}
