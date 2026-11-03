import { describe, expect, it } from "vitest";
import type { CandidateFilters } from "./contracts";
import {
  addressHasFilters,
  asksForOptions,
  candidateSearchBody,
  candidateSearchHref,
  countSummary,
  inboxRedirectHref,
  NO_SEARCH_FILTERS,
  parseCandidateSearchAddress,
  pickedRoleLabel,
  resolveCandidateSearch,
  searchFiltersKey,
} from "./candidate-search";

/**
 * All candidates (`/candidates`) — the pure reads behind the page: what the URL asks for, which of
 * it the options let through, the body sent, the links, and the count copy (ADR-0040 §1/§4).
 */

const CURSOR = "eyJ2IjoxLCJwIjoxfQ";
const OPTIONS: CandidateFilters = {
  roles: [
    { id: "mskill_cnc_turner", label: "CNC Turner", industryId: "ind_industrial_manufacturing" },
    { id: "mskill_vmc_operator", label: "VMC Operator", industryId: "ind_industrial_manufacturing" },
  ],
  industries: [{ id: "ind_industrial_manufacturing", label: "Industrial Manufacturing" }],
  experienceBuckets: [
    { id: "1_3", label: "1–3 years" },
    { id: "10_plus", label: "10+ years" },
  ],
  cities: ["Chennai", "Pune"],
  maxRoles: 5,
};

describe("parseCandidateSearchAddress — what the URL asks for", () => {
  it("nothing asked: no filter, not strict, no cursor", () => {
    expect(parseCandidateSearchAddress({})).toEqual({
      asked: { role: null, experience: null, industry: null, industryExperience: null, city: null },
      malformed: 0,
      strict: false,
      cursor: null,
    });
  });

  it("each control's key, trimmed; an empty value ('Any …') is no filter", () => {
    const a = parseCandidateSearchAddress({ role: " mskill_cnc_turner ", exp: "1_3", industry: "", indexp: "10_plus", city: "Pune" });
    expect(a.asked).toEqual({
      role: "mskill_cnc_turner",
      experience: "1_3",
      industry: null,
      industryExperience: "10_plus",
      city: "Pune",
    });
    expect(a.malformed).toBe(0);
  });

  it("strict is the checkbox's ONE value; anything else is malformed (and not strict)", () => {
    expect(parseCandidateSearchAddress({ strict: "1" }).strict).toBe(true);
    expect(parseCandidateSearchAddress({ strict: "" })).toMatchObject({ strict: false, malformed: 0 });
    for (const v of ["true", "on", "0", ["1", "1"]]) {
      expect(parseCandidateSearchAddress({ strict: v }), String(v)).toMatchObject({ strict: false, malformed: 1 });
    }
  });

  it("a repeated filter is malformed and asks for nothing", () => {
    const a = parseCandidateSearchAddress({ city: ["Pune", "Chennai"] });
    expect(a.asked.city).toBeNull();
    expect(a.malformed).toBe(1);
  });

  it("a cursor of the server's shape is kept as it is; any other shape is dropped", () => {
    expect(parseCandidateSearchAddress({ cursor: CURSOR }).cursor).toBe(CURSOR);
    for (const bad of ["", "has space", "a+b/c=", "x".repeat(257)]) {
      expect(parseCandidateSearchAddress({ cursor: bad }).cursor, bad).toBeNull();
    }
    expect(parseCandidateSearchAddress({ cursor: [CURSOR, CURSOR] }).cursor).toBeNull();
  });

  it("asksForOptions only for an option-backed filter; addressHasFilters for anything to clear", () => {
    expect(asksForOptions(parseCandidateSearchAddress({ strict: "1", cursor: CURSOR }))).toBe(false);
    expect(asksForOptions(parseCandidateSearchAddress({ city: "Pune" }))).toBe(true);
    expect(addressHasFilters(parseCandidateSearchAddress({}))).toBe(false);
    expect(addressHasFilters(parseCandidateSearchAddress({ cursor: CURSOR }))).toBe(false);
    expect(addressHasFilters(parseCandidateSearchAddress({ strict: "1" }))).toBe(true);
    expect(addressHasFilters(parseCandidateSearchAddress({ strict: "yes" }))).toBe(true);
    expect(addressHasFilters(parseCandidateSearchAddress({ role: "x" }))).toBe(true);
  });
});

