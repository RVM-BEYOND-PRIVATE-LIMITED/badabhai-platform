/**
 * FIXTURE ONLY. Syntactically valid, semantically meaningless.
 *
 * !! THIS IS NOT THE TAXONOMY AND MUST NEVER BE PUBLISHED ACTIVE. !!
 *
 * Rulings R1-R4 are open: how the Aug-9 ladders decompose into (function, collar_tier),
 * how the families re-cut, whether Design & Drafting is the 11th domain, and how the
 * three role overlaps resolve are all unsigned RVM decisions. Seeding a guess would
 * settle them by making them real, and `skill_id` is immutable and never reused — so a
 * wrong guess here is a one-way door. See docs/decisions/RVM_TAXONOMY_WORKSHEET_2026-09.md.
 *
 * Every id below is a deliberate placeholder (`role_placeholder_*`, `dom_placeholder_*`,
 * `fam_placeholder_*`). Nothing here is a real BadaBhai role, domain or family, and the
 * ids are obviously synthetic on sight so that a placeholder leaking into a match result
 * is unmistakable rather than plausible.
 *
 * It exists for exactly two jobs:
 *   1. give the tests something that PASSES, so the four rejection tests are proving
 *      the validator rejects bad input rather than rejecting everything;
 *   2. prove the shape can actually carry the two locked asymmetric multipliers.
 *
 * It is seeded with `is_active = false` and `getActive()` must never return it.
 */
import { MATCHING_CATALOG_SCHEMA_VERSION, type MatchingCatalog } from "./types";

/**
 * The two multiplier values spec §A4 pins by name. They are properties of the
 * FUNCTION axis (master-context §21, locked 2026-07-09), not of the open taxonomy
 * rulings, so exercising them here settles nothing.
 */
export const HIGHER_TIER_TO_OPERATOR = 0.85;
export const OPERATOR_TO_HIGHER_TIER = 0.25;

/**
 * A minimal valid catalog: two placeholder roles in two placeholder domains and
 * families, one adjacency edge between them, and a function matrix that carries the
 * asymmetry in both directions.
 */
export const FIXTURE_CATALOG: MatchingCatalog = {
  schemaVersion: MATCHING_CATALOG_SCHEMA_VERSION,
  domains: [
    { id: "dom_placeholder_a", label: "Placeholder Domain A" },
    { id: "dom_placeholder_b", label: "Placeholder Domain B" },
  ],
  families: [
    { id: "fam_placeholder_a", label: "Placeholder Family A" },
    { id: "fam_placeholder_b", label: "Placeholder Family B" },
  ],
  roles: [
    {
      id: "role_placeholder_a",
      label: "Placeholder Role A",
      domainId: "dom_placeholder_a",
      familyId: "fam_placeholder_a",
      functions: ["operator", "setter", "programmer"],
      collarTiers: ["skilled trade", "technician"],
      attributeWhitelist: ["attr_placeholder_one", "attr_placeholder_two"],
    },
    {
      id: "role_placeholder_b",
      label: "Placeholder Role B",
      domainId: "dom_placeholder_b",
      familyId: "fam_placeholder_b",
      functions: ["operator"],
      collarTiers: ["elementary", "semi-skilled"],
      attributeWhitelist: [],
    },
  ],
  adjacency: [
    // Directed and deliberately NOT symmetric, so a resolver that accidentally treats
    // the edge list as undirected fails a fixture assertion rather than shipping.
    { from: "role_placeholder_a", to: "role_placeholder_b", multiplier: 0.45 },
    { from: "role_placeholder_b", to: "role_placeholder_a", multiplier: 0.3 },
  ],
  functionMultiplier: {
    // "function differs / not confirmed" — never zero, so a partial profile is
    // surfaced rather than excluded (spec §A4).
    default: 0.85,
    matrix: {
      // higher-tier -> operator: a programmer or setter can run the machine.
      programmer: { operator: HIGHER_TIER_TO_OPERATOR },
      setter: { operator: HIGHER_TIER_TO_OPERATOR },
      // operator -> higher-tier: an operator has not shown they can program.
      operator: {
        programmer: OPERATOR_TO_HIGHER_TIER,
        setter: OPERATOR_TO_HIGHER_TIER,
        operator: 1,
      },
    },
  },
  collarTierBand: {
    default: 0.3,
    matrix: {
      "skilled trade": { "skilled trade": 1, "semi-skilled": 0.6, elementary: 0.3 },
      technician: { technician: 1, "skilled trade": 0.6 },
    },
  },
};
