/**
 * The family fallback chain — most-specific-wins over `profiling_family_binding`.
 *
 * WHAT THIS ANSWERS. Retrieval pins an OCCUPATION (`jd_nco_7212_0100`); the interview
 * needs a FAMILY, because that is what owns a question pack. A family may have claimed
 * that occupation at any of six granularities, so resolution walks from most specific to
 * least and takes the first hit:
 *
 *   50  job_domain_id       this exact occupation
 *   40  isco_unit_code      the unit group (7212)
 *   30  isco_minor_code     the minor group (721)
 *   20  isco_submajor_code  the sub-major (72)
 *   10  isco_major_code     the major (7)
 *    0  is_universal        the fallback that keeps every unauthored trade working
 *
 * WHY THIS IS ONE ORDER BY AND NOT A SIX-WAY COALESCE. Six nullable target columns
 * invite six NULL checks in a fixed order, and the moment a seventh level appears (or two
 * are reordered) the checks drift apart from the specificity numbers. Storing the level
 * as data and sorting by it means the ordering is a property of the ROWS, and the
 * `pfb_specificity_matches_target_chk` constraint keeps the number honest against the
 * column it describes.
 *
 * PURE, AND DELIBERATELY SO. Phase 7 owns the production `QuestionPackService` with its
 * caching and version pinning; this is the decision that service will make, extracted so
 * it can be tested at all six levels without a database. The SQL in `verify-question-packs`
 * answers the same question against live rows, and the parity test asserts the two agree —
 * because a resolver that disagrees with its own verifier is worse than either alone.
 *
 * PRIVACY: occupation reference data only.
 */

/** The ancestry of a pinned occupation. Codes are derivable from `isco_unit_code`. */
export interface OccupationKey {
  jobDomainId: string;
  iscoUnitCode: string | null;
}

/** A binding, as the resolver needs to see it. */
export interface ResolvableBinding {
  familyId: string;
  jobDomainId?: string | null;
  iscoUnitCode?: string | null;
  iscoMinorCode?: string | null;
  iscoSubmajorCode?: string | null;
  iscoMajorCode?: string | null;
  isUniversal?: boolean;
}

export interface FamilyResolution {
  familyId: string;
  specificity: number;
  /** Which level matched. Observability, and what a disambiguation log needs. */
  matchedOn: "job_domain" | "isco_unit" | "isco_minor" | "isco_submajor" | "isco_major" | "universal";
}

/**
 * Derive the ISCO ancestry from a unit code.
 *
 * MIRRORS THE GENERATED COLUMNS on `job_domain` (`left(isco_unit_code,3)` and
 * `left(isco_unit_code,2)`) rather than re-deciding the slicing. A unit code shorter than
 * the slice yields the short string rather than throwing, which is what `left()` does —
 * matching Postgres exactly matters because the parity test compares the two.
 */
export function iscoAncestry(iscoUnitCode: string | null): {
  minor: string | null;
  submajor: string | null;
  major: string | null;
} {
  if (iscoUnitCode === null || iscoUnitCode.length === 0) {
    return { minor: null, submajor: null, major: null };
  }
  return {
    minor: iscoUnitCode.slice(0, 3),
    submajor: iscoUnitCode.slice(0, 2),
    major: iscoUnitCode.slice(0, 1),
  };
}

/**
 * Resolve the family for a pinned occupation. `null` means not even a universal binding
 * exists — which the corpus validator and the deploy gate both refuse to allow, so it
 * should be unreachable in a seeded database and is returned rather than thrown so a
 * caller can degrade instead of crashing a live interview.
 *
 * TIES ARE STRUCTURALLY IMPOSSIBLE, not resolved here: six partial unique indexes mean
 * only one family can claim any given target. If two ever did, this returns the first in
 * input order — which is arbitrary, and precisely why the constraint exists rather than a
 * tie-break rule.
 */
export function resolveFamily(
  bindings: readonly ResolvableBinding[],
  key: OccupationKey,
): FamilyResolution | null {
  const { minor, submajor, major } = iscoAncestry(key.iscoUnitCode);

  const levels: { spec: number; on: FamilyResolution["matchedOn"]; hit: (b: ResolvableBinding) => boolean }[] = [
    { spec: 50, on: "job_domain", hit: (b) => b.jobDomainId === key.jobDomainId },
    { spec: 40, on: "isco_unit", hit: (b) => key.iscoUnitCode !== null && b.iscoUnitCode === key.iscoUnitCode },
    { spec: 30, on: "isco_minor", hit: (b) => minor !== null && b.iscoMinorCode === minor },
    { spec: 20, on: "isco_submajor", hit: (b) => submajor !== null && b.iscoSubmajorCode === submajor },
    { spec: 10, on: "isco_major", hit: (b) => major !== null && b.iscoMajorCode === major },
    { spec: 0, on: "universal", hit: (b) => b.isUniversal === true },
  ];

  for (const level of levels) {
    const match = bindings.find(level.hit);
    if (match !== undefined) {
      return { familyId: match.familyId, specificity: level.spec, matchedOn: level.on };
    }
  }
  return null;
}

/**
 * The SAME decision as one SQL statement, for the verifier and for Phase 7's repository.
 *
 * Kept beside the pure function on purpose: the parity test runs both against the same
 * bindings and asserts identical answers, so a change to one that is not mirrored in the
 * other turns red. That is the cheapest available guard against the resolver and its
 * deploy gate quietly disagreeing.
 */
export const RESOLVE_FAMILY_SQL = `
  SELECT b.family_id, b.specificity
    FROM profiling_family_binding b
    JOIN job_domain d ON d.job_domain_id = $1
   WHERE (b.job_domain_id      = d.job_domain_id)
      OR (b.isco_unit_code     = d.isco_unit_code)
      OR (b.isco_minor_code    = left(d.isco_unit_code, 3))
      OR (b.isco_submajor_code = left(d.isco_unit_code, 2))
      OR (b.isco_major_code    = left(d.isco_unit_code, 1))
      OR (b.is_universal)
   ORDER BY b.specificity DESC
   LIMIT 1`;
