import { z } from "zod";

/**
 * `GET /jobs/search` query string (#822).
 *
 * EVERY FILTER IS OPTIONAL AND NOTHING IS SEEDED FROM THE WORKER'S PROFILE. That is the same
 * rule ADR-0036 Part 3 states for the feed — "Every default is wide or off... Defaults that
 * narrow are a volume leak" — and it matters more here, not less: a worker who typed nothing
 * into the location box means "anywhere", and quietly filling it in from their registered city
 * would hide jobs they explicitly asked to see.
 *
 * A no-parameter request is therefore legal and returns the first page of every open posting.
 */
export const JobSearchQuerySchema = z.object({
  /**
   * Free text over the role title and the poster's skill phrases.
   *
   * TRIMMED, AND AN EMPTY RESULT IS TREATED AS ABSENT rather than as a term. A worker who taps
   * search on an empty box (or types only spaces) means "show me everything"; matching
   * `ILIKE '%%'` would technically do that, but it would also make the relevance ladder rank
   * every row identically while claiming a query was performed. Absent is the honest state.
   *
   * Capped at 100 characters. A search term longer than that is not a search term, and the cap
   * bounds both the ILIKE cost and what the event's `query_length` can report.
   */
  q: z
    .string()
    .max(100)
    .transform((s) => s.trim())
    .transform((s) => (s.length > 0 ? s : undefined))
    .optional(),
  city: z
    .string()
    .max(120)
    .transform((s) => s.trim())
    .transform((s) => (s.length > 0 ? s : undefined))
    .optional(),
  state: z
    .string()
    .max(120)
    .transform((s) => s.trim())
    .transform((s) => (s.length > 0 ? s : undefined))
    .optional(),
  /**
   * Page size. Default 20 (the issue's contract), hard max 50 — the same ceiling the feed
   * uses, so no worker-facing list route can ever be unbounded.
   */
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /**
   * 1-BASED, because that is what the client sends and what a human reads. The offset is
   * derived in the service (`(page - 1) * limit`) rather than accepted directly: an
   * attacker-supplied offset is an unbounded scan primitive, and a page number bounded by the
   * same limit is not.
   */
  page: z.coerce.number().int().min(1).default(1),
});
export type JobSearchQueryDto = z.infer<typeof JobSearchQuerySchema>;
