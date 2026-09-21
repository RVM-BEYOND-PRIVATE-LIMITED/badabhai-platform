import { z } from "zod";

import { ROLES, type RoleId } from "@badabhai/taxonomy";

/**
 * The worker's SECONDARY occupations page (ADR-0042 D9 / Layer A (f), migration 0114).
 *
 * ═══ WHAT THIS OWNS ═══
 *
 * The primary occupation is `worker_profiles.canonical_role_id` and stays there. This page owns
 * the ADDITIONAL `role_*` ids a worker declares — "welding bhi karta hoon" — for display and for
 * supply: `WorkerSkillsService` feeds each id through the SAME `ROLE_TO_MATCH_SKILL` bridge the
 * primary role uses, so the worker derives extra `worker_skill` rows. No new `mskill_*` vocabulary
 * and no new rank key; an id the bridge does not cover is display-only.
 *
 * ═══ THE ID SPACE IS CLOSED, AND IT IS THE TAXONOMY'S ═══
 *
 * `ROLES` in `@badabhai/taxonomy` is the only list — the same 13 ids the profile, the role
 * registry and the Python side already speak. Validating against its ids (never the printed
 * names) is what keeps the DTO, the database row and any future printed label from drifting.
 */
export const OCCUPATIONS_MAX = 4;

/** The closed `role_*` id set, cast once: `z.enum` needs a non-empty tuple of literals. */
const ROLE_IDS = ROLES.map((role) => role.id) as [RoleId, ...RoleId[]];

export const OccupationEntrySchema = z
  .object({
    /** A `role_*` id from {@link ROLES} — never the printed label. */
    role_id: z.enum(ROLE_IDS),
  })
  .strict();

export const SetMyOccupationsSchema = z
  .object({
    /**
     * THE WHOLE LIST, AND IT IS REQUIRED. One surface, so absent and `[]` cannot mean different
     * things — `[]` clears the rows, and a body without the key is a client bug worth a 400
     * (the same contract `PUT /workers/me/languages` states).
     */
    occupations: z.array(OccupationEntrySchema).max(OCCUPATIONS_MAX),
  })
  .strict()
  // A role named twice is two rows the database refuses (`wo_worker_role_uq`) and a duplicated
  // derivation input, so it is refused here first, by name.
  .refine((dto) => new Set(dto.occupations.map((o) => o.role_id)).size === dto.occupations.length, {
    message: "a role may appear only once",
    path: ["occupations"],
  });

export type SetMyOccupationsDto = z.infer<typeof SetMyOccupationsSchema>;
export type OccupationEntryDto = SetMyOccupationsDto["occupations"][number];

/**
 * One stored row as the GET returns it.
 *
 * `label` is READ-ONLY decoration the server resolves from the taxonomy — the app renders it and
 * must NOT echo it into the PUT body: the PUT schema is `.strict()` and accepts `role_id` only,
 * precisely so a client-typed label can never reach the database or a printed surface.
 */
export interface MyOccupationView {
  readonly role_id: RoleId;
  readonly label: string;
}

/**
 * `GET /workers/me/occupations`.
 *
 * `partial`/`dropped_count` mirror the languages response: `role_id` is shape-checked in the
 * database and its membership lives in TypeScript, so a row written by hand or an id retired from
 * the taxonomy can exist, and returning it would make the worker's unedited save a 400. A client
 * must not re-send the list while `partial` is true unless the worker edits it — the PUT replaces
 * the whole list, so the withheld row would be erased.
 */
export interface MyOccupationsResponse {
  readonly occupations: readonly MyOccupationView[];
  readonly partial: boolean;
  readonly dropped_count: number;
}
