import { z } from "zod";

/**
 * THE TRADE-SPECIFIC POSTING FORM BOUNDARY (owner ruling 2026-11-03).
 *
 * These schemas check SHAPE only. Closed-set membership is checked by
 * `PostingTradesService` against the role's checked-in question pack, because the pack is
 * where the vocabulary lives and a Zod enum here would be a second copy to keep in sync.
 *
 * Both fields are optional and NULLABLE-IN-EFFECT: omitted/`null` means "this poster did not
 * use the trade form", which is every client that has not adopted it. An EMPTY OBJECT is a
 * different, legitimate value — "the poster opened the trade form and selected no chips" —
 * and it still derives the role's base match skill.
 */
const slug = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[a-z][a-z0-9_]*$/, "not a slug key");

/** One ladder rung key (`setter`, `senior_inspector`, …). */
export const tradeLevelSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/, "not a trade level key");

/**
 * `{ "<question_key>": ["<option_key>", …] }`.
 *
 * Bounded for request safety: 40 questions x 20 options is far beyond any real pack, so a
 * body that trips this is abuse rather than a large selection. The service also caps each
 * single-select question at one option.
 */
export const tradeAnswersSchema = z
  .record(slug, z.array(slug).max(20))
  .refine((value) => Object.keys(value).length <= 40, {
    message: "too many posting fields",
  });
