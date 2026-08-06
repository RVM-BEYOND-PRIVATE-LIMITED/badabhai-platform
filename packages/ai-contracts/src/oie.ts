import { z } from "zod";

import { languageCode } from "./common";
import { JOB_DOMAIN_MATCH_STATUSES } from "./occupation";

// Occupation Intelligence Engine (OIE) — the deterministic-profiling contracts.
//
// These are the types the conversation orchestrator (apps/api, Phase 5), the question-pack
// tooling (packages/db, Phase 4) and the one-shot parse call (ai-service, Phase 7) all code
// against. They were REQUIRED BY PHASE 0 ("contract freeze") and are FROZEN from the moment
// this lands: any later change is a joint PR reviewed by both owners, mirrored in
// apps/ai-service/app/contracts.py AND src/__fixtures__/oie.keys.json in the same commit —
// test_contract_parity.py turns red if one side moves alone.
//
// PRIVACY: nothing here carries identity PII by construction. Answers are RFS profile
// signals; question packs are reviewed static copy; evidence quotes are spans of the
// PSEUDONYMIZED transcript, which is the only transcript the parse call ever sees.

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

/**
 * The deterministic interview's phases, in order. The orchestrator owns every transition;
 * a model never sets this.
 */
export const PROFILING_PHASES = [
  "identify",
  "disambiguate",
  "occupation_specific",
  "universal_tail",
  "close",
] as const;
export type ProfilingPhase = (typeof PROFILING_PHASES)[number];

/**
 * How the retrieval ladder resolved the occupation. Observability, never an input to
 * ranking. Mirrors the `match_layer` column migration 0076 adds to `worker_profiles`.
 */
export const OCCUPATION_MATCH_LAYERS = [
  "l0_exact",
  "l1_skeleton",
  "l2_trigram",
  "l3_vector",
] as const;
export type OccupationMatchLayer = (typeof OCCUPATION_MATCH_LAYERS)[number];

/**
 * The occupation-pin status vocabulary: the existing five job-domain statuses PLUS the two
 * deterministic-engine outcomes migration 0076 adds to the `worker_profiles` CHECK
 * (`matched_lexical` — L0/L1/L2 resolved it with no model and no vector; and
 * `matched_worker_confirmed` — the worker tapped a disambiguation chip, the highest-quality
 * signal in the system). Declared here NOW, ahead of 0076, because this package freezes at
 * Phase 0 and the CHECK expansion must not need a contract change.
 */
export const OCCUPATION_MATCH_STATUSES = [
  ...JOB_DOMAIN_MATCH_STATUSES,
  "matched_lexical",
  "matched_worker_confirmed",
] as const;
export type OccupationMatchStatus = (typeof OCCUPATION_MATCH_STATUSES)[number];

/**
 * The `^[a-z_]+$` ≤40 slug every question_key and field id must satisfy. The SAME filter
 * the event-payload path applies (`slugFieldIds`, chat.service.ts) — a key that fails it
 * would discard a completed interview inside the flush transaction, so it is enforced at
 * the contract instead of discovered there.
 */
const slugKey = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z_]+$/, "must be a lowercase slug ([a-z_]+)");

// ---------------------------------------------------------------------------
// Evidence + the answer map
// ---------------------------------------------------------------------------

/**
 * A literal span of the pseudonymized transcript: `quote` must be a substring of
 * `transcript[message_index].text` after whitespace normalization. The provenance gate —
 * the strongest of the six parse gates, because a hallucinated value has no span to point
 * at — verifies exactly this pair.
 */
export const EvidenceSpanSchema = z.object({
  message_index: z.number().int().nonnegative(),
  quote: z.string().min(1),
});
export type EvidenceSpan = z.infer<typeof EvidenceSpanSchema>;

export const ANSWER_STATUSES = [
  /** A usable value was captured. */
  "answered",
  /** "nahi pata" — a COMPLETE answer: never re-asked, never blocks completion. */
  "declined",
  /** Asked (possibly repeatedly) and never answered; recorded when the engine advances. */
  "unanswered",
  /** A history entry only: this value was replaced by a correction. */
  "superseded",
] as const;
export type AnswerStatus = (typeof ANSWER_STATUSES)[number];

/**
 * A superseded value, kept when a correction overwrites an answer ("nahi, 5 saal nahi
 * 7 saal"). LOAD-BEARING for the parse call: the transcript holds both values, and the
 * history is what tells the LLM which one won — without it the model has to guess.
 */
