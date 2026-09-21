/**
 * Résumé import (ADR-0041) — the contract for `POST /resume/parse`.
 *
 * Mirrors `apps/ai-service/app/contracts.py`; `apps/ai-service/tests/test_contract_parity.py`
 * reads this file and fails if the two drift.
 *
 * ── THE ONE PLACE THIS PACKAGE'S OWN RULE IS OVERRIDDEN ──────────────────────────────────
 *
 * `index.ts` says these contracts "never carry raw worker identity (no phone, full name,
 * address, or employer name)". `ResumeEmploymentSchema` below carries an employer name, and
 * that is NOT an oversight — it is the narrow, signed override recorded in
 * `docs/decisions/0041-resume-import-and-prefill.md` §3 (ruling D5, amended 2026-09-10), and
 * ONLY there. It also narrows the owner ruling of 2026-08-28 written into
 * `packages/db/src/schema/employment.ts`, which put employer names on a path that never
 * touches the AI service.
 *
 * Stated here in full because a reader who finds this field while the barrel above says the
 * opposite is supposed to stop — `BUILD_RULES` says code contradicting a signed ruling is a
 * full stop, and a signed ruling is overridden only by another signed ruling. On EVERY OTHER
 * PATH the original rule stands unchanged: an employer name a worker TYPES still goes
 * straight to Postgres and never through this service. Check which route you are on before
 * calling it a defect — exactly one is authorised.
 *
 * WHAT THE OVERRIDE DOES NOT MOVE. §3.3 is explicit: the document may reach the model, but a
 * PAN, an Aadhaar number, a phone or an email must still never reach `worker_attributes`, an
 * event, a log, or the résumé sheet. The far side enforces that with a certifier
 * (`app/resume_import/parse_policy.py`) that is deliberately NOT switchable by the raw-text
 * flag. Nothing in this file may widen that.
 */

import { z } from "zod";

import { RESUME_IMPORT_FAILURES } from "@badabhai/types";

import { AICallMetadataSchema } from "./common";
import { EvidenceSpanSchema, TargetFieldSchema, ParsedFieldSchema } from "./oie";

/** BCP-47-ish locale tag, shape-checked on the far side before it nears a prompt. */
const languageCode = z.string().min(2).max(35);

/**
 * One citable line of the uploaded document.
 *
 * `i` is the stable index the extractor assigned and is what the model cites. It is
 * PRESERVED across masking drops and never renumbered — renumbering after a drop would
 * silently re-point every citation at a different line.
 */
export const ResumeLineSchema = z.object({
  i: z.number().int().nonnegative(),
  text: z.string().min(1),
});
export type ResumeLine = z.infer<typeof ResumeLineSchema>;

/**
 * Parse an uploaded résumé into typed, cited values.
 *
 * NO ANSWER MAP, and that is the shape of the feature rather than an omission: this call
 * happens BEFORE the interview, so there is no recorded answer to type or to disagree with.
 * Precedence between a résumé suggestion and an answer the worker later gives belongs to
 * RI-4's staging layer (ruling D7 — a stored answer always wins), not to this contract.
 *
 * THE API SENDS A KEY, NOT THE DOCUMENT. The ai-service fetches and extracts the object
 * itself, so the résumé is never transported to the API. The extraction libraries live over
 * there; sending bytes would buy nothing and widen the blast radius.
 *
 * THE RESPONSE IS A DIFFERENT MATTER, and an earlier version of this docblock glossed it.
 * Every accepted field carries an `evidence.quote` — a literal span of the document — and
 * every such span is certified against the hard-identifier wall on BOTH sides before it can
 * reach a caller. Document text does cross; uncertified document text does not.
 */
export const ResumeParseInputSchema = z.object({
  schema_version: z.literal("resume.v1").default("resume.v1"),
  /**
   * The reference the far side attributes SPEND to, and the Langfuse user dimension.
   *
   * IN PRACTICE THIS IS THE WORKER'S UUID, like every other caller in this repo
   * (`profile-extraction.processor.ts`, `llm-turn.service.ts`, `work-history-polish.service.ts`,
   * `voice-transcription.service.ts`). An earlier version of this comment said "never a raw
   * worker id", which the only caller contradicted on the same branch — a docstring nobody can
   * act on is worse than none. A UUID identifies a row in our database and nothing about a
   * person; what makes it safe is that it travels with no name, phone or document beside it.
   */
  worker_ref: z.string().min(1),
  /** The private-bucket object key minted by `POST /profiling/resume-import/upload-url`. */
  storage_key: z.string().min(1),
  mime: z.string().min(1),
  target_fields: z.array(TargetFieldSchema).default([]),
  /**
   * Task 1 B2 — the CLOSED trade-kind ids the model may return in
   * `trade_association.kind` (the 21 `TRADE_FORM_KINDS_ALL`, supplied by
   * apps/api, the single source of truth). Rendered into the prompt verbatim;
   * the far side shape-checks each entry before it nears the prompt.
   *
   * `max(32)` mirrors `contracts.py`'s `max_length=32` — a bound on the list,
   * not on each id (the far side caps entry length at render time).
   */
  trade_kinds: z.array(z.string()).max(32).default([]),
  language: languageCode.optional(),
});
export type ResumeParseInput = z.infer<typeof ResumeParseInputSchema>;

