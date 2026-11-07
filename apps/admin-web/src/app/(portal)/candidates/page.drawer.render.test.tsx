import { describe, expect, it } from "vitest";
import type { CandidateRow, CandidateSearchQuery } from "../../../lib/candidate-search-model";
import { candidateViewHref, parseCandidateQuery } from "../../../lib/candidate-search-model";

/**
 * A7 (#2577) — the data bank's drawer wiring and column contract, in the browser half:
 *
 *  - a row's drawer address is THIS list's view with `?c=<id>` added, and the body-only search
 *    term is never in it;
 *  - the drawer moves through the rows in the list's order, titled as the list names them;
 *  - the default columns are the issue's ten, the Name column exists only in the named posture,
 *    and every column sits in one of the four chooser groups.
 */
const { bankColumns, drawerRowsFor } = await import("./candidates-bank");

const W1 = "5eeded00-0001-4a00-8000-000000000001";
const W2 = "5eeded00-0002-4a00-8000-000000000002";

function row(id: string, name?: string | null): CandidateRow {
  return {
    worker_id: id,
    ...(name === undefined ? {} : { name }),
    status: "active",
    flagged: false,
    is_test_account: false,
    deletion_scheduled_at: null,
    employer_sharing_consent: true,
    current_city: "Pune",
    current_state: "Maharashtra",
    canonical_trade_id: "dom_welder",
    canonical_role_id: "role_tig_welder",
    job_domain_id: null,
    trade_label: "Welder",
    role_label: "TIG Welder",
    domain_label: "Welding",
    total_experience_years: "4",
    role_experience_months: 48,
    salary_min_inr: "12000",
    salary_max_inr: "18000",
    salary_period: "month",
    availability_status: "immediate",
    shift_preference: "day",
    form_level: "medium",
    skills: ["TIG welding"],
    languages: ["hindi"],
    education_level: "iti",
    resume_count: 1,
    latest_resume_status: "rendered",
    latest_resume_version: 2,
    profile_status: "confirmed",
    profile_source: "form",
    app_version: "1.2.3",
    last_active_at: "2026-11-06T09:00:00.000Z",
    created_at: "2026-08-19T09:00:00.000Z",
    updated_at: "2026-11-06T09:00:00.000Z",
    ai_cost_inr: "12.5",
    referral_source: null,
  };
}

const query: CandidateSearchQuery = {
  q: "Ramesh",
  filters: { status: ["active"], city: ["Pune"] },
  sort: "total_experience_years",
  dir: "desc",
  page: 3,
  page_size: 100,
};

describe("a row's drawer address", () => {
  it("is this list's view, with the row's id added — filters, order, page and size kept", () => {
    const href = candidateViewHref(query, { c: W1 });
    const url = new URL(href, "http://portal.invalid");
    expect(url.pathname).toBe("/candidates");
    expect(url.searchParams.get("status")).toBe("active");
    expect(url.searchParams.get("city")).toBe("Pune");
    expect(url.searchParams.get("sort")).toBe("total_experience_years");
    // `desc` is the default, so a clean view link may leave it out; parsing restores it.
    expect(url.searchParams.get("dir") ?? "desc").toBe("desc");
    expect(url.searchParams.get("page")).toBe("3");
    expect(url.searchParams.get("page_size")).toBe("100");
    expect(url.searchParams.get("c")).toBe(W1);
  });

  it("NEVER carries the search term — it is body-only", () => {
    expect(candidateViewHref(query)).not.toContain("Ramesh");
    expect(candidateViewHref(query)).not.toContain("q=");
  });

  it("parses the URL it wrote back to the same view (a reload, a shared link)", () => {
    const parsed = parseCandidateQuery(candidateViewHref(query));
    expect(parsed.filters).toEqual(query.filters);
    expect(parsed.sort).toBe(query.sort);
    expect(parsed.dir).toBe(query.dir);
    expect(parsed.page).toBe(query.page);
    expect(parsed.page_size).toBe(query.page_size);
  });
});

describe("the rows the drawer moves through", () => {
  it("are titled by the name in the named posture, and by the short id otherwise", () => {
    expect(drawerRowsFor([row(W1, "Ramesh Kumar"), row(W2, null)], true)).toEqual([
      { id: W1, title: "Ramesh Kumar" },
      // Disclosed, nobody on record: the id, never an empty title.
      { id: W2, title: "Candidate 5eed…0002" },
    ]);
    expect(drawerRowsFor([row(W1), row(W2)], false)).toEqual([
      { id: W1, title: "Candidate 5eed…0001" },
      { id: W2, title: "Candidate 5eed…0002" },
    ]);
  });
});

describe("the column set", () => {
  const names = (named: boolean) =>
    bankColumns(query, named, () => undefined)
      .filter((c) => c.defaultHidden !== true)
      .map((c) => c.header);

  it("defaults to the issue's ten columns", () => {
    expect(names(true)).toEqual([
      "Name",
      "ID",
      "Trade",
      "Experience",
      "City",
      "Status",
      "Profile",
      "Resume",
      "Last active",
      "Registered",
    ]);
  });

  it("has NO Name column for an analyst (faceless), and the id is then the row's handle", () => {
    expect(names(false)).toEqual([
      "Candidate",
      "Trade",
      "Experience",
      "City",
      "Status",
      "Profile",
      "Resume",
      "Last active",
      "Registered",
    ]);
  });

  it("groups every column Identity / Work / Activity / Account for the chooser", () => {
    const groups = new Set(bankColumns(query, true, () => undefined).map((c) => c.group));
    expect([...groups].sort()).toEqual(["Account", "Activity", "Identity", "Work"]);
  });

  it("makes the columns the API sorts by sortable, in place", () => {
    const sortable = bankColumns(query, true, () => undefined).filter((c) => c.sort);
    expect(sortable.map((c) => c.id)).toEqual(
      expect.arrayContaining([
        "trade",
        "experience",
        "city",
        "status",
        "profile",
        "resume",
        "lastActive",
        "registered",
      ]),
    );
    for (const column of sortable) expect(column.sort!.onSelect).toBeTypeOf("function");
    // The current order is marked on its own header.
    const experience = sortable.find((c) => c.id === "experience")!;
    expect(experience.sort!.direction).toBe("descending");
  });
});
