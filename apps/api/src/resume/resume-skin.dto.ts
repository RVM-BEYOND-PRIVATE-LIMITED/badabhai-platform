import { z } from "zod";

import { RESUME_SKINS } from "@badabhai/types";

/**
 * RÉSUMÉ SKINS (#1801) — the wire contract of `GET /resume/skin` and `PUT /resume/skin`.
 *
 * DATA, NOT COPY. Skin names, swatches and the live preview are the app's; the server serves what
 * only it knows — whether skins are on, the skin the worker's sheet prints in, and the closed list
 * they may choose from. The skin id is the closed `RESUME_SKINS` vocabulary (`neela` alone today).
 */

const SkinSchema = z.enum(RESUME_SKINS);

export const ResumeSkinStateResponse = z.object({
  /**
   * `RESUME_SKINS_ENABLED`. False: show no picker — `skin` is then null and `skins` empty, and the
   * sheet prints exactly as it always has.
   */
  enabled: z.boolean(),
  /**
   * The skin their `bb_trade` sheet prints in: their choice, or the house default (`neela`) when they
   * have never chosen. Null only while `enabled` is false.
   */
  skin: SkinSchema.nullable(),
  /** Every skin they may choose, in display order. Empty while `enabled` is false. */
  skins: z.array(SkinSchema),
});
export type ResumeSkinStateResponse = z.infer<typeof ResumeSkinStateResponse>;

/**
 * One confirmed choice (never a preview tap — previews are client-side). `.strict()`, so a
 * `worker_id` or anything else in the body is a 400: the worker is the session's, never the body's.
 */
export const SetResumeSkinSchema = z.object({ skin: SkinSchema }).strict();
export type SetResumeSkinDto = z.infer<typeof SetResumeSkinSchema>;

export const SetResumeSkinResponse = z.object({
  skin: SkinSchema,
  /** The skin they had CHOSEN before this call; null when they had never chosen (house default). */
  previous_skin: SkinSchema.nullable(),
  /**
   * `changed` — persisted, `resume.skin_changed` emitted, and their latest résumé queued for a
   * re-render. `unchanged` — the skin they already hold (a retried tap): nothing written, no event.
   */
  change: z.enum(["changed", "unchanged"]),
});
export type SetResumeSkinResponse = z.infer<typeof SetResumeSkinResponse>;
