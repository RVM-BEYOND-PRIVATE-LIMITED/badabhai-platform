/**
 * Value normalizers + the negation engine.
 *
 * These run at CAPTURE TIME, on every turn — not at parse time. That timing is the whole
 * reason the system can fail closed: because `AnswerRecord.valueNormalized` is already
 * populated when the interview ends, a profile can be projected from the deterministic
 * answer map alone when the parsing LLM is down, blocked, or fails its provenance gates.
 * The LLM is an overlay, never a dependency.
 *
 * Owner: Prakash (Conversation & Profiling). Lifted from `signals.py` in Phase 3.
 */

/** A normalized value plus the evidence span it came from. */
export interface NormalizedValue<T> {
  readonly value: T;
  /** Character offsets into the source message. Feeds the parse call's provenance gate. */
  readonly span: { readonly start: number; readonly end: number };
  /**
   * True when the negation engine VETOED a match that would otherwise have fired.
   * "abhi kaam nahi mil raha" must never become `availability: immediate`.
   */
  readonly negationVetoed: boolean;
}

/** Monthly rupees. The interview never stores a raw string for a numeric field. */
export type MonthlyInr = number;

/**
 * Years of experience. `signals._EXPERIENCE_RE`.
 * Handles "7 saal", "saat saal", "7-8 years", "ek dedh saal".
 */
export declare function parseExperienceYears(text: string): NormalizedValue<number> | null;

/**
 * Expected/current salary, normalized to rupees per MONTH. `signals._SALARY_RE` plus the
 * period detection that disambiguates "18000" (month), "18k" (month), "2.5 lakh" (year),
 * "700 rupaye" (day). Getting the period wrong is a 12x error, so period detection is not
 * optional — a bare number with no period cue resolves by magnitude heuristic and records
 * lower confidence.
 */
export declare function parseSalaryMonthly(text: string): NormalizedValue<MonthlyInr> | null;

/** Canonical city, resolved against the gazetteer. `signals._canonical_city`. */
export declare function canonicalCity(text: string): NormalizedValue<string> | null;

/** Canonical state. `signals._detect_state`. */
export declare function canonicalState(text: string): NormalizedValue<string> | null;

/** Availability, matching the shipped `DraftProfile` enum. */
export type Availability = "immediate" | "notice_period" | "not_looking" | "unknown";

/**
 * Availability + notice period. `signals._has_immediate_cue` / `_has_notice_cue` /
 * `_notice_period_days`, with `_apply_negation` guarding every cue.
 */
export declare function parseAvailability(
  text: string,
): NormalizedValue<{ availability: Availability; noticeDays: number | null }> | null;

/** Willingness to relocate. `signals._has_relocate_cue`, negation-guarded. */
export declare function parseRelocationWillingness(text: string): NormalizedValue<boolean> | null;

/**
 * The negation engine. Exposed because the orchestrator needs it directly for chip answers:
 * a tapped chip is the worker's answer of record verbatim, and a free-text answer that
 * negates a chip label must beat it.
 *
 * `signals._apply_negation` / `_negation_vetoed` / `_preceded_by_negator`.
 */
export declare function isNegated(text: string, span: { start: number; end: number }): boolean;

/**
 * RFS field id → the `WorkerProfileDraft` path it lands on.
 *
 * Published as DATA, not glue code, because the two vocabularies have drifted before and
 * nothing connected them: the interview captured `trade` / `salary_expected` /
 * `tools_equipment` while extraction independently re-parsed the transcript looking for
 * `primary_role` / `expected_salary` / `machines` + `controllers`.
 *
 * Guarded by an exhaustiveness test: every id in
 * `PROFILING_REQUIRED_FIELDS ∪ PROFILING_OPTIONAL_FIELDS` must have an entry here or CI
 * fails. THAT TEST is the actual fix for the drift — the contract field is just the pipe.
 */
export interface CrosswalkEntry {
  readonly draftPath: string;
  readonly type: "string" | "number" | "string[]" | "bool" | "enum";
  readonly unit?: "years" | "inr_per_month";
  /** For `tools_equipment`, which routes tokens to `machines[]` vs `controllers[]`. */
  readonly splitter?: "machines_controllers";
}

export declare const FIELD_CROSSWALK: Readonly<Record<string, CrosswalkEntry>>;
