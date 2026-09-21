import { z } from "zod";
import { getMachine, getSkill } from "@badabhai/taxonomy";
import { uuidSchema } from "@badabhai/validators";

import {
  CERTIFICATES_MAX,
  CertificateEntrySchema,
  EDUCATIONS_MAX,
  EducationEntrySchema,
} from "./worker-qualifications.dto";
import {
  EXPERIENCE_YEARS_MAX,
  EXPERIENCE_YEARS_MIN,
  MAX_CORRECTION_MACHINES,
  MAX_CORRECTION_SKILLS,
} from "./extracted-corrections.contract";

/** Canonical `skill_*` ids only — the display/matching path resolves nothing else. */
const skillIdList = z
  .array(z.string())
  .min(1)
  .max(MAX_CORRECTION_SKILLS)
  .refine((ids) => ids.every((id) => getSkill(id) !== undefined), {
    message: "every skill_id must be a canonical taxonomy skill",
  })
  .transform((ids) => [...new Set(ids)].sort());

/** Canonical `mach_*` ids only, same rule. */
const machineIdList = z
  .array(z.string())
  .min(1)
  .max(MAX_CORRECTION_MACHINES)
  .refine((ids) => ids.every((id) => getMachine(id) !== undefined), {
    message: "every machine_id must be a canonical taxonomy machine",
  })
  .transform((ids) => [...new Set(ids)].sort());

const SkillsCorrectionSchema = z
  .object({ field: z.literal("skills"), skill_ids: skillIdList })
  .strict();

const MachinesCorrectionSchema = z
  .object({ field: z.literal("machines"), machine_ids: machineIdList })
  .strict();

const ExperienceCorrectionSchema = z
  .object({
    field: z.literal("experience"),
    total_years: z.number().int().min(EXPERIENCE_YEARS_MIN).max(EXPERIENCE_YEARS_MAX),
  })
  .strict();

const EducationCorrectionSchema = z
  .object({
    field: z.literal("education"),
    // The FULL corrected list (replace semantics, like the finishing PUT): the entry
    // schemas carry the PUT's own validation (length caps, CHECK parity, non-empty).
    educations: z.array(EducationEntrySchema).min(1).max(EDUCATIONS_MAX),
  })
  .strict();

const CertificatesCorrectionSchema = z
  .object({
    field: z.literal("certificates"),
    certificates: z.array(CertificateEntrySchema).min(1).max(CERTIFICATES_MAX),
  })
  .strict();

const FieldCorrectionSchema = z.discriminatedUnion("field", [
  SkillsCorrectionSchema,
  MachinesCorrectionSchema,
  ExperienceCorrectionSchema,
  EducationCorrectionSchema,
  CertificatesCorrectionSchema,
]);

export type FieldCorrectionDto = z.infer<typeof FieldCorrectionSchema>;

/**
 * POST /profile/corrections — correct extracted fields on the worker's own profile.
 *
 * `session_id` is the pinned interview anchor (Defect-A option a: occupation pins and
 * close-pinned universal pointers alike); unpinned sessions are deferred, never guessed.
 * `corrections` carries 1–5 entries with unique fields — one request may correct several
 * facts, each audited and evented separately.
 */
export const CorrectExtractedSchema = z
  .object({
    profile_id: uuidSchema,
    session_id: uuidSchema,
    corrections: z
      .array(FieldCorrectionSchema)
      .min(1)
      .max(5)
      .refine((list) => new Set(list.map((entry) => entry.field)).size === list.length, {
        message: "one correction per field — repeat fields are a client bug",
      }),
  })
  .strict();

export type CorrectExtractedDto = z.infer<typeof CorrectExtractedSchema>;

/** Counts only — never echoes corrected values, like every sibling PUT response. */
export interface CorrectionsAppliedResponse {
  readonly profile_id: string;
  readonly corrections_applied: number;
  readonly correction_count: number;
}
