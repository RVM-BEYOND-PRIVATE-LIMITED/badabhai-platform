import { z } from "zod";
import { uuidSchema } from "@badabhai/validators";

/**
 * Publish a new matching-catalog revision (the RVM config-builder write).
 *
 * WHY `catalog` IS `z.unknown()` HERE, UNLIKE `pricing.dto.ts`.
 * The pricing DTO puts `catalogSchema` straight in the ZodValidationPipe. Doing that
 * here would split the rejection surface in two: a bad multiplier would be caught by
 * the pipe and reported in Zod's format, while a dangling adjacency edge — which is
 * shape-valid and only fails the REFERENCE check — would get past the pipe and be
 * reported in the service's format. Two error shapes for one class of failure, and the
 * publisher has to learn both.
 *
 * So the pipe validates only the envelope, and `validateMatchingCatalog` in the service
 * is the single gate that produces every rejection, in one format, always naming the
 * offending path. See MatchingCatalogService.publish().
 *
 * There is no ops auth in alpha — `updated_by` is an opaque actor uuid on the body,
 * the same posture as `pricing_catalog.updated_by` and `job_postings.created_by`. The
 * route itself is gated by InternalServiceGuard (R31).
 */
export const PublishCatalogSchema = z.object({
  updated_by: uuidSchema,
  catalog: z.unknown(),
});
export type PublishCatalogDto = z.infer<typeof PublishCatalogSchema>;
