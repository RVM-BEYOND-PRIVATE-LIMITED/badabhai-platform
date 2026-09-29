/**
 * Chat companion v2 — the LLM task router (ADR-0046 Phase 1).
 *
 * Mirrors `apps/ai-service/app/contracts.py`; `apps/ai-service/tests/test_contract_parity.py`
 * reads this file's golden fixture and fails if the two drift. Two endpoints:
 * `POST /companion/classify` (one free-text message -> one closed intent) and
 * `POST /companion/edit-parse` (one message + the API's closed catalogue and a snapshot of
 * the worker's current values -> typed edit rows).
 *
 * PRIVACY: `text` is worker free text and the AI-service endpoint pseudonymizes it
 * FAIL-CLOSED before `AIRouter`. The model's output is UNTRUSTED: the API re-validates every
 * row deterministically (catalogue, op, ref, the section writer's DTO, placeholder token,
 * no-op) and nothing is written before the worker taps Haan (ADR-0046 O4). No field here can
 * hold a name, a phone or an ID number.
 *
 * The closed sets come from `@badabhai/types` (`COMPANION_V2_INTENTS`,
 * `COMPANION_V2_EDIT_SECTIONS`, `COMPANION_V2_EDIT_OPS`, `COMPANION_V2_UNSUPPORTED_EDIT_TARGETS`),
 * the same source the API's catalogue and the event spine read — one list, three consumers.
 */

import { z } from "zod";

import {
  COMPANION_V2_EDIT_OPS,
  COMPANION_V2_EDIT_SECTIONS,
  COMPANION_V2_INTENTS,
  COMPANION_V2_UNSUPPORTED_EDIT_TARGETS,
} from "@badabhai/types";

// Bounds that are NOT vocabularies. Kept beside the schemas so the Pydantic mirror and the
// parity suite have one place to compare; the parity test pins the caps by behaviour.
const TEXT_MAX_CLASSIFY = 1000;
const TEXT_MAX_MESSAGE = 4000;
const FIELD_MAX = 64;
const REF_MAX = 16;
const CATALOGUE_MAX = 64;
const SNAPSHOT_MAX = 64;
const MAX_ROWS_MAX = 10;

/** One pseudonymized memory turn (O13) — Redis only, never Postgres. */
export const CompanionRecentTurnSchema = z.object({
  role: z.enum(["worker", "bada_bhai"]),
  text: z.string().min(1).max(TEXT_MAX_CLASSIFY),
});
export type CompanionRecentTurn = z.infer<typeof CompanionRecentTurnSchema>;

/**
 * One field the API allows the model to name (owner ruling 2026-09-29).
 *
 * `field` is a LOGICAL name (e.g. `expected_salary`); the API maps it to its writer's DTO key
 * itself. `ops` is the legal subset for this field — `add` is offered only where one field
 * defines the entry (skills, languages, occupations), so employment and qualifications are
 * edit/delete-only in chat. The catalogue is API-authored constants; no worker text is ever
 * in it.
 */
export const EditableFieldSchema = z.object({
  section: z.enum(COMPANION_V2_EDIT_SECTIONS),
  field: z.string().min(1).max(FIELD_MAX),
  ops: z.array(z.enum(COMPANION_V2_EDIT_OPS)).min(1).max(3),
});
export type EditableField = z.infer<typeof EditableFieldSchema>;

/**
 * One current row the model may edit or delete, by opaque short ref.
 *
 * `ref` is minted by the API per request ("e1", "q2"); it is never a DB id and never
 * derivable from the worker's text. `fields` carries the current value per catalogue field,
 * null where the worker has nothing stored.
 */
export const CompanionEditSnapshotRowSchema = z.object({
  ref: z.string().min(1).max(REF_MAX),
  section: z.enum(COMPANION_V2_EDIT_SECTIONS),
  fields: z.record(z.string(), z.string().nullable()),
});
export type CompanionEditSnapshotRow = z.infer<typeof CompanionEditSnapshotRowSchema>;

/** One proposed change. Validated deterministically by the API before use. */
export const CompanionEditRowSchema = z.object({
  op: z.enum(COMPANION_V2_EDIT_OPS),
  section: z.enum(COMPANION_V2_EDIT_SECTIONS),
  /** Required for edit/delete; null for add (there is no row yet). */
  ref: z.string().min(1).max(REF_MAX).nullable().default(null),
  /** Required for edit; must be one of the catalogue's fields for the section. */
  field: z.string().min(1).max(FIELD_MAX).nullable().default(null),
  /** Required for add/edit. A value carrying a placeholder token is dropped (O17). */
  value: z.string().max(TEXT_MAX_MESSAGE).nullable().default(null),
});
export type CompanionEditRow = z.infer<typeof CompanionEditRowSchema>;

/** One free-text companion message to classify, with at most two memory turns. */
export const CompanionClassifyInputSchema = z.object({
  text: z.string().min(1).max(TEXT_MAX_CLASSIFY),
  recent_turns: z.array(CompanionRecentTurnSchema).max(2).default([]),
});
export type CompanionClassifyInput = z.infer<typeof CompanionClassifyInputSchema>;

/**
 * The classifier's closed intent plus its confidence and the block flag.
 *
 * `blocked` is the pseudonymizer's fail-closed refusal (the API treats it, a schema miss, a
 * timeout or a null exactly alike: `unclear`).
 */
export const CompanionClassifyOutputSchema = z.object({
  intent: z.enum(COMPANION_V2_INTENTS),
  confidence: z.number().min(0).max(1),
  blocked: z.boolean().default(false),
});
export type CompanionClassifyOutput = z.infer<typeof CompanionClassifyOutputSchema>;

/**
 * One message plus the API's closed catalogue and current-value snapshot.
 *
 * `text` is capped at the companion message DTO's own bound (4000), so this contract can
 * never reject a message the API accepted.
 */
export const CompanionEditParseInputSchema = z.object({
  text: z.string().min(1).max(TEXT_MAX_MESSAGE),
  catalogue: z.array(EditableFieldSchema).max(CATALOGUE_MAX).default([]),
  snapshot: z.array(CompanionEditSnapshotRowSchema).max(SNAPSHOT_MAX).default([]),
  max_rows: z.number().int().min(1).max(MAX_ROWS_MAX),
});
export type CompanionEditParseInput = z.infer<typeof CompanionEditParseInputSchema>;

/**
 * Typed edit rows (0..max_rows) plus the closed unsupported reasons.
 *
 * NOTHING here is applied by the model: every row is re-validated by the API and a card is
 * only written after the worker taps Haan (ADR-0046 O4).
 */
export const CompanionEditParseOutputSchema = z.object({
  rows: z.array(CompanionEditRowSchema).default([]),
  unsupported: z.array(z.enum(COMPANION_V2_UNSUPPORTED_EDIT_TARGETS)).default([]),
});
export type CompanionEditParseOutput = z.infer<typeof CompanionEditParseOutputSchema>;
