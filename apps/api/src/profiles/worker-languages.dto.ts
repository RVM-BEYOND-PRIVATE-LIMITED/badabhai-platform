import { z } from "zod";

import { LANGUAGES } from "./worker-preferences.vocabulary";
import { optionsOf } from "./worker-qualifications.dto";

/**
 * The finishing form's LANGUAGES page — how the worker knows each language they listed.
 *
 * ═══ WHY THIS IS ITS OWN ENDPOINT AND NOT A WIDER `languages` ATTRIBUTE ═══
 *
 * `worker_attributes.languages` is a `text_list` of slugs, one row per worker. It answers "which
 * languages?" and nothing else, and it is the ONLY source the résumé's Languages row has ever
 * had. This endpoint owns a table of rows — one per language, three independent ticks — because
 * the schema's `(worker_id, language)` uniqueness and delete-then-insert replace shape is the
 * same repeatable-ordered-row pattern `PUT /workers/me/qualifications` already implements.
 * Folding it into `SetMyPreferencesSchema` would put repeated rows behind a `(worker_id,
 * attribute_key)` upsert that holds exactly one list.
 *
 * ═══ THE ATTRIBUTE KEEPS BEING WRITTEN AND READ ═══
 *
 * Migration 0110 commits to this in writing, exactly as 0098 did for the `education_*` keys: the
 * finishing form's multi-select keeps writing `languages`, the sheet keeps reading it, and this
 * table is a SECOND source that wins where it has rows. A worker who never opens this page
 * renders exactly as they do today — no cutover, no backfill, no client required to move.
 *
 * ═══ THE SLUG IS THE SAME CLOSED SET THE MULTI-SELECT OFFERS ═══
 *
 * `LANGUAGES` is the one dictionary: 16 slugs, regional languages first-class. Validating against
 * its keys (through the shared `optionsOf`) is what keeps the option list, the database row and
 * the printed label from drifting apart — the exact failure `trade-resume-map.ts` documents.
 */

/** How many languages one submission may carry. The dictionary itself holds 16. */
export const LANGUAGES_MAX = 16;

/**
 * One language and the three abilities, each an independent tick.
 *
 * `can_speak` IS NOT IMPLIED BY THE OTHER TWO, and vice versa: a worker who reads English
 * manuals but does not speak English is a real and common case, and a ladder would have to lose
 * him. The refinement refuses a row that ticks none — a row that says nothing is a blank line on
 * the sheet, and `wl_ability_chk` refuses to store one anyway; rejecting at the boundary names
 * the field rather than the constraint.
 */
const LanguageEntrySchema = z
  .object({
    /** A slug from {@link LANGUAGES} — never the printed label. */
    language: z.enum(optionsOf(LANGUAGES)),
    can_speak: z.boolean().default(false),
    can_read: z.boolean().default(false),
    can_write: z.boolean().default(false),
  })
  .strict()
  .refine((e) => e.can_speak || e.can_read || e.can_write, {
    message: "a language entry must tick at least one of can_speak / can_read / can_write",
    path: ["can_speak"],
  });

export const SetMyLanguagesSchema = z
  .object({
    /**
     * THE WHOLE LIST, AND IT IS REQUIRED. Unlike the qualifications page there is one surface
     * here, so absent and `[]` cannot mean different things — `[]` clears the rows, and a body
     * without the key is a client bug worth a 400 rather than a silent no-op.
     */
    languages: z.array(LanguageEntrySchema).max(LANGUAGES_MAX),
  })
  .strict()
  // A language named twice is two rows the database refuses (`wl_worker_language_uq`) and one
  // duplicated printed segment, so it is refused here first, by name.
  .refine((dto) => new Set(dto.languages.map((l) => l.language)).size === dto.languages.length, {
    message: "a language may appear only once",
    path: ["languages"],
  });

export type SetMyLanguagesDto = z.infer<typeof SetMyLanguagesSchema>;
export type LanguageEntryDto = NonNullable<SetMyLanguagesDto["languages"]>[number];

/**
 * `GET /workers/me/languages` — the PUT's own entry shapes, so the body round-trips.
 *
 * A STORED ROW THAT NO LONGER PARSES IS WITHHELD AND COUNTED, never returned: the slug column is
 * plain text with no membership CHECK (the dictionary lives in TypeScript), so a hand-written row
 * or a retired slug can exist, and returning it would make the worker's unedited save a 400. A
 * client must not re-send the list while `partial` is true unless the worker edits it — the PUT
 * replaces the whole list, so the withheld row would be erased.
 */
export interface MyLanguagesResponse {
  readonly languages: readonly LanguageEntryDto[];
  readonly partial: boolean;
  readonly dropped_count: number;
}
