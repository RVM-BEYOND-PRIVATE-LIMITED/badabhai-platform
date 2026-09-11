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
 * itself, so the résumé's text never passes through this process, its logs or its error
 * paths. The extraction libraries live over there; sending bytes would buy nothing and widen
 * the blast radius.
 */
export const ResumeParseInputSchema = z.object({
  schema_version: z.literal("resume.v1").default("resume.v1"),
  /** Pseudonymous worker reference — never a raw worker id. */
  worker_ref: z.string().min(1),
  /** The private-bucket object key minted by `POST /profiling/resume-import/upload-url`. */
  storage_key: z.string().min(1),
  mime: z.string().min(1),
  target_fields: z.array(TargetFieldSchema).default([]),
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
   */
  failure_reason: z.string().nullable().default(null),

  /** `null` on every degraded path: a fabricated zero-cost record is worse than an absent one. */
  ai_metadata: AICallMetadataSchema.nullable().default(null),
});
export type ResumeParseOutput = z.infer<typeof ResumeParseOutputSchema>;
