import { describe, expect, it } from "vitest";
import {
  candidateListHeading,
  candidateSearchBody,
  candidateSearchHref,
  candidateSortLink,
  candidateAvailabilityLabel,
  candidateExperienceLabel,
  candidateResumeLabel,
  candidateTradeLabel,
  normalizeSearchTerm,
  parseCandidateSearchParams,
  parseSavedViews,
  savedViewQuery,
  hasCandidateFilters,
  candidateFilterSet,
  UNIVERSAL_SEARCH_DEBOUNCE_MS,
  type CandidateSearchParams,
  type CandidateSearchRow,
} from "./candidate-search";

/**
 * The Candidates data-bank list's query vocabulary (A7, #2577) — pure, so every rule is
 * tested here rather than through a DOM.
 */
describe("parseCandidateSearchParams", () => {
  it("defaults to most-recently-active, page 1, fifty a page", () => {
    expect(parseCandidateSearchParams({})).toEqual({
      filters: {},
      sort: "last_active_at",
      dir: "desc",
      page: 1,
      pageSize: 50,
    });
  });

  it("reads every filter kind, and ignores unknown keys (the API body is .strict())", () => {
    const parsed = parseCandidateSearchParams({
      status: "active,suspended",
      city: "Pune",
      min_experience_years: "2",
      has_resume: "true",
      registered_from: "2026-01-01",
      sort: "trade_label",
      dir: "asc",
      page: "3",
      page_size: "25",
      c: "some-drawer-id",
      cursor: "stale",
      q: "never-in-url",
    });
    expect(parsed.filters).toEqual({
      status: ["active", "suspended"],
      city: ["Pune"],
      min_experience_years: "2",
      has_resume: "true",
      registered_from: "2026-01-01",
    });
    expect(parsed.sort).toBe("trade_label");
    expect(parsed.dir).toBe("asc");
    expect(parsed.page).toBe(3);
    expect(parsed.pageSize).toBe(25);
  });

  it("sanitizes paging and sort instead of asking for a 400", () => {
    const parsed = parseCandidateSearchParams({
      sort: "resume_show_photo",
      dir: "sideways",
      page: "0",
      page_size: "10",
    });
    expect(parsed.sort).toBe("last_active_at");
    expect(parsed.dir).toBe("desc");
    expect(parsed.page).toBe(1);
    expect(parsed.pageSize).toBe(50);
  });

  it("drops blank list members and blank values", () => {
    expect(parseCandidateSearchParams({ status: " , ", city: "" }).filters).toEqual({});
  });

  it("takes the first of a repeated key", () => {
    expect(parseCandidateSearchParams({ page: ["2", "5"] }).page).toBe(2);
  });
});

describe("hasCandidateFilters / candidateFilterSet", () => {
  it("is empty with no filter", () => {
    expect(hasCandidateFilters({})).toBe(false);
    expect(candidateFilterSet({})).toEqual({});
  });

  it("counts every filter kind", () => {
    const filters = { status: ["active"], city: ["Pune"], has_resume: "true" };
    expect(hasCandidateFilters(filters)).toBe(true);
    expect(candidateFilterSet(filters)).toEqual({
      status: "active",
      city: "Pune",
      has_resume: "true",
    });
  });
});

describe("candidateSearchBody", () => {
  it("a bare list is a bare-filters body: paging + sort, no filters key, no term", () => {
    expect(
      candidateSearchBody({ filters: {}, sort: "last_active_at", dir: "desc", page: 1, pageSize: 50 }),
    ).toEqual({ sort: "last_active_at", dir: "desc", page: 1, page_size: 50 });
  });

  it("coerces flags and numbers to the API's types, dropping the unparseable", () => {
    const body = candidateSearchBody({
      filters: {
        status: ["active"],
        has_resume: "true",
        flagged: "false",
        min_experience_years: "2",
        max_experience_years: "many",
        city: [],
      },
      sort: "created_at",
      dir: "asc",
      page: 2,
      pageSize: 25,
    });
    expect(body.filters).toEqual({
      status: ["active"],
      has_resume: true,
      flagged: false,
      min_experience_years: 2,
    });
  });

  it("carries the term only in the body — and never blank", () => {
    const base = { filters: {}, sort: "last_active_at", dir: "desc", page: 1, pageSize: 50 } as const;
    expect(candidateSearchBody({ ...base }).q).toBeUndefined();
    expect(candidateSearchBody({ ...base }, "  ").q).toBeUndefined();
    expect(candidateSearchBody({ ...base }, "welder").q).toBe("welder");
  });
});

describe("normalizeSearchTerm", () => {
  it("trims, collapses whitespace and caps at 200 chars", () => {
    expect(normalizeSearchTerm(undefined)).toBe("");
    expect(normalizeSearchTerm("   ")).toBe("");
    expect(normalizeSearchTerm("  welder  in   Pune ")).toBe("welder in Pune");
    expect(normalizeSearchTerm("x".repeat(300))).toHaveLength(200);
  });
});