export const AnswerRecordHistoryEntrySchema = z.object({
  value_raw: z.string().nullable().default(null),
  value_normalized: z.unknown().nullable().default(null),
  status: z.enum(ANSWER_STATUSES).default("superseded"),
  evidence: EvidenceSpanSchema.nullable().default(null),
  /** The turn the superseded value was originally recorded on. */
  turn: z.number().int().nonnegative().default(0),
});
export type AnswerRecordHistoryEntry = z.infer<typeof AnswerRecordHistoryEntrySchema>;

/**
 * One captured answer — the unit of the deterministic answer map, which is the parse
 * call's PRIMARY input (the transcript is only its evidence store).
 *
 * `value_normalized` is written AT CAPTURE TIME by the orchestrator using the lexicon's
 * normalizers, never at parse time. That is what makes the fail-closed path real: when the
 * LLM is down or fails every gate, the answer map alone must still project into a usable
 * profile.
 */
export const AnswerRecordSchema = z.object({
  /** The pack question this answers. Same slug filter as the event-payload path. */
  question_key: slugKey,
  /** The RFS field the answer lands in; null for `target_kind: "none"` questions. */
  target_field: slugKey.nullable().default(null),
  /** The worker's words, verbatim (pseudonymized upstream like all transcript text). */
  value_raw: z.string().nullable().default(null),
  /** The typed value (number/string/bool/string[]), normalized at capture time. */
  value_normalized: z.unknown().nullable().default(null),
  status: z.enum(ANSWER_STATUSES).default("unanswered"),
  evidence: EvidenceSpanSchema.nullable().default(null),
  /** The turn this record was last written on. */
  turn: z.number().int().nonnegative().default(0),
  /** Corrections push the OLD value here, newest first. Never discard an answer. */
  history: z.array(AnswerRecordHistoryEntrySchema).default([]),
});
export type AnswerRecord = z.infer<typeof AnswerRecordSchema>;

// ---------------------------------------------------------------------------
// The occupation pin
// ---------------------------------------------------------------------------

/**
 * The identified occupation, pinned to the conversation the moment retrieval resolves it.
 * `pack_id` + `pack_version` + `catalog_version` are IMMUTABLE for the rest of the
 * conversation (risk #13): a catalogue or pack release mid-interview must never change
 * what a worker is being asked.
 */
export const OccupationPinSchema = z.object({
  job_domain_id: z.string().min(1),
  /** The label shown to the worker — vernacular where one exists, never raw `label_en`. */
  label: z.string().min(1),
  /** Null for `rvm`-minted rows, which have no published ISCO code. */
  isco_unit_code: z.string().nullable().default(null),
  match_status: z.enum(OCCUPATION_MATCH_STATUSES).default("unmatched_degraded"),
  /** The layer's CALIBRATED confidence in [0,1] — never a raw trigram/cosine number. */
  match_score: z.number().nullable().default(null),
  match_layer: z.enum(OCCUPATION_MATCH_LAYERS).nullable().default(null),
  pack_id: z.string().nullable().default(null),
  pack_version: z.number().int().positive().nullable().default(null),
  catalog_version: z.string().nullable().default(null),
});
export type OccupationPin = z.infer<typeof OccupationPinSchema>;

// ---------------------------------------------------------------------------
// The ask_if / skip_if predicate AST
// ---------------------------------------------------------------------------

/**
 * A predicate operand: exactly one of `field` (reads `answers[id].value_normalized` — the
 * ONLY thing the evaluator can read; never raw text, never the transcript, never the
 * clock) or `const` (a literal).
 */
export const PredicateOperandSchema = z
  .object({
    field: slugKey.optional(),
    const: z.unknown().optional(),
  })
  .refine((o) => ("field" in o) !== ("const" in o), {
    message: "an operand is exactly one of {field} or {const}",
  });
export type PredicateOperand = z.infer<typeof PredicateOperandSchema>;

export const PREDICATE_OPS = [
  "all",
  "any",
  "not",
  "answered",
  "declined",
  "eq",
  "neq",
  "in",
  "gte",
  "lte",
  "occupation_is",
  "occupation_under",
  "phase_is",
  "turn_gte",
] as const;
export type PredicateOp = (typeof PREDICATE_OPS)[number];

export interface Predicate {
  op: PredicateOp;
  predicates?: Predicate[];
  predicate?: Predicate;
  field?: string;
  left?: PredicateOperand;
  right?: PredicateOperand;
  job_domain_id?: string;
  isco_code?: string;
  phase?: ProfilingPhase;
  turn?: number;
}

/** Which optional keys each operator REQUIRES. One closed table, no other combination. */
const PREDICATE_ARITY: Record<PredicateOp, ReadonlyArray<keyof Predicate>> = {
  all: ["predicates"],
  any: ["predicates"],
  not: ["predicate"],
  answered: ["field"],
  declined: ["field"],
  eq: ["left", "right"],
  neq: ["left", "right"],
  in: ["left", "right"],
  gte: ["left", "right"],
  lte: ["left", "right"],
  occupation_is: ["job_domain_id"],
  occupation_under: ["isco_code"],
  phase_is: ["phase"],
  turn_gte: ["turn"],
};

