/**
 * RI-7 — résumé-prefill coverage/override measurement: the pure aggregation, no database in
 * sight.
 *
 * WHAT THIS MEASURES. For each `RESUME_PREFILL_FIELDS` entry, and split by the résumé's
 * `extraction_method` (`pdf_text` / `docx` / `ocr`), across every parsed résumé import that
 * offered at least one suggestion:
 *
 *   coverage       — did the parse offer a (non-empty) suggestion for this field at all?
 *   confirmed      — does the worker have a later-saved value this field can be compared to?
 *   override       — when confirmed, does the saved value differ from what was suggested?
 *
 * WHY THE COMPARISON ITSELF LIVES OUTSIDE THIS MODULE. `eval-resume-prefill-coverage.ts` reads
 * `worker_resume_import`, decrypts `suggestions_enc`, and cross-references
 * `worker_pack_answer` / `worker_attributes` / `worker_education` / `workers.current_city` (the
 * ACTUAL storage locations `apps/api/src/profiling/facts/worker-fact.registry.ts` names for
 * each field — see that script's `RESUME_TARGET_FIELDS` docblock for the full citation and why
 * this package cannot import the registry directly). By the time a row reaches THIS file it is
 * already reduced to three booleans per field: nothing here ever sees a suggested value, a saved
 * value, a worker id, or an import id. That is not a convenience — it is how §5's privacy
 * requirement holds structurally rather than by discipline: a function that is never HANDED a
 * raw value cannot leak one, and `resume-prefill-coverage.test.ts`'s privacy test pins exactly
 * that shape.
 *
 * WHY GROUPED BY (field, extraction_method) AND NOTHING FINER. The plan's question is "does OCR
 * noise cost prefill coverage relative to a clean text layer", which is a per-method question;
 * grouping by worker or by import would either re-identify a row or produce a table too large to
 * read. Matches `eval-occupation-retrieval.ts`'s own choice to report only aggregate rates.
 */

/**
 * THE SIX FIELDS THIS MEASURES, in `RESUME_SUGGESTION_TARGETS` order.
 *
 * MIRRORS `apps/api/src/profiling/resume-import/resume-suggestions.ts`'s
 * `RESUME_SUGGESTION_TARGETS`, MINUS its two `null` entries (`domain_label` — router input, not
 * a suggestion; `machines` — no destination question exists, so it can never be covered). A
 * ninth resume-parse field or a ban lifted on either null is a change to that file, not this
 * one; `eval-resume-prefill-coverage.ts`'s own header names the manual-sync obligation.
 */
export const RESUME_PREFILL_FIELDS = [
  "role_label",
  "experience_years",
  "current_city",
  "salary_expected",
  "education_level",
  "availability",
] as const;

export type ResumePrefillField = (typeof RESUME_PREFILL_FIELDS)[number];

/** `worker_resume_import.extraction_method`, plus `"unknown"` for a parsed row that somehow has none. */
export type ObservedExtractionMethod = "pdf_text" | "docx" | "ocr" | "unknown";

/**
 * One field's outcome on one import — COUNTS-SHAPED, never value-shaped. There is no `string`
 * or `number` field anywhere on this type; that is the privacy guarantee, enforced by the type
 * checker rather than by a reviewer remembering to check.
 */
export interface FieldObservation {
  /** A non-empty suggestion was offered for this field. */
  readonly covered: boolean;
  /** A later-saved value exists to compare the suggestion against. */
  readonly confirmed: boolean;
  /**
   * Saved value differs from suggested value. `null` when {@link confirmed} is `false` — there
   * is nothing to compare, and `false` would misreport "confirmed and matched".
   */
  readonly matched: boolean | null;
}

/** One parsed résumé import, reduced to per-field observations. */
export interface ImportObservation {
  readonly extractionMethod: ObservedExtractionMethod;
  readonly fields: Readonly<Record<ResumePrefillField, FieldObservation>>;
}

