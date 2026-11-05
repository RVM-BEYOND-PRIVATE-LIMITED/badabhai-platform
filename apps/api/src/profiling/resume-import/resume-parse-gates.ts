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
 *                   reach `worker_attributes`, an event, a log, or the sheet. It runs over
 *                   the field's VALUE and over its cited SPAN — see `applyResumeParseGates`
 *                   for why the span needs its own check on this route and on no other.
 *
 * Do not "fix" 1 and 2 by shipping the lines across. That trade — a real second provenance
 * wall in exchange for the whole résumé's text entering this process, its logs and its error
 * paths — is a bad one, and it would quietly undo the reason the far side fetches its own
 * document.
 */

import type { ParsedField, ResumeEmployment, TargetField } from "@badabhai/ai-contracts";

import {
  checkPii,
  checkTypeRange,
  checkVocabulary,
  type GateId,
  type GateResult,
  type PiiCertifier,
  type Rejection,
} from "../parse-gates";

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
 * WHAT THAT NARROWING KNOWINGLY LETS THROUGH: a person's name. RULED 2026-09-11 (Prakash) and
 * recorded in ADR-0041 §3.3, which used to claim the opposite. The gateway's name detection is
 * cue-based and returns "Ramesh Kumar" unchanged, so widening to it would not catch the name and
 * WOULD mask a worker's stated salary — measured, not assumed; the numbers are in
 * `contains_hard_identifier`'s docstring on the far side. A name here is the worker's own, on his
 * own record. If a detector is ever built, it goes in the list below and nowhere else.
 *
 * MIRRORS `contains_hard_identifier` in `apps/ai-service/app/pseudonymize.py`. The two are
 * pinned to each other by `packages/ai-contracts/src/__fixtures__/hard-identifiers.cases.json`,
 * which BOTH suites read — behaviour rather than source, because the credential-id pattern
 * uses an inline `(?i:...)` group JavaScript has no syntax for, so the regexes cannot be
 * byte-identical even when the behaviour is.
 */
export {
  HARD_IDENTIFIER_CLASSES,
  type HardIdentifierClass,
  CONTROL_CHARACTER_REFUSAL,
  RESUME_CUED_ID_RE,
  CREDENTIAL_ID_RE,
  containsHardIdentifier,
} from "../../common/hard-identifier";
import { containsHardIdentifier } from "../../common/hard-identifier";

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
 * THREE GATES, NAMED: vocabulary, type/range, and PII over both the value and its cited span.
 * Gate 4 has no answer map to consult (no interview has happened; precedence is ruling D7 and
 * RI-4's staging layer). Gates 1 and 2 have no evidence store and are ABSENT — not faked, not
 * approximated. The module docblock argues why that is the right trade.
 */
export function applyResumeParseGates(
  fields: Record<string, ParsedField | null>,
  targetFields: readonly TargetField[],
): GateResult {
  // RUNS THE THREE GATES DIRECTLY RATHER THAN CALLING `applyParseGates`, and that is the
  // point of this function rather than a shortcut around it.
  //
  // THE FIRST VERSION DID CALL IT, with a transcript built from each field's OWN quote — the
  // exact construction the module docblock above names as the wall that always passes. That
  // was not merely dishonest, it was a live defect: `lineAt` in `parse-gates.ts` resolves a
  // citation with `find(line => line.i === messageIndex)`, FIRST MATCH WINS. Two fields
  // citing the same résumé line produced two entries with the same `i` and different text, so
  // field #2 was checked against field #1's quote, failed `quote_not_in_message`, and was
  // DROPPED — after the far side had accepted it against the real document. A header line
  // yielding `current_city`, `role_label` and `experience_years` together is the ORDINARY
  // case, so the ordinary case lost two of three fields and logged it as "dropped by the
  // second wall", pointing whoever investigated at the ai-service.
  //
  // Passing an empty transcript instead does not work either: `applyParseGates` returns at
  // the first failing gate, so every field would stop at `provenance` and gate 6 — the gate
  // this side exists to run — would never execute. Hence the explicit loop. The gate
  // FUNCTIONS are still the shared ones, so the rules cannot drift; only the composition
  // differs, because only three of the six have an input on this side.
  const accepted: Record<string, ParsedField> = {};
  const rejections: Rejection[] = [];

  for (const [fieldId, field] of Object.entries(fields)) {
    // A null field is the model saying "I looked and found nothing citable" — an honest
    // answer, not a rejection.
    if (field == null) continue;

    const reject = (gate: GateId, reason: Rejection["reason"]) =>
      rejections.push({ fieldId, gate, reason });

    const vocabulary = checkVocabulary(fieldId, targetFields);
    if (vocabulary) {
      reject("vocabulary", vocabulary);
      continue;
    }

    const target = targetFields.find((t) => t.field_id === fieldId);
    const typeRange = checkTypeRange(fieldId, field.value, target);
    if (typeRange) {
      reject("type_range", typeRange);
      continue;
    }

    const valuePii = checkPii(field.value, resumeValueCertifier);
    if (valuePii) {
      reject("pii", valuePii);
      continue;
    }

    // THE CITED SPAN, which `checkPii` is never given on any route because on every OTHER
    // route it cannot carry anything the value cannot — the transcript was pseudonymized
    // before the model saw it. Here, with the far side's raw-text policy on, a quote is a
    // literal substring of an UNMASKED résumé line, and the line most likely to be cited for
    // `current_city` is the header carrying the phone number and the PAN.
    const spanPii = checkPii(field.evidence.quote, resumeValueCertifier);
    if (spanPii) {
      reject("pii", spanPii);
      continue;
    }

    accepted[fieldId] = field;
  }

  return { accepted, rejections, disagreements: [] };
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
    // THE CITED SPAN IS ONE OF THE STRINGS. It was missing here until the RI-3 security
    // review: an employment row's quote is the résumé line it was read from, and on a real
    // résumé that line carries the employer AND, very often, the contact details printed
    // beside it. Certifying the name while shipping the line it came from is no wall at all.
    const strings = [entry.employer_name, entry.role_title, entry.evidence.quote].filter(
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