/**
 * The `ask_if`/`skip_if` condition — a closed JSON AST, NEVER a string, therefore no
 * expression-parser injection surface. ONE object shape with an `op` discriminant rather
 * than a tagged union, so the Pydantic mirror and the parity fixture have a single stable
 * key list; the refinement below enforces per-op arity (exactly the operator's operand
 * keys, nothing else), and the Phase 4 pack validator re-checks it at boot.
 */
export const PredicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z
    .object({
      op: z.enum(PREDICATE_OPS),
      predicates: z.array(PredicateSchema).optional(),
      predicate: PredicateSchema.optional(),
      field: slugKey.optional(),
      left: PredicateOperandSchema.optional(),
      right: PredicateOperandSchema.optional(),
      job_domain_id: z.string().min(1).optional(),
      isco_code: z.string().min(1).optional(),
      phase: z.enum(PROFILING_PHASES).optional(),
      turn: z.number().int().nonnegative().optional(),
    })
    .superRefine((p, ctx) => {
      const required = PREDICATE_ARITY[p.op];
      const operandKeys: ReadonlyArray<keyof Predicate> = [
        "predicates",
        "predicate",
        "field",
        "left",
        "right",
        "job_domain_id",
        "isco_code",
        "phase",
        "turn",
      ];
      for (const key of required) {
        if (p[key] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `op "${p.op}" requires "${key}"`,
          });
        }
      }
      for (const key of operandKeys) {
        if (p[key] !== undefined && !required.includes(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `op "${p.op}" does not take "${key}"`,
          });
        }
      }
    }),
);

/**
 * The bare object shape behind {@link PredicateSchema}, for the parity test only —
 * `z.lazy` has no `.shape`, and the fixture asserts key lists. Not exported from the
 * barrel.
 */
export const PredicateObjectShapeForParity = z.object({
  op: z.enum(PREDICATE_OPS),
  predicates: z.unknown().optional(),
  predicate: z.unknown().optional(),
  field: z.unknown().optional(),
  left: z.unknown().optional(),
  right: z.unknown().optional(),
  job_domain_id: z.unknown().optional(),
  isco_code: z.unknown().optional(),
  phase: z.unknown().optional(),
  turn: z.unknown().optional(),
});

// ---------------------------------------------------------------------------
// Question packs
// ---------------------------------------------------------------------------

export const QUESTION_TARGET_KINDS = ["rfs", "match_skill", "attribute", "none"] as const;
export type QuestionTargetKind = (typeof QUESTION_TARGET_KINDS)[number];

export const ANSWER_TYPES = ["text", "number", "boolean", "single_select", "multi_select"] as const;
export type AnswerType = (typeof ANSWER_TYPES)[number];

export const QUESTION_PACK_STATUSES = ["draft", "active", "deprecated"] as const;
export type QuestionPackStatus = (typeof QUESTION_PACK_STATUSES)[number];

/**
 * A chip. The label IS the worker's answer of record verbatim when tapped, which is why
 * chips are reviewed static data and never model output.
 */
export const QuestionPackOptionSchema = z.object({
  option_key: slugKey,
  label_text: z.string().min(1),
  /** The typed value the option implies for the target field; null = the label itself. */
  value: z.unknown().nullable().default(null),
  /** Tapping this chip also asserts a skill (closed `skill` vocabulary, `msk_*`/`skill_*`). */
  implies_skill_id: z.string().nullable().default(null),
  is_none_of_above: z.boolean().default(false),
});
export type QuestionPackOption = z.infer<typeof QuestionPackOptionSchema>;

export const QuestionPackItemSchema = z.object({
  /** Stable ACROSS versions — a v2 re-interview answer replaces v1's for the same key. */
  question_key: slugKey,
  prompt_text: z.string().min(1),
  display_order: z.number().int().nonnegative(),
  /** Where the answer goes. A question must declare it, or be explicitly "none". */
  target_kind: z.enum(QUESTION_TARGET_KINDS),
  target_field: slugKey.nullable().default(null),
  target_skill_id: z.string().nullable().default(null),
  answer_type: z.enum(ANSWER_TYPES),
  is_mandatory: z.boolean().default(false),
  is_core: z.boolean().default(false),
  max_asks: z.number().int().positive().default(2),
  /** Momentum vs loss-aversion as DATA: hoist/defer a question without an engine case. */
  min_turn: z.number().int().nonnegative().nullable().default(null),
  max_turn: z.number().int().nonnegative().nullable().default(null),
  ask_if: PredicateSchema.nullable().default(null),
  skip_if: PredicateSchema.nullable().default(null),
  /** Follow-up parent. Depth is 1; the pack validator rejects cycles. */
  parent_item_key: slugKey.nullable().default(null),
  /** Served on the one bounded re-ask; reviewed copy, never generated. */
  retry_text: z.string().nullable().default(null),
  /** Served when the worker asks back ("job milegi?"); then the question is re-served. */
  why_text: z.string().nullable().default(null),
  options: z.array(QuestionPackOptionSchema).default([]),
});
export type QuestionPackItem = z.infer<typeof QuestionPackItemSchema>;