describe("resolveCandidateSearch — only offered values are sent", () => {
  const resolveFor = (params: Record<string, string | string[]>, options: CandidateFilters | null = OPTIONS) =>
    resolveCandidateSearch(parseCandidateSearchAddress(params), options);

  it("every offered value passes, in the options' own spelling; the cursor is kept", () => {
    expect(
      resolveFor({ role: "MSKILL_CNC_TURNER", exp: "1_3", industry: "ind_industrial_manufacturing", indexp: "10_PLUS", city: "pune", strict: "1", cursor: CURSOR }),
    ).toEqual({
      query: {
        role: "mskill_cnc_turner",
        experience: "1_3",
        industry: "ind_industrial_manufacturing",
        industryExperience: "10_plus",
        city: "Pune",
        strict: true,
        cursor: CURSOR,
      },
      ignored: 0,
    });
  });

  it("a value not offered is dropped and counted — and drops the cursor (a position in the old order)", () => {
    const { query, ignored } = resolveFor({ role: "mskill_unknown", city: "Pune", cursor: CURSOR });
    expect(query).toEqual({ ...NO_SEARCH_FILTERS, city: "Pune" });
    expect(ignored).toBe(1);
  });

  it("an experience bucket is checked against the buckets for BOTH years filters", () => {
    expect(resolveFor({ exp: "3_5", indexp: "1_3" })).toEqual({
      query: { ...NO_SEARCH_FILTERS, industryExperience: "1_3" },
      ignored: 1,
    });
  });

  it("malformed params count as ignored and drop the cursor too", () => {
    expect(resolveFor({ strict: "yes", cursor: CURSOR })).toEqual({ query: NO_SEARCH_FILTERS, ignored: 1 });
  });

  it("options UNREAD: no asked filter can be checked — all are dropped (not counted), with the cursor", () => {
    expect(resolveFor({ role: "mskill_cnc_turner", strict: "1", cursor: CURSOR }, null)).toEqual({
      query: { ...NO_SEARCH_FILTERS, strict: true },
      ignored: 0,
    });
  });

  it("options unread but nothing asked: nothing to drop — strict and the cursor stay", () => {
    expect(resolveFor({ strict: "1", cursor: CURSOR }, null)).toEqual({
      query: { ...NO_SEARCH_FILTERS, strict: true, cursor: CURSOR },
      ignored: 0,
    });
  });
});

describe("candidateSearchBody — only the keys that are set (the API's defaults otherwise)", () => {
  it("the unfiltered first page is the empty body", () => {
    expect(candidateSearchBody(NO_SEARCH_FILTERS)).toEqual({});
  });

  it("every filter maps to its snake_case key; one role; strict only when on; limit only when named", () => {
    const q = {
      role: "mskill_cnc_turner",
      experience: "1_3",
      industry: "ind_industrial_manufacturing",
      industryExperience: "10_plus",
      city: "Pune",
      strict: true,
      cursor: CURSOR,
    };
    expect(candidateSearchBody(q)).toEqual({
      skill_ids: ["mskill_cnc_turner"],
      experience: "1_3",
      industry_id: "ind_industrial_manufacturing",
      industry_experience: "10_plus",
      city: "Pune",
      strict: true,
      cursor: CURSOR,
    });
    expect(candidateSearchBody({ ...NO_SEARCH_FILTERS, strict: false }, 20)).toEqual({ limit: 20 });
    expect(Object.keys(candidateSearchBody(q))).not.toContain("payer_id");
  });
});

describe("candidateSearchHref — the pager's and the states' links", () => {
  it("only the keys that are set, in the form's spelling — never an empty key", () => {
    expect(candidateSearchHref({})).toBe("/candidates");
    expect(candidateSearchHref(NO_SEARCH_FILTERS)).toBe("/candidates");
    expect(candidateSearchHref({ city: "Pune", strict: true, cursor: CURSOR })).toBe(
      `/candidates?city=Pune&strict=1&cursor=${CURSOR}`,
    );
    expect(
      candidateSearchHref({ role: "mskill_cnc_turner", experience: "1_3", industry: "ind_x", industryExperience: "10_plus" }),
    ).toBe("/candidates?role=mskill_cnc_turner&exp=1_3&industry=ind_x&indexp=10_plus");
  });

  it("a city is encoded, never spliced", () => {
    expect(candidateSearchHref({ city: "Navi Mumbai & Thane" })).toBe("/candidates?city=Navi+Mumbai+%26+Thane");
  });
});

