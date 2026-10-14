import "server-only";

import { z } from "zod";

import { adminFetch } from "./admin-http";

/**
 * Agency-job match skills — reads for the Matching → Agency match skills
 * screens (`GET /admin/agency-jobs`, `GET /admin/agency-jobs/:jobId/match-skills`).
 * The write lives in the detail route's `actions.ts`, mirroring the
 * skill-discovery read-seam/write-split.
 *
 * Parsed, never trusted: every body is Zod-checked and a shape break is an
 * outage, not a render. `no-store` (adminFetch default): a cached skill set
 * is a wrong answer. Faceless: the seven fields carry opaque ids + poster
 * text only — no worker identity, no payer contact.
 */
const agencyJobMatchSkillsSchema = z.object({
  job_id: z.string().uuid(),
  payer_id: z.string().uuid(),
  title: z.string(),
  city: z.string(),
  // A string, NOT an enum: a status the portal has never heard of must still
  // render (as its own de-snaked label), never 500 the page. Display mapping
  // lives in `agency-jobs-vocabulary.ts`.
  status: z.string(),
  match_skill_ids: z.array(z.string()),
  updated_at: z.string(),
});

export type AgencyJobMatchSkills = z.infer<typeof agencyJobMatchSkillsSchema>;

/** List the newest agency jobs (bounded — the API serves one page, no cursor). */
export async function listAgencyJobs(limit = 50): Promise<AgencyJobMatchSkills[]> {
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 100);
  return adminFetch(`/admin/agency-jobs?limit=${bounded}`, {
    schema: z.array(agencyJobMatchSkillsSchema),
  });
}

/** One agency job's current match-skill selection. */
export async function getAgencyJobMatchSkills(jobId: string): Promise<AgencyJobMatchSkills> {
  return adminFetch(`/admin/agency-jobs/${encodeURIComponent(jobId)}/match-skills`, {
    schema: agencyJobMatchSkillsSchema,
  });
}

/**
 * The match-skill picker vocabulary + the runtime cap.
 *
 * Served by `GET /admin/match/skills` (backend #2207 — the admin twin of the
 * payer vocabulary read): same `{skills}` shape the payer picker renders, plus
 * the live `max_skills_per_posting` so the editor never hard-codes a count.
 * The cap is optional in the schema: an older backend serves the vocabulary
 * without it, and then the form submits without a client-side count check —
 * the server still enforces it (400) and the error renders verbatim.
 *
 * NOTE — no fetcher lives here on purpose: the page-gates fence requires
 * every `adminFetch` in lib/ to map to an API GET route that EXISTS, and this
 * endpoint lands with #2207. The read lives in the detail route's
 * `actions.ts` (`readMatchVocabularyAction`, mirroring
 * `searchCanonicalSkillsAction`), so the UI ships complete and lights up with
 * zero UI changes the day the endpoint deploys.
 */
export const matchSkillVocabularySchema = z.object({
  skills: z.array(
    z.object({
      skill_id: z.string(),
      label: z.string(),
      industry_id: z.string(),
      related_skill_ids: z.array(z.string()),
    }),
  ),
  max_skills_per_posting: z.number().int().positive().optional(),
});

export type MatchSkillVocabulary = z.infer<typeof matchSkillVocabularySchema>;

/** The write result: `changed: false` is a successful no-op, never an error. */
export const setAgencyJobMatchSkillsResultSchema = z.object({
  job_id: z.string().uuid(),
  match_skill_ids: z.array(z.string()),
  changed: z.boolean(),
});

export type SetAgencyJobMatchSkillsResult = z.infer<
  typeof setAgencyJobMatchSkillsResultSchema
>;
