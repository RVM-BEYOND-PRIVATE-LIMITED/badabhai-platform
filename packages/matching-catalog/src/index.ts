/**
 * @badabhai/matching-catalog — the typed contract for the `matching_catalog` config blob.
 *
 * Master-context §32 keeps the role registry, families, domains, adjacency multipliers,
 * function/collar multipliers and per-role attribute whitelists OUTSIDE the schema, so
 * taxonomy churn is a data publish with RVM sign-off rather than a deploy. This package
 * owns the SHAPE of that blob and the publish-time gate; RVM owns the VALUES.
 *
 * Pure, PII-free, no LLM — the @badabhai/pricing discipline applied to domain truth.
 */
export {
  MATCHING_CATALOG_SCHEMA_VERSION,
  LOCKED_FUNCTION_VALUES,
  PROPOSED_FUNCTION_VALUES,
  LOCKED_COLLAR_TIERS,
  functionValueSchema,
  collarTierSchema,
  catalogIdSchema,
  labelSchema,
  multiplierSchema,
  domainSchema,
  familySchema,
  roleSchema,
  adjacencyEdgeSchema,
  functionMultiplierSchema,
  collarTierBandSchema,
  matchingCatalogSchema,
  type FunctionValue,
  type CollarTier,
  type Domain,
  type Family,
  type Role,
  type AdjacencyEdge,
  type FunctionMultiplier,
  type CollarTierBand,
  type MatchingCatalog,
} from "./types";

export {
  validateMatchingCatalog,
  describeIssues,
  formatPath,
  type CatalogIssue,
  type CatalogIssueCode,
  type ValidateResult,
} from "./validate";

export {
  FIXTURE_CATALOG,
  HIGHER_TIER_TO_OPERATOR,
  OPERATOR_TO_HIGHER_TIER,
} from "./fixture";