describe("searchFiltersKey — a new selection is a new key; paging is not", () => {
  it("keys the filters, never the cursor", () => {
    const a = searchFiltersKey(NO_SEARCH_FILTERS);
    const b = searchFiltersKey({ ...NO_SEARCH_FILTERS, city: "Pune" });
    const c = searchFiltersKey({ ...NO_SEARCH_FILTERS, city: "Pune", strict: true });
    expect(new Set([a, b, c]).size).toBe(3);
    expect(searchFiltersKey({ ...NO_SEARCH_FILTERS, city: "Pune", cursor: CURSOR })).toBe(b);
  });
});

describe("inboxRedirectHref — an old inbox link goes on to /candidates/applied, query kept", () => {
  it("postingId or stage (even empty) is the inbox's address; the whole query rides along", () => {
    expect(inboxRedirectHref({ postingId: "p1" })).toBe("/candidates/applied?postingId=p1");
    expect(inboxRedirectHref({ stage: "new", cursor: CURSOR })).toBe(`/candidates/applied?stage=new&cursor=${CURSOR}`);
    expect(inboxRedirectHref({ postingId: "" })).toBe("/candidates/applied?postingId=");
    expect(inboxRedirectHref({ postingId: ["a", "b"] })).toBe("/candidates/applied?postingId=a&postingId=b");
  });

  it("anything else is no redirect — the shared cursor alone included", () => {
    expect(inboxRedirectHref({})).toBeNull();
    expect(inboxRedirectHref({ cursor: CURSOR, role: "mskill_cnc_turner" })).toBeNull();
  });

  it("the target is always this app's own path — a value never becomes the destination", () => {
    const to = inboxRedirectHref({ postingId: "//evil.example/x", stage: "https://evil.example" })!;
    expect(to.startsWith("/candidates/applied?")).toBe(true);
    expect(to).not.toContain("//evil");
  });
});

describe("pickedRoleLabel — what a related card is related TO", () => {
  it("the picked role's label from the options; null with no role filter or no options", () => {
    expect(pickedRoleLabel({ role: "mskill_vmc_operator" }, OPTIONS)).toBe("VMC Operator");
    expect(pickedRoleLabel({ role: null }, OPTIONS)).toBeNull();
    expect(pickedRoleLabel({ role: "mskill_vmc_operator" }, null)).toBeNull();
  });
});

describe("countSummary — three numbers, never folded (ADR-0040 §1/§4)", () => {
  const c = (over: Partial<Parameters<typeof countSummary>[0]> = {}) => ({
    total: 62,
    matched: 14,
    unrecorded: 9,
    filtered: true,
    strict: false,
    ...over,
  });

  it("unfiltered: '{total} candidates' (one reads in the singular)", () => {
    expect(countSummary(c({ filtered: false }))).toEqual({ line: "62 candidates", strictNote: null });
    expect(countSummary(c({ filtered: false, total: 1 }))?.line).toBe("1 candidate");
  });

  it("filtered: '{matched} of {total} match', plus ' · {unrecorded} not recorded' only when any", () => {
    expect(countSummary(c())).toEqual({ line: "14 of 62 match · 9 not recorded", strictNote: null });
    expect(countSummary(c({ unrecorded: 0 }))?.line).toBe("14 of 62 match");
    expect(countSummary(c({ matched: 0, unrecorded: 0 }))?.line).toBe("0 of 62 match");
  });

  it("strict says what the list shows — the matches, and the not-recorded ones when any", () => {
    expect(countSummary(c({ strict: true }))?.strictNote).toBe(
      "Only matches are shown, plus anyone whose profile doesn’t record a detail you filtered on.",
    );
    expect(countSummary(c({ strict: true, unrecorded: 0 }))?.strictNote).toBe("Only matches are shown.");
  });

  it("an empty pool has no count line at all (its state says so, with no zero shouted)", () => {
    expect(countSummary(c({ total: 0, matched: 0, unrecorded: 0 }))).toBeNull();
  });
});
