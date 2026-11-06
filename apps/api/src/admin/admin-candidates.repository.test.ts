import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { AdminCandidatesRepository, CANDIDATE_SEARCH_SORT_KEYS } from "./admin-candidates.repository";
import { CANDIDATE_SEARCH_SORTS } from "./admin-candidates.dto";

const repo = () => new AdminCandidatesRepository({} as never);

describe("AdminCandidatesRepository predicates (no DB — SQL shape only)", () => {
  it("filtersWhere is undefined with no filters, defined with any", () => {
    const r = repo();
    expect(r.filtersWhere({})).toBeUndefined();
    expect(r.filtersWhere({ flagged: true })).toBeDefined();
    expect(r.filtersWhere({ status: [] })).toBeUndefined();
  });

  it("searchWhere ORs the branches that run (undefined when none do)", () => {
    const r = repo();
    expect(r.searchWhere({ textLike: null, phoneHash: null, nameHashes: null })).toBeUndefined();
    expect(r.searchWhere({ textLike: "%x%", phoneHash: null, nameHashes: null })).toBeDefined();
    expect(
      r.searchWhere({ textLike: null, phoneHash: "h", nameHashes: [] }),
    ).toBeDefined();
  });

  it("identityWhere covers phone OR name only (never the text branch)", () => {
    const r = repo();
    expect(r.identityWhere({ phoneHash: null, nameHashes: null })).toBeUndefined();
    expect(r.identityWhere({ phoneHash: "h", nameHashes: null })).toBeDefined();
    expect(r.identityWhere({ phoneHash: null, nameHashes: ["a", "b"] })).toBeDefined();
  });

  it("sort keys stay exactly the DTO allow-list (drift 400s a legal sort)", () => {
    expect(CANDIDATE_SEARCH_SORT_KEYS).toEqual([...CANDIDATE_SEARCH_SORTS].sort());
  });
});
