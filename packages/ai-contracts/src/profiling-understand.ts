/**
 * The profiling turn's understanding (ADR-0057, #2309): `POST /profiling/understand`.
 *
 * One call per TYPED profiling-chat message. The API sends the message, the last few turns, the
 * question on screen, the session's whole profiling schema (every in-scope field, its current
 * value and its status) and the progress; the model answers with what the message is doing (one
 * closed intent), every value the worker volunteered for a field (`fills`), every change asked of
 * an already-filled field (`edits`), and the page-owned facts it merely mentioned.
 *
 * Mirrors `apps/ai-service/app/contracts.py`; both suites assert against the golden fixture
 * `__fixtures__/profiling-understand.keys.json`. The closed sets come from `@badabhai/types`, the
 * same source the API's handlers and the event spine read.
 *
 * AI NEVER DECIDES (CLAUDE.md §3). The output is UNTRUSTED: the API re-validates every key, ref
 * and value against its own catalogue and parsers, fills only empty fields, and changes or deletes
 * a filled one only after the worker's Haan (ADR-0057 R4/R5). Nothing here is applied by the model.
 *
 * PRIVACY: `text`, the turns and every schema value are worker data; the API redacts the worker's
 * own name first (G2) and never puts a name in the schema, the AI service applies the masking
 * policy in force (ADR-0047), and every value the model returns passes the G1 output floor.
 *
 * `schema_rows`, NOT `schema`: on the Pydantic side a field named `schema` shadows a `BaseModel`
 * attribute, so the mirror would need an alias, and an alias is a second spelling of one key.
 */

import { z } from "zod";

import {
  PROFILING_EDIT_OPS,
  PROFILING_FIELD_KINDS,
  PROFILING_FIELD_STATUSES,
  PROFILING_TURN_INTENTS,
} from "@badabhai/types";

import { AICallMetadataSchema } from "./common";
import { CompanionRecentTurnSchema } from "./companion";

/** The bound on one schema key — a catalogue key, API-authored. */
const KEY_MAX = 64;
/** The bound on one value the model reads or writes. */
const VALUE_MAX = 500;
/** The bound on one entry ref, minted by the API per request ("x1", "s2"). Never a DB id. */
const REF_MAX = 16;

/** One entry of a `list` field (a skill, a job), addressed by its per-request ref. */
export const ProfilingSchemaEntrySchema = z.object({
  ref: z.string().min(1).max(REF_MAX),
  value: z.string().min(1).max(VALUE_MAX),
});
export type ProfilingSchemaEntry = z.infer<typeof ProfilingSchemaEntrySchema>;

/**
 * One in-scope field of the session's schema, as the model is shown it.
 *
 * `value` is the current value as display text, null when there is none (or a `list` field, whose
 * values are its `entries`). `options` are the labels a select field accepts, so the model writes
 * one the API's parser can read; empty for every other kind. `label` is API-authored copy.
 */
export const ProfilingSchemaRowSchema = z.object({
  key: z.string().min(1).max(KEY_MAX),
  label: z.string().min(1).max(80),
  kind: z.enum(PROFILING_FIELD_KINDS),
  options: z.array(z.string().min(1).max(80)).max(40).default([]),
  value: z.string().max(VALUE_MAX).nullable().default(null),
  status: z.enum(PROFILING_FIELD_STATUSES),
  entries: z.array(ProfilingSchemaEntrySchema).max(20).default([]),
});
export type ProfilingSchemaRow = z.infer<typeof ProfilingSchemaRowSchema>;

/** The question on screen: its schema key (null for a model-written question) and its words. */
export const ProfilingOnScreenSchema = z.object({
  key: z.string().min(1).max(KEY_MAX).nullable().default(null),
  text: z.string().min(1).max(VALUE_MAX),
  options: z.array(z.string().min(1).max(80)).max(20).default([]),
});
export type ProfilingOnScreen = z.infer<typeof ProfilingOnScreenSchema>;

/** The session's progress — the same numbers the chat's progress bar carries. */
export const ProfilingProgressSchema = z.object({
  answered: z.number().int().min(0),
  total: z.number().int().min(0),
});
export type ProfilingProgress = z.infer<typeof ProfilingProgressSchema>;

/**
 * The request. `text` is capped at the chat message DTO's own bound (4000), so this contract can
 * never reject a message the API accepted. `page_owned` names the facts the Profile pages own
 * (ADR-0057 R2) — by name only, never with a value — so the model can say it heard one.
 */
export const ProfilingTurnUnderstandInputSchema = z.object({
  text: z.string().min(1).max(4000),
  recent_turns: z.array(CompanionRecentTurnSchema).max(6).default([]),
  on_screen: ProfilingOnScreenSchema.nullable().default(null),
  schema_rows: z.array(ProfilingSchemaRowSchema).max(64),
  page_owned: z.array(z.string().min(1).max(KEY_MAX)).max(16).default([]),
  progress: ProfilingProgressSchema.nullable().default(null),
});
export type ProfilingTurnUnderstandInput = z.infer<typeof ProfilingTurnUnderstandInputSchema>;

/** A value the worker volunteered for a field — for a `list` field, one new entry. */
export const ProfilingFillSchema = z.object({
  key: z.string().min(1).max(KEY_MAX),
  value: z.string().min(1).max(VALUE_MAX),
});
export type ProfilingFill = z.infer<typeof ProfilingFillSchema>;

/**
 * A change asked of an already-filled field. `ref` names the entry of a `list` field and is null
 * for every other kind. `value` is the new value for an `edit` — null when the worker said the old
 * one is wrong without giving the new one (the API then asks) — and always null for a `delete`.
 */
export const ProfilingEditSchema = z.object({
  op: z.enum(PROFILING_EDIT_OPS),
  key: z.string().min(1).max(KEY_MAX),
  ref: z.string().min(1).max(REF_MAX).nullable().default(null),
  value: z.string().min(1).max(VALUE_MAX).nullable().default(null),
});
export type ProfilingEdit = z.infer<typeof ProfilingEditSchema>;

/**
 * The response. Every list is already contained to the request (keys from `schema_rows`, refs from
 * the addressed row's entries, mentions from `page_owned`) and every value has passed the G1 floor
 * — belt; the API checks all of it again. `blocked` is the masking gateway's fail-closed refusal,
 * which the API treats like a timeout or a mock: today's pipeline runs the turn (ADR-0057 §3.6).
 */
export const ProfilingTurnUnderstandOutputSchema = z.object({
  intent: z.enum(PROFILING_TURN_INTENTS).default("unclear"),
  confidence: z.number().min(0).max(1).default(0),
  fills: z.array(ProfilingFillSchema).max(20).default([]),
  edits: z.array(ProfilingEditSchema).max(10).default([]),
  page_owned_mentions: z.array(z.string().min(1).max(KEY_MAX)).max(16).default([]),
  blocked: z.boolean().default(false),
  /** Per-call cost/token metadata; null when no provider was reached (the cost recorder no-ops). */
  ai_metadata: AICallMetadataSchema.nullable().default(null),
});
export type ProfilingTurnUnderstandOutput = z.infer<typeof ProfilingTurnUnderstandOutputSchema>;