export interface FieldMethodSummary {
  readonly field: ResumePrefillField;
  readonly extractionMethod: ObservedExtractionMethod;
  readonly importsWithSuggestion: number;
  readonly importsConfirmed: number;
  readonly overrideCount: number;
  /** `overrideCount / importsConfirmed`, or `0` when nothing was confirmed — never `NaN`. */
  readonly overrideRate: number;
}

function groupKey(field: ResumePrefillField, method: ObservedExtractionMethod): string {
  return `${field} ${method}`;
}

/**
 * Reduce every import's field observations into one row per (field, extraction_method).
 *
 * EVERY (field, method) PAIR THAT WAS EVER OBSERVED GETS A ROW, including one with zero
 * suggestions offered — so a caller scanning the output for a field/method combination that
 * simply never appears in the corpus can tell that apart from "not measured yet" only if this
 * function is honest about which pairs it saw. A pair with `importsWithSuggestion = 0` is
 * therefore a REAL, reportable finding (that extraction method never offers that field), not
 * noise to filter out.
 */
export function aggregateCoverage(
  observations: readonly ImportObservation[],
): FieldMethodSummary[] {
  const rows = new Map<
    string,
    { field: ResumePrefillField; method: ObservedExtractionMethod } & {
      importsWithSuggestion: number;
      importsConfirmed: number;
      overrideCount: number;
    }
  >();

  for (const observation of observations) {
    for (const field of RESUME_PREFILL_FIELDS) {
      const obs = observation.fields[field];
      if (!obs.covered) continue; // coverage is the gate: an uncovered field contributes nothing.

      const key = groupKey(field, observation.extractionMethod);
      const row = rows.get(key) ?? {
        field,
        method: observation.extractionMethod,
        importsWithSuggestion: 0,
        importsConfirmed: 0,
        overrideCount: 0,
      };
      row.importsWithSuggestion += 1;
      if (obs.confirmed) {
        row.importsConfirmed += 1;
        if (obs.matched === false) row.overrideCount += 1;
      }
      rows.set(key, row);
    }
  }

  return [...rows.values()]
    .map((r) => ({
      field: r.field,
      extractionMethod: r.method,
      importsWithSuggestion: r.importsWithSuggestion,
      importsConfirmed: r.importsConfirmed,
      overrideCount: r.overrideCount,
      overrideRate: r.importsConfirmed === 0 ? 0 : r.overrideCount / r.importsConfirmed,
    }))
    .sort((a, b) => {
      const fieldOrder = RESUME_PREFILL_FIELDS.indexOf(a.field) - RESUME_PREFILL_FIELDS.indexOf(b.field);
      if (fieldOrder !== 0) return fieldOrder;
      return a.extractionMethod < b.extractionMethod ? -1 : a.extractionMethod > b.extractionMethod ? 1 : 0;
    });
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/**
 * The stdout table — COUNTS AND RATES ONLY, matching `eval-occupation-retrieval.ts`'s own
 * reporting style. `resume-prefill-coverage.test.ts`'s privacy test asserts a distinctive
 * fixture string cannot reach this output; that only holds because nothing upstream of it ever
 * receives one.
 */
export function formatReport(
  summary: readonly FieldMethodSummary[],
  totalImports: number,
): string[] {
  const lines: string[] = [];
  lines.push(`[eval:resume-prefill] parsed imports with a suggestion payload: ${totalImports}`);
  if (summary.length === 0) {
    lines.push("[eval:resume-prefill] no covered fields observed.");
    return lines;
  }
  lines.push(
    "  field".padEnd(20) +
      "method".padEnd(10) +
      "offered".padStart(9) +
      "confirmed".padStart(11) +
      "overrides".padStart(11) +
      "override_rate".padStart(16),
  );
  for (const row of summary) {
    lines.push(
      `  ${row.field}`.padEnd(20) +
        row.extractionMethod.padEnd(10) +
        String(row.importsWithSuggestion).padStart(9) +
        String(row.importsConfirmed).padStart(11) +
        String(row.overrideCount).padStart(11) +
        pct(row.overrideRate).padStart(16),
    );
  }
  return lines;
}
