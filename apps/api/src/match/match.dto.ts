import { z } from "zod";

/**
 * Zod DTOs for the Matching V1 payer surface (spec Part 2 — the posting form).
 *
 * VALIDATION AT THE BOUNDARY, EVERY TIME. Skill ids are shape-checked here and
 * CLOSED-SET-checked in the service against `@badabhai/taxonomy` — a client can post
 * any string it likes and it will never reach `job_postings.match_skill_ids`.
 */

/** The `mskill_*` id shape. Membership of the closed set is checked in the service. */
export const matchSkillIdSchema = z
  .string()
  .regex(/^mskill_[a-z0-9_]+$/, "not a match skill id");

/**
 * `POST /payer/match/reach-preview` — what the posting form asks while the payer types.
 *
 * NO CAP HERE. The cap on how many skills a company may post is
 * `match_config.max_skills_per_posting`, which is a runtime value; a Zod `.max(3)`
 * would hard-code it in a second place and silently disagree with the config the
 * moment ops raise it. The service enforces it against the loaded config and returns
 * a 400 — it never truncates (see `packages/match-engine/reach.ts`, which deliberately
 * does not truncate either: "silently dropping a skill a payer paid to post is worse
 * than a 400").
 *
 * A generous absolute ceiling IS applied, purely as a request-size bound.
 */
export const ReachPreviewSchema = z.object({
  match_skill_ids: z.array(matchSkillIdSchema).min(1).max(50),
  /**
   * Related skills the payer has UNTICKED. Advisory: `resolveReachSet` honours an
   * untick only when it names a SUGGESTED related skill, and a POSTED skill can never
   * be unticked. An untick naming anything else is ignored, not applied.
   */
  unticked_related_ids: z.array(matchSkillIdSchema).max(200).default([]),
});
export type ReachPreviewDto = z.infer<typeof ReachPreviewSchema>;

/**
 * The Matching V1 half of a PUBLISH (`PATCH /payer/job-postings/:id` with
 * `status: "open"`), plus the worker-visible display fields the served entity gained
 * in migration 0054.
 *
 * `city`/`pay_min`/`pay_max`/`shift`/`needed_by` mirror the columns `jobs` already had
 * and the schema already classifies PII-free: a COARSE city bucket (never an address),
 * an integer ₹ band (never an exact salary linked to a person), and two coarse enums.
 */
export const MatchPublishFieldsSchema = z
  .object({
    match_skill_ids: z.array(matchSkillIdSchema).min(1).max(50).optional(),
    unticked_related_ids: z.array(matchSkillIdSchema).max(200).optional(),
    city: z.string().trim().min(1).max(80).optional(),
    pay_min: z.number().int().nonnegative().optional(),
    pay_max: z.number().int().nonnegative().optional(),
    shift: z.enum(["day", "night", "rotational"]).optional(),
    needed_by: z.enum(["immediate", "soon", "flexible"]).optional(),
  })
  .refine(
    (v) => v.pay_min === undefined || v.pay_max === undefined || v.pay_max >= v.pay_min,
    { message: "pay_max must be >= pay_min", path: ["pay_max"] },
  );
export type MatchPublishFieldsDto = z.infer<typeof MatchPublishFieldsSchema>;

/**
 * `POST /payer/job-postings/:id/reach/widen` — the ops-guarded Policy 27 widen.
 *
 * APPEND ONLY BY CONSTRUCTION: the DTO can only carry ids to ADD. There is no
 * `removed_skill_ids` field, so "ops narrowed a reach set" is not expressible on this
 * route — which is the point ("Ops may widen a reach set, never narrow one").
 */
export const ReachWidenSchema = z.object({
  add_skill_ids: z.array(matchSkillIdSchema).min(1).max(50),
  /**
   * The opaque ops actor performing the widen — the AUDITED half of Policy 27. There
   * is no ops auth in alpha (the sibling ops routes take `created_by` on the body the
   * same way), so the caller supplies it; the route is behind `InternalServiceGuard`,
   * so "the caller" is a service principal holding the shared secret, not the public.
   */
  ops_actor: z.string().uuid(),
});
export type ReachWidenDto = z.infer<typeof ReachWidenSchema>;
