import { z } from "zod";

/**
 * Voice toggle on the employer Perks & Details step (payer-app + payer-web share
 * this contract): the poster speaks Hinglish, the service returns professional
 * English for the worker job card, filtered to the posting's trade and role.
 *
 * Description ONLY — benefits and requirements stay manual chips. The returned
 * draft is never stored here; the poster reviews it and the normal create/edit
 * path (with its own write-time screen) persists what they accept.
 */
export const DraftJobDescriptionSchema = z.object({
  /** The poster's own words (Hinglish transcript of the voice note). */
  spoken_text: z.string().min(1).max(2000),
  /** What the posting is for — the relevance filter. Poster-selected free text. */
  trade_label: z.string().max(80).optional(),
  role_label: z.string().max(200).optional(),
});
export type DraftJobDescriptionDto = z.infer<typeof DraftJobDescriptionSchema>;

/** What the toggle fills in: the draft, or null when there is nothing to fill. */
export const JobDescriptionDraftResultSchema = z.object({
  /** The English description, or null to keep the poster's own text. */
  description: z.string().max(2000).nullable(),
  /** True when the far side answered from its mock posture (no real call ran). */
  is_mock: z.boolean(),
});
export type JobDescriptionDraftResult = z.infer<typeof JobDescriptionDraftResultSchema>;