describe("candidateSearchHref", () => {
  it("a bare list is the bare route — never /candidates?", () => {
    expect(
      candidateSearchHref("/candidates", {
        filters: {},
        sort: "last_active_at",
        dir: "desc",
        page: 1,
        pageSize: 50,
      }),
    ).toBe("/candidates");
  });

  it("keeps every filter, drops the first page and the defaults", () => {
    const href = candidateSearchHref("/candidates", {
      filters: { status: ["active", "suspended"], city: ["Pune"], has_resume: "true" },
      sort: "trade_label",
      dir: "asc",
      page: 3,
      pageSize: 25,
    });
    expect(href).toBe(
      "/candidates?status=active%2Csuspended&city=Pune&has_resume=true&sort=trade_label&dir=asc&page=3&page_size=25",
    );
  });

  it("merges the drawer's ?c= without losing the query", () => {
    const params: CandidateSearchParams = {
      filters: { status: ["active"] },
      sort: "last_active_at",
      dir: "desc",
      page: 2,
      pageSize: 50,
    };
    expect(candidateSearchHref("/candidates", params, { c: "w1" })).toBe(
      "/candidates?status=active&page=2&c=w1",
    );
  });
});

describe("candidateSortLink", () => {
  const params: CandidateSearchParams = {
    filters: { status: ["active"] },
    sort: "last_active_at",
    dir: "desc",
    page: 3,
    pageSize: 50,
  };

  it("a new column sorts descending from the first page, filters kept", () => {
    const link = candidateSortLink("/candidates", { ...params }, "trade_label");
    expect(link.href).toBe("/candidates?status=active&sort=trade_label");
    expect(link.direction).toBeUndefined();
  });

  it("the active column flips its direction, from the first page", () => {
    const link = candidateSortLink("/candidates", { ...params }, "last_active_at");
    // The flipped-to-ascending sort is explicit; the default sort key itself is omitted.
    expect(link.href).toBe("/candidates?status=active&dir=asc");
    expect(link.direction).toBe("descending");
  });
});

const row = (patch: Partial<CandidateSearchRow>): CandidateSearchRow => ({
  worker_id: "5eeded00-0001-4a00-8000-000000000001",
  status: "active",
  flagged: false,
  is_test_account: false,
  deletion_scheduled_at: null,
  current_city: "Pune",
  current_state: "Maharashtra",
  trade_label: "Welder",
  role_label: "TIG Welder",
  domain_label: "Fabrication",
  total_experience_years: "4",
  role_experience_months: 30,
  availability_status: "within_a_month",
  shift_preference: "day",
  form_level: "medium",
  languages: ["hi", "mr"],
  education_level: "10th pass",
  resume_count: 2,
  latest_resume_status: "rendered",
  profile_status: "confirmed",
  last_active_at: "2026-11-01T09:00:00.000Z",
  created_at: "2026-08-19T09:00:00.000Z",
  updated_at: "2026-08-19T09:00:00.000Z",
  ...patch,
});

describe("the row labels", () => {
  it("trade prefers the trade label, then role, then domain", () => {
    expect(candidateTradeLabel(row({}))).toBe("Welder");
    expect(candidateTradeLabel(row({ trade_label: null }))).toBe("TIG Welder");
    expect(candidateTradeLabel(row({ trade_label: null, role_label: null }))).toBe("Fabrication");
    expect(
      candidateTradeLabel(row({ trade_label: null, role_label: null, domain_label: null })),
    ).toBeNull();
  });

  it("experience reads in years, null when unstated, raw when unparseable", () => {
    expect(candidateExperienceLabel(row({}))).toBe("4 years");
    expect(candidateExperienceLabel(row({ total_experience_years: null }))).toBeNull();
    expect(candidateExperienceLabel(row({ total_experience_years: "3-5" }))).toBe("3-5");
  });

  it("resume leads with the count, then the newest state", () => {
    expect(candidateResumeLabel(row({}))).toBe("2 · Rendered");
    expect(candidateResumeLabel(row({ resume_count: 1, latest_resume_status: null }))).toBe("1");
    expect(candidateResumeLabel(row({ resume_count: 0, latest_resume_status: null }))).toBe("None");
  });

  it("availability is de-snaked, null when unstated", () => {
    expect(candidateAvailabilityLabel(row({}))).toBe("Within a month");
    expect(candidateAvailabilityLabel(row({ availability_status: null }))).toBeNull();
  });

  it("the results head carries the exact total, Indian-grouped", () => {
    expect(candidateListHeading(24310)).toBe("Candidates · 24,310");
    expect(candidateListHeading(0)).toBe("Candidates · 0");
  });
});

describe("saved views", () => {
  it("reads the stored views defensively", () => {
    expect(parseSavedViews(null)).toEqual([]);
    expect(parseSavedViews("not json")).toEqual([]);
    expect(parseSavedViews('{"name":"x"}')).toEqual([]);
    expect(
      parseSavedViews(
        JSON.stringify([
          { name: " Welders in Pune ", query: "status=active&city=Pune" },
          { name: "", query: "status=active" },
          { name: "evil", query: "q=welder" },
          { name: "ok", query: 42 },
        ]),
      ),
    ).toEqual([{ name: "Welders in Pune", query: "status=active&city=Pune" }]);
  });

  it("stores filters, sort and page size — never the page, never a term", () => {
    expect(
      savedViewQuery({
        filters: { status: ["active"], city: ["Pune"] },
        sort: "trade_label",
        dir: "asc",
        page: 4,
        pageSize: 25,
      }),
    ).toBe("status=active&city=Pune&sort=trade_label&dir=asc&page_size=25");
    expect(
      savedViewQuery({ filters: {}, sort: "last_active_at", dir: "desc", page: 1, pageSize: 50 }),
    ).toBe("");
  });
});

describe("the search contract", () => {
  it("debounces the universal search at 300ms", () => {
    expect(UNIVERSAL_SEARCH_DEBOUNCE_MS).toBe(300);
  });
});
