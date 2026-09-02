/**
 * @badabhai/matching-catalog — the TYPED CONTRACT for `matching_catalog.catalog`.
 *
 * This file owns the *shape* of the matching config blob. The *values* — which roles
 * exist, which domain and family each sits in, and every multiplier — are RVM-ratified
 * domain truth published as DB rows. Master-context §32 puts them deliberately OUTSIDE
 * the schema because they change on RVM's clock, not on a deploy's.
 *
 * INVARIANTS:
 *  - PII-FREE. Stable machine ids, display labels and numbers ONLY. Never a worker
 *    identity, never a payer name, never free text beyond a label.
 *  - Deterministic. This is data; the tier resolver (P2) is pure math over it.
 *  - Fail-closed. A blob that would yield a nonsense multiplier or dangle a reference
 *    fails here and in `validate.ts`, and is never published (see the publish path).
 *  - Every multiplier is a probability-like factor in [0.00, 1.00]. There is no
 *    "bonus" above 1.0 — spec §A4 caps `tradeFactor` at 1.00 by composition.
 *
 * WHY `setter_programmer` IS NOT IN THE LOCKED ENUM BELOW.
 * Master-context §21 locked exactly nine `function` values on 2026-07-09. Spec §A1
 * PROPOSES a tenth, `setter_programmer`, and that proposal is ruling **R1, which is
 * open and unsigned**. Admitting it here would settle R1 by making it representable,
 * which is precisely the move the build rules forbid. When R1 is signed:
 *   1. move "setter_programmer" from PROPOSED_FUNCTION_VALUES into LOCKED_FUNCTION_VALUES
 *   2. bump MATCHING_CATALOG_SCHEMA_VERSION
 *   3. ship the follow-up migration that widens `mc_active_shape_chk`
 * Until then a catalog naming it is REJECTED, with the offending path.
 */
import { z } from "zod";

/**
 * Contract version for `matching_catalog.catalog`. Bump on ANY breaking change to the
 * shapes below — and note that the migration's `mc_active_shape_chk` CHECK constraint
 * pins the top-level container types, so a bump that changes them needs a follow-up
 * migration. See `0095_matching_catalog.sql`.
 */
export const MATCHING_CATALOG_SCHEMA_VERSION = 1;

/**
 * The nine LOCKED `function` values (master-context §21). A worker's function is a
 * modifier on their role, never a role of its own — that is the §A0 ruling the whole
 * catalog shape depends on.
 */
export const LOCKED_FUNCTION_VALUES = [
  "operator",
  "setter",
  "programmer",
  "trainer",
  "supervisor",
  "maintenance",
  "inspector",
  "manager",
  "apprentice",
] as const;

/** Proposed but NOT locked — gated behind ruling R1. Rejected by the schema today. */
export const PROPOSED_FUNCTION_VALUES = ["setter_programmer"] as const;

/** The four LOCKED collar tiers (master-context §21 Axis B), lowest to highest. */
export const LOCKED_COLLAR_TIERS = [
  "elementary",
  "semi-skilled",
  "skilled trade",
  "technician",
] as const;

export const functionValueSchema = z.enum(LOCKED_FUNCTION_VALUES);
export const collarTierSchema = z.enum(LOCKED_COLLAR_TIERS);

export type FunctionValue = z.infer<typeof functionValueSchema>;
export type CollarTier = z.infer<typeof collarTierSchema>;

/** A stable machine id: lowercase alphanumeric + underscore. Never a display string. */
export const catalogIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_]*$/, "id must be lowercase alphanumeric/underscore");

/** A human display label. Non-empty, bounded, no PII. */
export const labelSchema = z.string().min(1).max(120);

/**
 * Every multiplier in this catalog. Closed interval [0.00, 1.00] — a factor that can
 * only ever hold a score flat or reduce it. 1.0 = exact, 0.0 = no signal.
 */
export const multiplierSchema = z
  .number()
  .min(0, "multiplier must be >= 0.00")
  .max(1, "multiplier must be <= 1.00");

/** A domain — the second level of the §21 coordinate (Industry -> Domain -> Role -> Skills[]). */
export const domainSchema = z
  .object({
    id: catalogIdSchema,
    label: labelSchema,
  })
  .strict();