/**
 * One job read off the résumé, with the line it was read from.
 *
 * `employer_name` is the field the §3 override exists to permit. Everything about it is
 * gated the way a scalar field is — cited, shape-checked, and refused outright if it carries
 * a hard identifier — so "permitted" means "permitted through the wall", never "waved past
 * it". A row that cites nothing is dropped on the far side and can never arrive here.
 */
export const ResumeEmploymentSchema = z.object({
  employer_name: z.string().nullable().default(null),
  role_title: z.string().nullable().default(null),
  start_year: z.number().int().min(1950).max(2100).nullable().default(null),
  end_year: z.number().int().min(1950).max(2100).nullable().default(null),
  evidence: EvidenceSpanSchema,
});
export type ResumeEmployment = z.infer<typeof ResumeEmploymentSchema>;

/**
 * Task 1 B2 — the model's closed-vocabulary answer to "which trade is this
 * résumé" (mirrors `TradeAssociation` in `apps/ai-service/app/contracts.py`;
 * `test_contract_parity.py` covers the surrounding contract).
 *
 * `kind` stays an OPEN string here, narrowed by the second wall
 * (`ResumeParseService`) against `TRADE_FORM_KINDS_ALL` — the same posture as
 * `extraction_method`, for the same reason: the contract transports, the wall
 * decides. `null` = no judgment (model said none, said it unparseably, or was
 * never given kinds).
 */
export const TradeAssociationSchema = z.object({
  kind: z.string().nullable().default(null),
});
export type TradeAssociation = z.infer<typeof TradeAssociationSchema>;

/**
 * Résumé profile summary (RI-summary, backend-only slice).
 *
 * A SEPARATE second LLM call after `/resume/parse`, not an extension of it.
 * The parse reads citable values; this call reads the same document for one
 * worker-facing Hinglish line: {Job Role} + {total experience} + {short summary}.
 *
 * PRIVACY: inputs carry a storage KEY, never the document. Outputs carry no
 * identity — no name, phone, address, employer, PAN/Aadhaar — only a closed-set
 * role id and two short Hinglish strings. The far side certifies both strings
 * with the same hard-identifier wall as the parse (`resume_value_certifier`);
 * anything carrying an identifier degrades to null, never to a stored row.
 *
 * `role_kind` stays an OPEN string here and is narrowed by the second wall
 * (`ResumeSummaryService`) against the caller-supplied `role_kinds` — the same
 * posture as `trade_association.kind` and `extraction_method`: the contract
 * transports, the wall decides. `null` = no judgment (none fits / vague /
 * mixed trades).
 */
export const ResumeSummaryInputSchema = z.object({
  schema_version: z.literal("resume.v1").default("resume.v1"),
  /**
   * Pseudonymous spend attribution + Langfuse user dimension (a UUID, never a
   * name/phone). Same contract as `ResumeParseInput.worker_ref`.
   */
  worker_ref: z.string().min(1),
  /** The private-bucket object key minted by `POST /profiling/resume-import/upload-url`. */
  storage_key: z.string().min(1),
  mime: z.string().min(1),
  /**
   * The CLOSED role ids the model may return in `role_kind` — the ENABLED form
   * kinds (9 today), supplied by apps/api, the single source of truth.
   * Rendered into the prompt verbatim; the far side shape-checks each entry.
   */
  role_kinds: z.array(z.string()).max(32).default([]),
  language: languageCode.optional(),
});
export type ResumeSummaryInput = z.infer<typeof ResumeSummaryInputSchema>;

/**
 * One pack question the option-mapping call may answer, with its closed options.
 *
 * Caller-controlled reviewed copy (pack question + option keys/labels), never worker
 * input — so it is rendered into the prompt verbatim, bounded in count. The model
 * selects among these ids; the gates drop anything else.
 */
export const ResumeMapQuestionSchema = z.object({
  question_key: z.string().min(1).max(40),
  answer_type: z.enum(["single_select", "multi_select"]),
  options: z
    .array(
      z.object({
        option_key: z.string().min(1).max(40),
        label_text: z.string().min(1).max(200),
      }),
    )
    .max(32),
});
export type ResumeMapQuestion = z.infer<typeof ResumeMapQuestionSchema>;

/**
 * Map an uploaded résumé onto pack option keys (RI-autofill, owner override B).
 *
 * A SEPARATE call after `/resume/parse`, run at import time for form-routed workers.
 * The parse reads citable VALUES; this call answers one question per pack item: which
 * of THESE option ids does the document support. Same fetch-extract-mask-call-gate
 * pipeline, same document, different contract.
 *
 * PRIVACY: inputs carry a storage KEY plus caller-owned pack copy, never the document.
 * Outputs carry closed option ids plus certified spans — never identity.
 */