/**
 * A resolved question pack at a PINNED version. Version-scoped and therefore immutable by
 * construction — immutability IS the cache invalidation.
 */
export const QuestionPackSchema = z.object({
  pack_id: z.string().min(1),
  version: z.number().int().positive(),
  family_id: z.string().regex(/^fam_[a-z0-9_]+$/, "family ids are fam_* slugs"),
  locale: languageCode,
  status: z.enum(QUESTION_PACK_STATUSES),
  /** Hash of the reviewed content, for drift detection between corpus and DB. */
  content_hash: z.string().min(1),
  items: z.array(QuestionPackItemSchema).default([]),
});
export type QuestionPack = z.infer<typeof QuestionPackSchema>;

// ---------------------------------------------------------------------------
// POST /profile/parse — THE one LLM call
// ---------------------------------------------------------------------------

/** One line of the indexed evidence store. `i` is what evidence spans point at. */
export const TranscriptLineSchema = z.object({
  i: z.number().int().nonnegative(),
  role: z.enum(["worker", "assistant"]),
  text: z.string(),
});
export type TranscriptLine = z.infer<typeof TranscriptLineSchema>;

/** A field the parse call may fill. Anything outside this closed list is dropped. */
export const TargetFieldSchema = z.object({
  field_id: slugKey,
  /** "string" | "number" | "boolean" | "enum" | "string_array" — validated downstream. */
  type: z.string().min(1),
  /** Closed vocabulary when `type` is "enum". */
  enum: z.array(z.string()).nullable().default(null),
  /** e.g. "inr_per_month", "years". */
  unit: z.string().nullable().default(null),
  required: z.boolean().default(false),
});
export type TargetField = z.infer<typeof TargetFieldSchema>;

/**
 * The parse request. THE FRAMING IS THE ENFORCEMENT: `answer_map` is the record,
 * `transcript` is the evidence store. The model is never asked "what is this worker's
 * salary" — it is asked to type and cite the answer the map already holds, and may add
 * coverage only from `transcript` spans, gated six ways on the far side.
 */
export const ProfileParseInputSchema = z.object({
  schema_version: z.literal("oie.v1").default("oie.v1"),
  /** Pseudonymous worker reference — never a raw worker id. */
  worker_ref: z.string().min(1),
  language: languageCode.optional(),
  occupation: OccupationPinSchema.nullable().default(null),
  /** THE PRIMARY INPUT. */
  answer_map: z.array(AnswerRecordSchema).default([]),
  /** The indexed EVIDENCE store (pseudonymized upstream, per message). */
  transcript: z.array(TranscriptLineSchema).default([]),
  target_fields: z.array(TargetFieldSchema).default([]),
});
export type ProfileParseInput = z.infer<typeof ProfileParseInputSchema>;

export const PARSE_NORMALIZATIONS = [
  "verbatim",
  "spelling",
  "translit",
  "unit",
  "enum",
  "numeric",
] as const;
export type ParseNormalization = (typeof PARSE_NORMALIZATIONS)[number];

/**
 * One parsed field. `evidence` is MANDATORY — a value with no span fails the provenance
 * gate, which is precisely what makes a hallucinated value structurally impossible to
 * persist.
 */
export const ParsedFieldSchema = z.object({
  value: z.unknown(),
  evidence: EvidenceSpanSchema,
  source: z.enum(["answer_map", "transcript"]),
  normalization: z.enum(PARSE_NORMALIZATIONS),
  confidence: z.number().min(0).max(1),
});
export type ParsedField = z.infer<typeof ParsedFieldSchema>;

export const ProfileParseOutputSchema = z.object({
  /** `null` = the model looked and found nothing citable for that field. */
  fields: z.record(z.string(), ParsedFieldSchema.nullable()).default({}),
  unparsed_field_ids: z.array(z.string()).default([]),
  /** PII-free diagnostics ("2 fields dropped by closed-vocabulary gate"), counts + ids. */
  notes: z.array(z.string()).default([]),
});
export type ProfileParseOutput = z.infer<typeof ProfileParseOutputSchema>;