/** A family — the adjacency grouping that earns the `same family` multiplier. */
export const familySchema = z
  .object({
    id: catalogIdSchema,
    label: labelSchema,
  })
  .strict();

/**
 * One role in the registry. `domainId` and `familyId` are REQUIRED and must resolve
 * against the registries above — a role with a dangling or absent domain cannot be
 * domain-scoped at resolution (§24), and one with no family silently loses the 0.90
 * same-family edge.
 */
export const roleSchema = z
  .object({
    id: catalogIdSchema,
    label: labelSchema,
    domainId: catalogIdSchema,
    familyId: catalogIdSchema,
    /** Which of the locked `function` values may legally appear on this role. */
    functions: z.array(functionValueSchema).min(1),
    /** Which of the locked collar tiers may legally appear on this role. */
    collarTiers: z.array(collarTierSchema).min(1),
    /**
     * Closed per-role attribute whitelist (controller, axes, machine make, ...).
     * DISPLAY AND FACET ONLY — never scored, never ranked, never a filter that removes
     * a candidate. That is the §A8 line and ruling R7.
     */
    attributeWhitelist: z.array(catalogIdSchema).default([]),
  })
  .strict();

/**
 * One DIRECTED adjacency edge, sparse. Direction matters: `from` is the worker's role,
 * `to` is the job's role, and the pair is NOT symmetric.
 */
export const adjacencyEdgeSchema = z
  .object({
    from: catalogIdSchema,
    to: catalogIdSchema,
    multiplier: multiplierSchema,
  })
  .strict();

/**
 * The directed function matrix. `matrix[from][to]` is the factor applied when a worker
 * whose function is `from` is scored against a job asking for `to`.
 *
 * This is the shape that must express the two locked asymmetric cases (§A4):
 *   higher-tier -> operator   0.85    e.g. matrix.programmer.operator = 0.85
 *   operator -> higher-tier   0.25    e.g. matrix.operator.programmer = 0.25
 * Sparse by design: any pair absent from the matrix falls back to `default`.
 *
 * `default` is the "function differs / function not confirmed" class. Spec §A4 fixes
 * its intent: a worker with an unknown function must score there and never zero, so a
 * partial profile is surfaced as "function not confirmed" rather than excluded.
 */
export const functionMultiplierSchema = z
  .object({
    default: multiplierSchema,
    matrix: z.record(functionValueSchema, z.record(functionValueSchema, multiplierSchema)),
  })
  .strict();

/**
 * The directed collar-tier band. `matrix[workerTier][jobTier]`, same sparse+default
 * shape, reusing the locked experience-banding intent (§A4): meets 1.0 / one below 0.6
 * / two below 0.3, with fresher-OK handled by the job side, not here.
 */
export const collarTierBandSchema = z
  .object({
    default: multiplierSchema,
    matrix: z.record(collarTierSchema, z.record(collarTierSchema, multiplierSchema)),
  })
  .strict();

/**
 * The whole `matching_catalog.catalog` blob.
 *
 * `.strict()` throughout: an unknown key is a rejection, not a silently-ignored field.
 * A typo'd `adjacencies:` that parsed as "no edges" would make every cross-role match
 * fall to the unrelated floor with nothing in the logs.
 */
export const matchingCatalogSchema = z
  .object({
    schemaVersion: z.literal(MATCHING_CATALOG_SCHEMA_VERSION),
    domains: z.array(domainSchema).min(1),
    families: z.array(familySchema).min(1),
    roles: z.array(roleSchema).min(1),
    adjacency: z.array(adjacencyEdgeSchema),
    functionMultiplier: functionMultiplierSchema,
    collarTierBand: collarTierBandSchema,
  })
  .strict();

export type Domain = z.infer<typeof domainSchema>;
export type Family = z.infer<typeof familySchema>;
export type Role = z.infer<typeof roleSchema>;
export type AdjacencyEdge = z.infer<typeof adjacencyEdgeSchema>;
export type FunctionMultiplier = z.infer<typeof functionMultiplierSchema>;
export type CollarTierBand = z.infer<typeof collarTierBandSchema>;
export type MatchingCatalog = z.infer<typeof matchingCatalogSchema>;
