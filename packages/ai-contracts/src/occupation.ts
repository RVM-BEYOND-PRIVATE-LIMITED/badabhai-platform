import { z } from "zod";

// The job-domain RAG match: its closed status vocabulary and result schema.

// ---------------------------------------------------------------------------
// Job-domain RAG match (generalized profiling)
// ---------------------------------------------------------------------------

/**
 * The closed status vocabulary, shared by three places that must agree: this schema, the
 * Pydantic `JobDomainMatch`, and the `job_domain_match_status` CHECK constraint on
 * `worker_profiles`. Exported so the persistence side can reuse it rather than
 * hand-copying the strings a fourth time.
 *
 * The three UNMATCHED reasons are kept DISTINCT on purpose. "No domain" is a legitimate
 * outcome, but "the catalog had nothing close" and "the AI seam was down" are entirely
 * different operational facts, and collapsing them would make a broken retrieval look
 * like a genuinely unclassifiable workforce.
 */
export const JOB_DOMAIN_MATCH_STATUSES = [
  /** One candidate was so far ahead that no model was asked. Deterministic. */
  "matched_auto",
  /** The model chose from the retrieved shortlist, and the id re-validated. */
  "matched_llm",
  /** The best candidate in the whole catalog was below the similarity floor. */
  "unmatched_below_floor",
  /** The model declined, was unreadable, or named an id that was not retrieved. */
  "unmatched_llm_declined",
  /** The flag is off, the query was empty, pseudonymization blocked, or the seam failed. */
  "unmatched_degraded",
] as const;
export type JobDomainMatchStatus = (typeof JOB_DOMAIN_MATCH_STATUSES)[number];

export const JobDomainMatchSchema = z.object({
  status: z.enum(JOB_DOMAIN_MATCH_STATUSES).default("unmatched_degraded"),
  /** Non-null ONLY on a matched status. Always a `job_domain` id the search returned. */
  job_domain_id: z.string().nullable().default(null),
  /**
   * The RETRIEVAL cosine similarity — never the model's self-reported confidence. One is
   * measured, the other asserted, and only the measured one belongs in a column that
   * later analysis will threshold on.
   */
  score: z.number().nullable().default(null),
  /** The shortlist that was considered, ids only. Observability; never worker text. */
  considered: z.array(z.string()).default([]),
});
export type JobDomainMatch = z.infer<typeof JobDomainMatchSchema>;
