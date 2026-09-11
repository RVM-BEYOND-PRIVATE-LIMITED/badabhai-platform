import { z } from "zod";

/**
 * The attribute keys a worker may choose the printed text for (#1485).
 *
 * AN ALLOW-LIST, NOT A SHAPE CHECK, and that is the fail-closed half of this route. The column it
 * writes exists only for answers a model is permitted to rephrase, and `iti_project_work` is the
 * only free-text item in any enabled role pack — every other worker-typed value that reaches the
 * sheet is a proper noun (an employer, a city, an institute, a certificate) or a job title, and a
 * model may not restate any of those: rephrasing a company renames his employer, and rephrasing
 * "operator" can promote him.
 *
 * A `^[a-z_]+$` shape check would have accepted all of them. This route would then have been a
 * generic "set a flag on any attribute row of mine" surface — reachable for keys no rewrite exists
 * for, and the kind of endpoint that grows a second meaning later. `wa_value_text_polished_declined
 * _chk` and the repository's `value_kind = 'text'` predicate would still have held the data honest;
 * the API contract is what this keeps narrow.
 *
 * PINNED AGAINST THE RENDERER by `resume-fresher-rows.test.ts`, so the two cannot drift into a
 * route that addresses a key the sheet never offers, or a sheet that offers one this rejects.
 */
export const DECLINABLE_ATTRIBUTE_KEYS = ["iti_project_work"] as const;

/**
 * Which text prints for one of the worker's own free-text answers.
 *
 * THE SAME BODY `PUT /workers/me/employment/:employmentId/description-source` takes (#1354), field
 * for field and value for value. Deliberately identical: it is the same decision about the same
 * kind of rewrite, and a client that has already implemented one should not have to learn a second
 * vocabulary to offer it on the page where the worker has no employment.
 *
 * `own_words` is a REFUSAL of the model's rewrite; `polished` puts it back.
 */
export const SetAnswerTextSourceSchema = z
  .object({
    source: z.enum(["own_words", "polished"]),
  })
  .strict();
export type SetAnswerTextSourceDto = z.infer<typeof SetAnswerTextSourceSchema>;

/** The `:attributeKey` path parameter. Closed set — see {@link DECLINABLE_ATTRIBUTE_KEYS}. */
export const DeclinableAttributeKeySchema = z.enum(DECLINABLE_ATTRIBUTE_KEYS);
export type DeclinableAttributeKey = z.infer<typeof DeclinableAttributeKeySchema>;
