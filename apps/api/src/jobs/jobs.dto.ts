import { z } from "zod";
import { uuidSchema } from "@badabhai/validators";

/**
 * Canonical role/trade slug a job accepts (e.g. "vmc_operator"). Lowercase slug
 * only — no free text. Mirrors `jobRoleId` in @badabhai/event-schema so the DTO
 * and the `job.created` event payload agree on what a role id looks like.
 */
const roleIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/, "role id must be a lowercase slug ([a-z0-9_])");

const neededBySchema = z.enum(["immediate", "soon", "flexible"]);
const boostTierSchema = z.enum(["none", "standard", "premium"]);
const closeReasonSchema = z.enum(["manual", "expired", "filled", "other"]);

/** POST /jobs — create a draft job. */
export const CreateJobSchema = z.object({
  payerId: uuidSchema,
  // PRIVACY: `title` is payer free-text. Stored on the row, but NEVER copied
  // into an event payload or a log line.
  title: z.string().trim().min(1).max(200),
  roleIds: z.array(roleIdSchema).min(1).max(20),
  vacancyCount: z.number().int().min(1),
  domainId: z.string().trim().min(1).max(64).optional(),
  city: z.string().trim().min(1).max(120).optional(),
  locationLat: z.number().min(-90).max(90).optional(),
  locationLng: z.number().min(-180).max(180).optional(),
  maxTravelKm: z.number().int().nonnegative().optional(),
  minExperienceYears: z.number().int().nonnegative().optional(),
  maxExperienceYears: z.number().int().nonnegative().optional(),
  payMin: z.number().int().nonnegative().optional(),
  payMax: z.number().int().nonnegative().optional(),
  neededBy: neededBySchema.optional(),
});
export type CreateJobDto = z.infer<typeof CreateJobSchema>;

/** GET /jobs — optional filters + pagination (ops read). */
export const ListJobsSchema = z.object({
  status: z.enum(["draft", "active", "paused", "closed"]).optional(),
  payerId: uuidSchema.optional(),
  // Query params arrive as strings; coerce then clamp.
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});
export type ListJobsDto = z.infer<typeof ListJobsSchema>;

/** POST /jobs/:id/activate — draft → active. All fields optional. */
export const ActivateJobSchema = z.object({
  applicantQuota: z.number().int().nonnegative().optional(),
  postingFeeInr: z.number().nonnegative().optional(),
  introDays: z.number().int().min(1).optional(),
});
export type ActivateJobDto = z.infer<typeof ActivateJobSchema>;

/**
 * POST /jobs/:id/applicants — INTERIM ops/test seam to record applicants until
 * the worker feed + `application.submitted` event lands.
 */
export const RecordApplicantsSchema = z.object({
  count: z.number().int().min(1).default(1),
});
export type RecordApplicantsDto = z.infer<typeof RecordApplicantsSchema>;

/** POST /jobs/:id/boost — set/adjust boost. */
export const BoostJobSchema = z.object({
  boostTier: boostTierSchema,
  boostDurationDays: z.number().int().min(1).optional(),
});
export type BoostJobDto = z.infer<typeof BoostJobSchema>;

/** POST /jobs/:id/close — terminal close. */
export const CloseJobSchema = z.object({
  reason: closeReasonSchema.default("manual"),
});
export type CloseJobDto = z.infer<typeof CloseJobSchema>;