export const ResumeOptionMapInputSchema = z.object({
  schema_version: z.literal("resume.v1").default("resume.v1"),
  worker_ref: z.string().min(1),
  /** The private-bucket object key minted by `POST /profiling/resume-import/upload-url`. */
  storage_key: z.string().min(1),
  mime: z.string().min(1),
  /** The pack's option questions — at most one mapping each comes back. */
  questions: z.array(ResumeMapQuestionSchema).max(40).default([]),
  language: languageCode.optional(),
});
export type ResumeOptionMapInput = z.infer<typeof ResumeOptionMapInputSchema>;

export const ResumeOptionMappingSchema = z.object({
  question_key: z.string().min(1).max(40),
  option_keys: z.array(z.string().min(1).max(40)).max(32).default([]),
  evidence: EvidenceSpanSchema,
});
export type ResumeOptionMapping = z.infer<typeof ResumeOptionMappingSchema>;

export const ResumeOptionMapOutputSchema = z.object({
  /** One entry per question the model could cite — never more than asked. */
  mappings: z.array(ResumeOptionMappingSchema).default([]),
  /** Closed vocabulary (`RESUME_IMPORT_FAILURES`), else null. Never model text. */
  failure_reason: z.enum(RESUME_IMPORT_FAILURES).nullable().default(null),
  /** PII-free diagnostics from a CLOSED vocabulary — counts and codes, never model text. */
  notes: z.array(z.string()).default([]),
  /** `null` on every degraded path: a fabricated zero-cost record is worse than an absent one. */
  ai_metadata: AICallMetadataSchema.nullable().default(null),
});
export type ResumeOptionMapOutput = z.infer<typeof ResumeOptionMapOutputSchema>;

export const ResumeSummaryOutputSchema = z.object({
  /** One id from the request's `role_kinds`, or null when none fits. */
  role_kind: z.string().nullable().default(null),
  /** Hinglish duration, e.g. "5 saal ka tajurba" or "Fresher". Bounded, PII-free. */
  experience_text: z.string().max(120).nullable().default(null),
  /** Hinglish 1-2 line worker summary. Bounded, PII-free, no identifiers. */
  summary_text: z.string().max(500).nullable().default(null),
  /** Closed vocabulary (`RESUME_IMPORT_FAILURES`), else null. Never model text. */
  failure_reason: z.enum(RESUME_IMPORT_FAILURES).nullable().default(null),
  /** PII-free diagnostics from a CLOSED vocabulary — counts and codes, never model text. */
  notes: z.array(z.string()).default([]),
  /** `null` on every degraded path: a fabricated zero-cost record is worse than an absent one. */
  ai_metadata: AICallMetadataSchema.nullable().default(null),
});
export type ResumeSummaryOutput = z.infer<typeof ResumeSummaryOutputSchema>;

/**
 * What survived both walls, plus how the text was recovered.
 *
 * The extraction facts ride on the response because `worker_resume_import` stores them and
 * this process never sees the document — so this is the only place they can come from. They
 * are counts and a score, never text.
 */
export const ResumeParseOutputSchema = z.object({
  /** `null` = the model looked and found nothing citable for that field. */
  fields: z.record(z.string(), ParsedFieldSchema.nullable()).default({}),
  employments: z.array(ResumeEmploymentSchema).default([]),
  trade_association: TradeAssociationSchema.nullable().default(null),
  unparsed_field_ids: z.array(z.string()).default([]),
  /** PII-free diagnostics from a CLOSED vocabulary — counts and codes, never model text. */
  notes: z.array(z.string()).default([]),

  /** `pdf_text` | `docx` | `ocr`, or null when extraction never got that far. */
  extraction_method: z.string().nullable().default(null),
  page_count: z.number().int().positive().nullable().default(null),
  /** 0..1, and only ever set when `extraction_method` is `ocr`. */
  ocr_confidence: z.number().min(0).max(1).nullable().default(null),
  line_count: z.number().int().nonnegative().default(0),

  /**
   * A value from `RESUME_IMPORT_FAILURES` (`@badabhai/types`) when nothing usable came back,
   * else null. Closed vocabulary, because the reason is BOTH shown to the worker (ruling D9)
   * and counted on an event — an open string here would be untrusted text on a screen and a
   * PII leak into analytics at once.
   *
   * `z.enum` RATHER THAN `z.string()`, AND THE DIFFERENCE IS NOT COSMETIC. `ResumeParseService`
   * writes this to `worker_resume_import.failure_reason` — a plain `text` column whose CHECK is
   * a presence biconditional and not a vocabulary — BEFORE the event schema would have
   * validated it. With an open string, a far-side bug putting free text here persisted it to
   * the database and showed it to the worker, and only THEN threw on the event. Closing it at
   * the transport boundary means the bad value never becomes a row.
   */
  failure_reason: z.enum(RESUME_IMPORT_FAILURES).nullable().default(null),

  /** `null` on every degraded path: a fabricated zero-cost record is worse than an absent one. */
  ai_metadata: AICallMetadataSchema.nullable().default(null),
});
export type ResumeParseOutput = z.infer<typeof ResumeParseOutputSchema>;
