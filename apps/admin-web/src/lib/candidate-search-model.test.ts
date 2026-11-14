import { describe, expect, it } from "vitest";
import {
  candidateFilterChips,
  candidateFiltersToForm,
  candidateFormToFilters,
  candidateViewHref,
  candidateViewParams,
  hasCandidateFilters,
  nextCandidateSort,
  parseCandidateQuery,
  withoutFilterChip,
  type CandidateSearchQuery,
} from "./candidate-search-model";

/**
 * The data bank's query arithmetic (A7, #2577): what a URL may set, what a view link writes,
 * the chips that remove one filter, and the sort toggle. The term is body-only, so it is absent
 * from every URL helper here by construction.
 */
const query: CandidateSearchQuery = {
  q: "Ramesh",
  filters: {
    status: ["active", "pending"],
    city: ["Pune"],
    min_experience_years: 3,
    has_resume: true,
    flagged: false,
    last_active_from: "2026-10-01T00:00:00.000Z",
    form_level: ["easy", "hard"],
  },
  sort: "total_experience_years",
  dir: "asc",
  page: 4,
  page_size: 25,
};

describe("parseCandidateQuery", () => {
  it("reads every filter kind, the order and the page", () => {
    const parsed = parseCandidateQuery(candidateViewHref(query));
    expect(parsed.filters).toEqual(query.filters);
    expect(parsed.sort).toBe(query.sort);
    expect(parsed.dir).toBe(query.dir);
    expect(parsed.page).toBe(query.page);
    expect(parsed.page_size).toBe(query.page_size);
    // The term is not in the URL, so parsing can only ever give an empty one.
    expect(parsed.q).toBeUndefined();
  });

  it("drops what the API would refuse, rather than breaking the page", () => {
    const parsed = parseCandidateQuery(
      "?sort=not_a_sort&dir=sideways&page=0&page_size=7&min_experience_years=-2&form_level=easy,nonsense",
    );
    expect(parsed.sort).toBe("last_active_at");
    expect(parsed.dir).toBe("desc");
    expect(parsed.page).toBe(1);
    expect(parsed.page_size).toBe(50);
    expect(parsed.filters.min_experience_years).toBeUndefined();
    expect(parsed.filters.form_level).toEqual(["easy"]);
  });

  it("treats a bare number as the first page and an empty filter as absent", () => {
    const parsed = parseCandidateQuery("?status=&city=Pune&page=2");
    expect(parsed.filters.status).toBeUndefined();
    expect(parsed.filters.city).toEqual(["Pune"]);
    expect(parsed.page).toBe(2);
  });
});

describe("the view URL", () => {
  it("writes every filter, and omits a default order/size to keep the link short", () => {
    const params = candidateViewParams({
      ...query,
      sort: "last_active_at",
      dir: "desc",
      page: 1,
      page_size: 50,
    });
    expect(params.status).toBe("active,pending");
    expect(params.city).toBe("Pune");
    expect(params.min_experience_years).toBe("3");
    expect(params.has_resume).toBe("true");
    expect(params.flagged).toBe("false");
    expect(params.last_active_from).toBe("2026-10-01");
    expect(params.sort).toBeUndefined();
    expect(params.dir).toBeUndefined();
    expect(params.page).toBeUndefined();
    expect(params.page_size).toBeUndefined();
  });

  it("never writes the search term", () => {
    const href = candidateViewHref(query, { c: "worker-1" });
    expect(href).not.toContain("Ramesh");
    expect(href).toContain("c=worker-1");
  });
});

describe("filters as chips", () => {
  it("renders one chip per array member and one per scalar filter", () => {
    const chips = candidateFilterChips(query.filters);
    expect(chips.map((c) => c.label)).toEqual([
      "Status: Active",
      "Status: Pending",
      "City: Pune",
      "Form level: Easy",
      "Form level: Hard",
      "Experience at least 3 yrs",
      "Has a resume",
      "Active from 2026-10-01",
      "Not flagged",
    ]);
  });

  it("removes one array member without touching its siblings", () => {
    const chip = candidateFilterChips(query.filters).find(
      (c) => c.key === "status" && c.value === "active",
    )!;
    const next = withoutFilterChip(query.filters, chip);
    expect(next.status).toEqual(["pending"]);
    expect(next.city).toEqual(["Pune"]);
  });

  it("removes a scalar filter entirely", () => {
    const chip = candidateFilterChips(query.filters).find((c) => c.key === "has_resume")!;
    expect(withoutFilterChip(query.filters, chip).has_resume).toBeUndefined();
  });

  it("knows when any filter is set", () => {
    expect(hasCandidateFilters({})).toBe(false);
    expect(hasCandidateFilters({ flagged: false })).toBe(true);
  });
});

describe("the filter form round-trip", () => {
  it("maps filters to strings and back", () => {
    expect(candidateFormToFilters(candidateFiltersToForm(query.filters))).toEqual(query.filters);
  });
});

describe("sorting", () => {
  it("reverses the active column and starts a new one at its own first direction", () => {
    expect(nextCandidateSort({ sort: "current_city", dir: "asc" }, "current_city")).toEqual({
      sort: "current_city",
      dir: "desc",
    });
    expect(
      nextCandidateSort({ sort: "current_city", dir: "asc" }, "total_experience_years"),
    ).toEqual({
      sort: "total_experience_years",
      dir: "desc",
    });
    expect(nextCandidateSort({ sort: "status", dir: "desc" }, "trade_label")).toEqual({
      sort: "trade_label",
      dir: "asc",
    });
  });
});

describe("#2752 part D — RVM students", () => {
  it("reads the linked/not-linked filter from a view URL", () => {
    expect(parseCandidateQuery("?institute_linked=true").filters.institute_linked).toBe(true);
    expect(parseCandidateQuery("?institute_linked=false").filters.institute_linked).toBe(false);
    expect(parseCandidateQuery("?institute_linked=").filters.institute_linked).toBeUndefined();
  });

  it("writes it back to a view URL and the panel form", () => {
    const params = candidateViewParams({
      filters: { institute_linked: true },
      sort: "last_active_at",
      dir: "desc",
      page: 1,
      page_size: 50,
    });
    expect(params.institute_linked).toBe("true");
    expect(candidateFiltersToForm({ institute_linked: false }).institute_linked).toBe("false");
    expect(candidateFormToFilters({ institute_linked: "true" })).toEqual({
      institute_linked: true,
    });
  });

  it("labels the chip as RVM students, never as a warning", () => {
    expect(candidateFilterChips({ institute_linked: true })).toEqual([
      { key: "institute_linked", label: "RVM students" },
    ]);
    expect(candidateFilterChips({ institute_linked: false })).toEqual([
      { key: "institute_linked", label: "Not RVM students" },
    ]);
  });

  it("counts it as an active filter", () => {
    expect(hasCandidateFilters({ institute_linked: false })).toBe(true);
  });
});
