import { createHash } from "node:crypto";

import { z } from "zod";

/**
 * What `worker_pack_answer.answer_other_text_polished` holds once a typed "Koi aur — khud likhein"
 * answer has been reviewed against the worker's trade and the field (#2409).
 *
 * A VERSIONED RECORD, NOT THE OLD FREE TEXT. Before #2409 the column held a sentence from the
 * work-history polish route, a rewrite nothing ever checked against the trade or the field. Those
 * values are still in production. A row that does not parse as this record is therefore
 * "not reviewed yet" and is reviewed again; it never prints.
 *
 * BOUND TO THE TEXT IT REVIEWED (`h`). The upsert clears this column on every re-answer, and the
 * save is scoped to the reviewed text, but neither is a property of the record itself. The hash
 * makes it one: a record read beside different words is "not reviewed", whatever wrote it.
 *
 * `items: []` IS A SETTLED ANSWER: the review found nothing that may print. Storing it is what
 * stops the same text being sent to the model on every render.
 */
const OtherAnswerReviewRecordSchema = z
  .object({
    v: z.literal(1),
    h: z.string().regex(/^[0-9a-f]{16}$/),
    items: z.array(z.string().min(1).max(60)).max(5),
  })
  .strict();

/** A short, stable fingerprint of the exact text reviewed. Not a secret; a binding. */
export function reviewedTextFingerprint(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** The stored form of a settled review of {@link reviewedText}. */
export function encodeOtherAnswerReview(items: readonly string[], reviewedText: string): string {
  return JSON.stringify(
    OtherAnswerReviewRecordSchema.parse({
      v: 1,
      h: reviewedTextFingerprint(reviewedText),
      items: [...items],
    }),
  );
}

/**
 * The names a settled review of {@link currentText} let print, `[]` when it let none, or `null`
 * when the column holds no settled v1 review OF THAT TEXT (empty, a pre-#2409 rewrite, a record
 * of different words, or anything unreadable).
 */
export function readOtherAnswerReview(
  stored: string | null | undefined,
  currentText: string,
): readonly string[] | null {
  if (!stored) return null;
  try {
    const parsed = OtherAnswerReviewRecordSchema.safeParse(JSON.parse(stored));
    if (!parsed.success || parsed.data.h !== reviewedTextFingerprint(currentText)) return null;
    return parsed.data.items;
  } catch {
    return null;
  }
}
