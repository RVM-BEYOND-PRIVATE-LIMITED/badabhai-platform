import { describe, expect, it } from "vitest";
import type { AgencyJob, PostingSummary } from "./contracts";
import {
  agencyPostingOptions,
  candidatePosting,
  candidatesHref,
  companyPostingOptions,
  parseCandidatesQuery,
  selectedPosting,
  withSelectedOption,
} from "./candidate-inbox";

/**
 * Candidates (`/candidates`) — the pure reads behind the page: what the URL asks for, where each
 * row's posting leads for THIS session, and what the posting filter offers.
 */

const P1 = "11111111-0000-4000-8000-000000000001";
const J1 = "22222222-0000-4000-8000-000000000001";
const CURSOR = "eyJ2IjoxLCJ0IjoiMjAyNi0xMC0wNyIsImlkIjoiYSJ9";

describe("parseCandidatesQuery — what the URL asks for", () => {
  it("no filter, or the form's empty 'All postings', is every posting", () => {
    expect(parseCandidatesQuery({})).toEqual({ filter: { kind: "all" }, cursor: null });
    expect(parseCandidatesQuery({ postingId: "" }).filter).toEqual({ kind: "all" });
  });

  it("a posting id narrows to that posting", () => {
    expect(parseCandidatesQuery({ postingId: P1 }).filter).toEqual({ kind: "posting", postingId: P1 });
  });

  it("a value that cannot be an id — or a repeated param — matches nothing, decided here", () => {
    expect(parseCandidatesQuery({ postingId: "not-an-id" }).filter).toEqual({
      kind: "unknown",
      raw: "not-an-id",
    });
    expect(parseCandidatesQuery({ postingId: [P1, J1] }).filter.kind).toBe("unknown");
  });

  it("carries a cursor the server could have minted, and drops any other shape", () => {
    expect(parseCandidatesQuery({ cursor: CURSOR }).cursor).toBe(CURSOR);
    expect(parseCandidatesQuery({ cursor: "" }).cursor).toBeNull();
    expect(parseCandidatesQuery({ cursor: "has space" }).cursor).toBeNull();
    expect(parseCandidatesQuery({ cursor: "a+b/c=" }).cursor).toBeNull(); // base64, not base64url
    expect(parseCandidatesQuery({ cursor: "x".repeat(257) }).cursor).toBeNull();
    expect(parseCandidatesQuery({ cursor: "x".repeat(256) }).cursor).toBe("x".repeat(256));
    expect(parseCandidatesQuery({ cursor: [CURSOR, CURSOR] }).cursor).toBeNull();
  });

  it("the filter's selected value: the id, the raw non-id, or none", () => {
    expect(selectedPosting({ kind: "all" })).toBeNull();
    expect(selectedPosting({ kind: "posting", postingId: P1 })).toBe(P1);
    expect(selectedPosting({ kind: "unknown", raw: "zz" })).toBe("zz");
  });
});

describe("candidatesHref — the pager's and the states' links", () => {
  it("only the keys that are set: never an empty postingId= or cursor=", () => {
    expect(candidatesHref({})).toBe("/candidates");
    expect(candidatesHref({ postingId: null, cursor: null })).toBe("/candidates");
    expect(candidatesHref({ postingId: P1 })).toBe(`/candidates?postingId=${P1}`);
    expect(candidatesHref({ cursor: CURSOR })).toBe(`/candidates?cursor=${CURSOR}`);
  });

  it("the next page keeps the posting filter", () => {
    expect(candidatesHref({ postingId: P1, cursor: CURSOR })).toBe(
      `/candidates?postingId=${P1}&cursor=${CURSOR}`,
    );
  });
});

describe("candidatePosting — a row's posting as THIS session may use it", () => {
  const company = { id: P1, title: "CNC Turner", kind: "company_posting" as const };
  const agency = { id: J1, title: "Fitter", kind: "agency_job" as const };
  const COMPANY = { isAgency: false, agencyPortalEnabled: true };
  const AGENCY = { isAgency: true, agencyPortalEnabled: true };

  it("a company's own posting: its details, and its card may spend", () => {
    expect(candidatePosting(company, COMPANY)).toEqual({
      id: P1,
      title: "CNC Turner",
      href: `/postings/${P1}`,
      viewOnly: false,
    });
  });

  it("an agency's own posting: the agency details page, and its card may spend", () => {
    expect(candidatePosting(agency, AGENCY)).toEqual({
      id: J1,
      title: "Fitter",
      href: `/agency/jobs/${J1}`,
      viewOnly: false,
    });
  });

  it("an agency's OLDER company posting: view-only and never linked (NAVIGATION.md)", () => {
    expect(candidatePosting(company, AGENCY)).toEqual({
      id: P1,
      title: "CNC Turner",
      href: null,
      viewOnly: true,
    });
  });

  it("an agency job for any other session — or with the agency portal off — has no page", () => {
    for (const viewer of [COMPANY, { isAgency: false, agencyPortalEnabled: false }, { isAgency: true, agencyPortalEnabled: false }]) {
      expect(candidatePosting(agency, viewer)).toMatchObject({ href: null, viewOnly: true });
    }
  });

  it("the id is always the row's own — it is the unlock's context whatever the link", () => {
    for (const viewer of [COMPANY, AGENCY]) {
      expect(candidatePosting(company, viewer).id).toBe(P1);
      expect(candidatePosting(agency, viewer).id).toBe(J1);
    }
  });
});

describe("the posting filter's options", () => {
  const summary = (id: string, roleTitle: string, status: PostingSummary["status"]): PostingSummary => ({
    id,
    roleTitle,
    status,
    locationLabel: null,
    vacancyBand: "2-5",
    applicantCount: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
  });
  const job = (id: string, title: string, status: AgencyJob["status"]) =>
    ({ id, title, status }) as AgencyJob;

  it("a company's own postings, in order; any status but open is named", () => {
    expect(
      companyPostingOptions([
        summary(P1, "CNC Turner", "open"),
        summary(J1, "CNC Turner", "paused"),
        summary("33333333-0000-4000-8000-000000000003", "Fitter", "draft"),
      ]),
    ).toEqual([
      { id: P1, label: "CNC Turner" },
      { id: J1, label: "CNC Turner (paused)" },
      { id: "33333333-0000-4000-8000-000000000003", label: "Fitter (draft)" },
    ]);
  });

  it("an agency's own postings (its jobs), the same way", () => {
    expect(agencyPostingOptions([job(J1, "Fitter", "open"), job(P1, "Welder", "closed")])).toEqual([
      { id: J1, label: "Fitter" },
      { id: P1, label: "Welder (closed)" },
    ]);
  });

  it("the current selection is always an option, named from the payer's own data or generically", () => {
    const options = [{ id: J1, label: "Fitter" }];
    // Already listed → unchanged.
    expect(withSelectedOption(options, J1, [])).toEqual(options);
    // Nothing selected → unchanged.
    expect(withSelectedOption(options, null, [])).toEqual(options);
    // Not in the list read, but a row on this page carries it → that row's title.
    expect(
      withSelectedOption(options, P1, [{ posting: { id: P1, title: "Old posting", kind: "company_posting" } }]),
    ).toEqual([...options, { id: P1, label: "Old posting" }]);
    // Known nowhere → a generic label, never a guess.
    expect(withSelectedOption([], "zz", [])).toEqual([{ id: "zz", label: "Selected posting" }]);
  });
});
