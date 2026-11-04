import { describe, expect, it, vi, beforeEach } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  CandidateFilters,
  CandidateSearchPage,
  CandidateSearchRow,
} from "../../../lib/contracts";
import { PayerValidationError } from "../../../lib/payer-errors";

/**
 * /candidates PAGE — ALL CANDIDATES (owner rulings 2026-11-03; ADR-0040 E2): the Candidates tab
 * opens on everyone in the eligible pool, with a full filter set; the inbox is "Applied".
 *
 * Rendered whole through React's server renderer (as the inbox's page test does), so the claims
 * are about the HTML a payer gets — including the client card list, which SSRs with its initial
 * state. Seams, auth, flags, navigation, the server actions and next/link are mocked.
 *  - GATES: requirePayer first; an agency with the portal off is the neutral 404 before any read;
 *    `force-dynamic`. OLD INBOX LINKS (?postingId= / ?stage=) go to /candidates/applied, query
 *    kept, after the gates and before any read.
 *  - HEAD: one H1, one sentence, no back link; the view switch (All candidates current) and the
 *    filter form — five option selects, "Only show matches", Show, and Clear filters when there
 *    is something to clear.
 *  - WHAT IS SENT: only offered values (canonical spelling); a value not offered is dropped with
 *    one calm note and drops the cursor; with the options unread nothing is filtered. A FILTERED
 *    search waits for the options; an unfiltered one does not.
 *  - COUNTS: three numbers from the same response; "Other candidates" before the first non-match
 *    when filtered and not strict; strict says what it shows.
 *  - STATES: empty pool, strict zero (counts + the way back), end of list, 429, refused cursor,
 *    outage (Retry) — the head and filter never blank. Every link carries the pending cue.
 */

const requirePayer = vi.fn();
const agencyFlags = vi.fn();
const searchCandidates = vi.fn<(body?: unknown) => Promise<CandidateSearchPage>>();
const getCandidateFilters = vi.fn<() => Promise<CandidateFilters>>();
const getCredits = vi.fn();
const getUnlocks = vi.fn();
const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
const redirect = vi.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT ${to}`);
});

vi.mock("../../../lib/auth", () => ({ requirePayer: () => requirePayer() }));
vi.mock("../../../lib/config", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, agencyFlags: () => agencyFlags() };
});
vi.mock("next/navigation", () => ({
  notFound: () => notFound(),
  redirect: (to: string) => redirect(to),
}));
vi.mock("../../../lib/payer-api", () => ({
  searchCandidates: (body?: unknown) => searchCandidates(body),
  getCandidateFilters: () => getCandidateFilters(),
  getCredits: () => getCredits(),
  getUnlocks: () => getUnlocks(),
}));
vi.mock("../postings/[id]/applicants/actions", () => ({
  unlockAction: vi.fn(),
  candidateUnlockAction: vi.fn(),
  revealContactAction: vi.fn(),
  maskedResumeAction: vi.fn(),
}));
vi.mock("next/link", async () => {
  const React = await vi.importActual<typeof ReactModule>("react");
  return {
    // The pending cue inside each link reads its status (components/nav-pending.tsx): idle.
    useLinkStatus: () => ({ pending: false }),
    default: ({
      children,
      href,
      className,
      "aria-current": ariaCurrent,
    }: {
      children: ReactNode;
      href: string;
      className?: string;
      "aria-current"?: "page";
    }) => React.createElement("a", { href, className, "aria-current": ariaCurrent }, children),
  };
});
vi.mock("../../../components/retry-button", async () => {
  const React = await vi.importActual<typeof ReactModule>("react");
  return {
    RetryButton: ({ label = "Retry" }: { label?: string }) =>
      React.createElement("button", { type: "button", "data-retry": "" }, label),
  };
});

const mod = await import("./page");
const CandidatesPage = mod.default;
const { CandidateSearchList } = await import("./candidate-search-list");
const { CandidateSearchFilter } = await import("./candidate-search-filter");

const W1 = "face2000-0000-4000-8000-000000000001";
const W2 = "face2000-0000-4000-8000-000000000002";
const W3 = "face2000-0000-4000-8000-000000000003";
const CURSOR = "eyJ2IjoxLCJwIjoxLCJ0IjoyfQ";
const NEXT = "eyJ2IjoxLCJwIjowLCJ0IjoxfQ";

const FILTERS: CandidateFilters = {
  roles: [
    { id: "mskill_cnc_turner", label: "CNC Turner", industryId: "ind_industrial_manufacturing" },
    { id: "mskill_vmc_operator", label: "VMC Operator", industryId: "ind_industrial_manufacturing" },
  ],
  industries: [
    { id: "ind_industrial_manufacturing", label: "Industrial Manufacturing" },
    { id: "ind_quick_commerce", label: "Quick-commerce Delivery" },
  ],
  experienceBuckets: [
    { id: "under_1", label: "Under 1 year" },
    { id: "1_3", label: "1–3 years" },
    { id: "3_5", label: "3–5 years" },
  ],
  cities: ["Chennai", "Pune"],
  maxRoles: 5,
};

const row = (workerId: string, over: Partial<CandidateSearchRow> = {}): CandidateSearchRow => ({
  workerId,
  matchesFilters: true,
  matchTier: null,
  role: { id: "mskill_cnc_turner", label: "CNC Turner" },
  otherRoles: [],
  skillMonths: 48,
  industry: { id: "ind_industrial_manufacturing", label: "Industrial Manufacturing" },
  industryMonths: 54,
  city: "Pune",
  tradeLevels: [],
  isSample: false,
  ...over,
});

const page = (over: Partial<CandidateSearchPage> = {}): CandidateSearchPage => ({
  total: 62,
  matched: 62,
  unrecorded: 0,
  filtered: false,
  strict: false,
  candidates: [row(W1), row(W2, { role: { id: "mskill_vmc_operator", label: "VMC Operator" } })],
  nextCursor: null,
  ...over,
});

const FUTURE = new Date(Date.now() + 7 * 864e5).toISOString();
const unlock = (workerId: string, over: Record<string, unknown> = {}) => ({
  unlockId: `${workerId.slice(0, 8)}-1111-4111-8111-111111111111`,
  workerId,
  status: "granted",
  createdAt: "2026-09-01T00:00:00.000Z",
  expiresAt: FUTURE,
  ...over,
});

type Query = Record<string, string | string[] | undefined>;

async function tree(query: Query = {}): Promise<ReactElement> {
  return (await CandidatesPage({ searchParams: Promise.resolve(query) })) as ReactElement;
}
async function html(query: Query = {}): Promise<string> {
  return renderToStaticMarkup(await tree(query));
}
const textOf = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");
/** Every link → whether it carries the pending cue (the idle cue SSRs as its `nav-pending` span). */
const linkCue = (markup: string) =>
  new Map(
    Array.from(markup.matchAll(/<a href="([^"]*)"[^>]*>((?:(?!<\/a>)[\s\S])*)<\/a>/g), (m) => [
      m[1]!.replace(/&amp;/g, "&"),
      m[2]!.endsWith('<span class="nav-pending" aria-hidden="true"></span>'),
    ]),
  );
const hrefsIn = (markup: string) =>
  Array.from(markup.matchAll(/<a href="([^"]*)"/g), (m) => m[1]!.replace(/&amp;/g, "&"));
/** The markup of the state card (from its `.state` block to the end). */
const stateOf = (markup: string) => markup.slice(markup.indexOf('<div class="state'));
/** The markup of the card list (from `.applicants-list` to the end) — never the filter's options. */
const cardsOf = (markup: string) => {
  const at = markup.indexOf('<div class="applicants-list">');
  expect(at).toBeGreaterThan(0);
  return markup.slice(at);
};
const unlockButtons = (markup: string) =>
  Array.from(
    markup.matchAll(/<button([^>]*)>(?:(?!<\/button>)[\s\S])*?Unlock contact \(1 credit\)/g),
    (m) => m[1]!,
  );
/** Every select in the markup, by its `name`, to its inner markup — one literal pattern. */
const selectsOf = (markup: string) =>
  new Map(
    Array.from(
      markup.matchAll(/<select[^>]*\sname="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g),
      (m) => [m[1]!, m[2]!] as const,
    ),
  );
/** A select's options as [value, label], in order. */
const optionsOf = (markup: string, name: string) =>
  Array.from(
    (selectsOf(markup).get(name) ?? "").matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g),
    (m) => [m[1], m[2]],
  );
const selectedOf = (markup: string, name: string) =>
  /<option value="([^"]*)" selected="">/.exec(selectsOf(markup).get(name) ?? "")?.[1] ?? null;
/** The count line — the list's heading (#2588: where focus lands after paging). */
const count = (markup: string) =>
  /<h2 tabindex="-1" class="paged-list-heading candidate-search__count">([^<]*)<\/h2>/
    .exec(markup)?.[1]
    ?.replace(/&#x27;/g, "'") ?? null;
/** The props the page hands the ONE card list (they ride the RSC payload). */
async function listProps(query: Query = {}): Promise<Record<string, unknown>> {
  const t = (await tree(query)) as ReactElement<{ children: ReactNode[] }>;
  const lists = (t.props.children as ReactElement[]).filter((c) => c?.type === CandidateSearchList);
  expect(lists).toHaveLength(1);
  return (lists[0] as ReactElement<Record<string, unknown>>).props;
}
/** The key React reconciles the filter by (it rides the header's toolbar prop). */
function filterKey(node: unknown, seen = new Set<unknown>()): string | null | undefined {
  if (node === null || typeof node !== "object" || seen.has(node)) return undefined;
  seen.add(node);
  if (isValidElement(node)) {
    if (node.type === CandidateSearchFilter) return node.key;
    return filterKey(node.props, seen);
  }
  for (const v of Object.values(node)) {
    const k = filterKey(v, seen);
    if (k !== undefined) return k;
  }
  return undefined;
}

const COMPANY = { role: "employer" };
const AGENCY = { role: "agent" };
const READS = () => [searchCandidates, getCandidateFilters, getCredits, getUnlocks];

beforeEach(() => {
  requirePayer.mockReset().mockResolvedValue(COMPANY);
  agencyFlags.mockReset().mockReturnValue({ agencyPortalEnabled: true });
  searchCandidates.mockReset().mockResolvedValue(page());
  getCandidateFilters.mockReset().mockResolvedValue(FILTERS);
  getCredits.mockReset().mockResolvedValue({ payerId: "x", balance: 5 });
  getUnlocks.mockReset().mockResolvedValue([]);
  notFound.mockClear();
  redirect.mockClear();
});

describe("all candidates — gates first", () => {
  it("is force-dynamic (request-time reads, request-time unlock windows)", () => {
    expect(mod.dynamic).toBe("force-dynamic");
  });

  it("requirePayer runs FIRST: when it rejects, nothing is read and nothing redirects", async () => {
    requirePayer.mockRejectedValueOnce(new Error("NEXT_REDIRECT /login"));
    await expect(html({ postingId: "x" })).rejects.toThrow("NEXT_REDIRECT /login");
    for (const read of READS()) expect(read).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("an agency with the agency portal OFF gets the neutral 404 before any read (or redirect)", async () => {
    requirePayer.mockResolvedValue(AGENCY);
    agencyFlags.mockReturnValue({ agencyPortalEnabled: false });
    for (const q of [{}, { postingId: "x" }]) {
      await expect(html(q)).rejects.toThrow("NEXT_NOT_FOUND");
    }
    expect(notFound).toHaveBeenCalledTimes(2);
    for (const read of READS()) expect(read).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("both personas open it: a company (any flag), and an agency with the portal on", async () => {
    expect(await html()).toContain('<h1 class="page-head__title">Candidates</h1>');
    requirePayer.mockResolvedValueOnce(AGENCY);
    expect(await html()).toContain('<h1 class="page-head__title">Candidates</h1>');
    agencyFlags.mockReturnValue({ agencyPortalEnabled: false });
    expect(await html()).toContain('<h1 class="page-head__title">Candidates</h1>');
    expect(notFound).not.toHaveBeenCalled();
  });
});

describe("all candidates — an OLD inbox link still lands on the inbox (/candidates/applied)", () => {
  const P1 = "11111111-0000-4000-8000-000000000001";
  const OLD_LINKS: Array<[Query, string]> = [
    [{ postingId: P1 }, `/candidates/applied?postingId=${P1}`],
    [{ stage: "shortlist", cursor: CURSOR }, `/candidates/applied?stage=shortlist&cursor=${CURSOR}`],
    // The old form's "All postings" submitted an empty postingId: still the inbox's address.
    [{ postingId: "" }, "/candidates/applied?postingId="],
    [{ postingId: ["a", "b"], stage: "new" }, "/candidates/applied?postingId=a&postingId=b&stage=new"],
  ];
  it.each(OLD_LINKS)("%j → %s, before any read", async (q, to) => {
    await expect(html(q)).rejects.toThrow(`NEXT_REDIRECT ${to}`);
    expect(redirect).toHaveBeenCalledWith(to);
    for (const read of READS()) expect(read).not.toHaveBeenCalled();
  });

  it("a search address — and the shared cursor alone — is never redirected", async () => {
    await html({ role: "mskill_cnc_turner", cursor: CURSOR });
    await html({ cursor: CURSOR });
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe("all candidates — the head: one H1, the view switch, the filter", () => {
  /** The view switch's links as [href, class, current]. */
  const viewLinks = (markup: string) =>
    Array.from(
      (/<nav class="bb-tabs bb-tabs--underline candidates-views" aria-label="Candidate lists">([\s\S]*?)<\/nav>/.exec(
        markup,
      )?.[1] ?? "").matchAll(/<a href="([^"]*)" class="([^"]*)"( aria-current="page")?>/g),
      (m) => [m[1], m[2], m[3] !== undefined],
    );

  it("ONE PageHeader: a one-sentence description, no back link, no action group", async () => {
    const out = await html();
    expect(out.match(/<h1 /g)).toHaveLength(1);
    expect(out).not.toContain("page-back");
    expect(out).not.toContain("page-head__actions");
    expect(textOf(out)).toContain("Everyone you can unlock on BadaBhai");
    expect(out).toMatch(/^<div class="applicants-page candidates-page">/);
  });

  it("the view switch: All candidates is current, Applied one click away — both cued — above the filter", async () => {
    for (const read of [page(), page({ total: 0, matched: 0, candidates: [] })]) {
      searchCandidates.mockResolvedValueOnce(read);
      const out = await html();
      expect(viewLinks(out)).toEqual([
        ["/candidates", "bb-tab bb-tab--active", true],
        ["/candidates/applied", "bb-tab", false],
      ]);
      const toolbar = out.slice(out.indexOf('<div class="page-head__toolbar">'));
      expect(toolbar.indexOf("candidates-views")).toBeGreaterThan(0);
      expect(toolbar.indexOf("candidates-views")).toBeLessThan(toolbar.indexOf("<form "));
      const cues = linkCue(out);
      expect(cues.get("/candidates")).toBe(true);
      expect(cues.get("/candidates/applied")).toBe(true);
    }
  });

  it("the filter: a plain GET form to /candidates with five labelled selects, the strict box and Show", async () => {
    const out = await html();
    const form = /<form class="candidates-filter__form"[^>]*>/.exec(out)?.[0] ?? "";
    for (const attr of ['method="get"', 'action="/candidates"', 'role="search"']) {
      expect(form, attr).toContain(attr);
    }
    for (const [id, name, label] of [
      ["candidate-search-role", "role", "Role"],
      ["candidate-search-exp", "exp", "Years in role"],
      ["candidate-search-industry", "industry", "Industry"],
      ["candidate-search-indexp", "indexp", "Years in industry"],
      ["candidate-search-city", "city", "City"],
    ] as const) {
      expect(out).toContain(`<label class="bb-field__label" for="${id}">${label}</label>`);
      expect(out).toMatch(new RegExp(`<select id="${id}" class="[^"]*" name="${name}"`));
    }
    expect(out).toMatch(/<input type="checkbox" name="strict" value="1"\/>/);
    expect(textOf(out)).toContain("Only show matches");
    expect(out).toMatch(/<button type="submit" class="bb-btn bb-btn--secondary">[\s\S]*Show/);
    // A new filter starts at the first page: the form carries no cursor.
    expect(out).not.toContain('name="cursor"');
    // Nothing in the address to clear: no Clear filters.
    expect(textOf(out)).not.toContain("Clear filters");
  });

  it("the options are the filters read's, after each control's Any …", async () => {
    const out = await html();
    expect(optionsOf(out, "role")).toEqual([
      ["", "Any role"],
      ["mskill_cnc_turner", "CNC Turner"],
      ["mskill_vmc_operator", "VMC Operator"],
    ]);
    const buckets = [
      ["", "Any years"],
      ["under_1", "Under 1 year"],
      ["1_3", "1–3 years"],
      ["3_5", "3–5 years"],
    ];
    expect(optionsOf(out, "exp")).toEqual(buckets);
    expect(optionsOf(out, "indexp")).toEqual(buckets);
    expect(optionsOf(out, "industry")).toEqual([
      ["", "Any industry"],
      ["ind_industrial_manufacturing", "Industrial Manufacturing"],
      ["ind_quick_commerce", "Quick-commerce Delivery"],
    ]);
    expect(optionsOf(out, "city")).toEqual([
      ["", "Any city"],
      ["Chennai", "Chennai"],
      ["Pune", "Pune"],
    ]);
  });

  it("the controls show what the list was read with; strict is ticked; Clear filters appears (cued)", async () => {
    const out = await html({ role: "mskill_vmc_operator", exp: "1_3", industry: "ind_quick_commerce", indexp: "3_5", city: "pune", strict: "1" });
    expect(selectedOf(out, "role")).toBe("mskill_vmc_operator");
    expect(selectedOf(out, "exp")).toBe("1_3");
    expect(selectedOf(out, "industry")).toBe("ind_quick_commerce");
    expect(selectedOf(out, "indexp")).toBe("3_5");
    expect(selectedOf(out, "city")).toBe("Pune"); // the option's own spelling
    expect(out).toMatch(/<input type="checkbox" name="strict" checked="" value="1"\/>/);
    expect(linkCue(out).get("/candidates")).toBe(true);
    expect(textOf(out)).toContain("Clear filters");
  });

  it("a FAILED options read: every control offers only Any …, one note says why, the list still renders", async () => {
    getCandidateFilters.mockRejectedValueOnce(new Error("503"));
    const out = await html();
    for (const name of ["role", "exp", "industry", "indexp", "city"]) {
      expect(optionsOf(out, name), name).toHaveLength(1);
      expect(optionsOf(out, name)[0]![0]).toBe("");
    }
    expect(out.match(/candidates-filter__note/g)).toHaveLength(1);
    expect(textOf(out)).toContain("The filter options didn’t load");
    expect(out.match(/aria-describedby="candidate-search-options-note"/g)).toHaveLength(5);
    expect(out.match(/bb-avatar--masked/g)).toHaveLength(2);
    expect(out).not.toContain("couldn’t load candidates");
  });

  it("a new selection remounts the filter (a kept <select> ignores a new defaultValue); paging does not", async () => {
    const a = filterKey(await tree());
    const b = filterKey(await tree({ role: "mskill_cnc_turner" }));
    const c = filterKey(await tree({ role: "mskill_cnc_turner", strict: "1" }));
    expect(a).not.toBeUndefined();
    expect(new Set([a, b, c]).size).toBe(3);
    expect(filterKey(await tree({ role: "mskill_cnc_turner", cursor: CURSOR }))).toBe(b);
  });
});

describe("all candidates — what is SENT: only values the options offer", () => {
  it("no filter → the unfiltered first page, `{}` (the API's defaults)", async () => {
    await html();
    expect(searchCandidates).toHaveBeenCalledTimes(1);
    expect(searchCandidates).toHaveBeenCalledWith({});
  });

  it("every filter, strict and a cursor → the snake_case body, one role", async () => {
    await html({ role: "mskill_cnc_turner", exp: "1_3", industry: "ind_industrial_manufacturing", indexp: "3_5", city: "Pune", strict: "1", cursor: CURSOR });
    expect(searchCandidates).toHaveBeenCalledWith({
      skill_ids: ["mskill_cnc_turner"],
      experience: "1_3",
      industry_id: "ind_industrial_manufacturing",
      industry_experience: "3_5",
      city: "Pune",
      strict: true,
      cursor: CURSOR,
    });
  });

  it("each select's Any … (an empty value) is no filter", async () => {
    await html({ role: "", exp: "", industry: "", indexp: "", city: "" });
    expect(searchCandidates).toHaveBeenCalledWith({});
  });

  it("a hand-typed case is the offered value, in its own spelling", async () => {
    await html({ city: "PUNE", role: "MSKILL_CNC_TURNER" });
    expect(searchCandidates).toHaveBeenCalledWith({ skill_ids: ["mskill_cnc_turner"], city: "Pune" });
  });

  it("a value NOT offered is never sent — the rest is, the cursor is dropped, and one calm note says so", async () => {
    const out = await html({ role: "mskill_unknown", city: "Pune", cursor: CURSOR });
    expect(searchCandidates).toHaveBeenCalledWith({ city: "Pune" });
    expect(textOf(out)).toContain("A filter in this link isn’t available, so it was ignored.");
    expect(selectedOf(out, "role")).toBe(""); // the control says what the list was read with
    expect(out).not.toContain("data-retry");
  });

  it("two dropped (or a repeated param, or a strict no control submits) say it once, in the plural", async () => {
    const out = await html({ role: "mskill_unknown", exp: "forever", city: ["Pune", "Chennai"], strict: "yes" });
    expect(searchCandidates).toHaveBeenCalledWith({});
    expect(textOf(out)).toContain("Some filters in this link aren’t available, so they were ignored.");
    expect(out.match(/candidates-filter__note/g)).toHaveLength(1);
  });

  it("with the options UNREAD, no filter can be checked, so none is sent (nor the cursor) — the unavailable note says it", async () => {
    getCandidateFilters.mockRejectedValueOnce(new Error("503"));
    const out = await html({ role: "mskill_cnc_turner", strict: "1", cursor: CURSOR });
    expect(searchCandidates).toHaveBeenCalledWith({ strict: true });
    expect(textOf(out)).toContain("The filter options didn’t load");
    expect(textOf(out)).not.toContain("was ignored");
  });

  it("UNFILTERED, the search is read beside the options (it never waits for them)", async () => {
    let release: (f: CandidateFilters) => void = () => {};
    getCandidateFilters.mockReturnValueOnce(new Promise<CandidateFilters>((r) => (release = r)));
    const rendering = html();
    await new Promise((r) => setTimeout(r, 0));
    expect(searchCandidates).toHaveBeenCalledTimes(1);
    release(FILTERS);
    await rendering;
  });

  it("FILTERED, the search waits for the options (it sends only what they offer)", async () => {
    let release: (f: CandidateFilters) => void = () => {};
    getCandidateFilters.mockReturnValueOnce(new Promise<CandidateFilters>((r) => (release = r)));
    const rendering = html({ role: "mskill_cnc_turner" });
    await new Promise((r) => setTimeout(r, 0));
    expect(searchCandidates).not.toHaveBeenCalled();
    release(FILTERS);
    await rendering;
    expect(searchCandidates).toHaveBeenCalledWith({ skill_ids: ["mskill_cnc_turner"] });
  });
});

describe("all candidates — the list and its counts (ADR-0040 Decision 3)", () => {
  it("unfiltered: '{total} candidates', one faceless card per row, no divider", async () => {
    const out = await html();
    expect(count(out)).toBe("62 candidates");
    expect(out.match(/bb-avatar--masked/g)).toHaveLength(2);
    expect(unlockButtons(out)).toHaveLength(2);
    expect(textOf(out)).toContain("Candidates are faceless until unlocked.");
    expect(out).not.toContain("candidate-search__divider");
    await listProps(); // exactly one card list → exactly one ConfirmSpendDialog
  });

  it("one candidate reads in the singular", async () => {
    searchCandidates.mockResolvedValueOnce(page({ total: 1, matched: 1, candidates: [row(W1)] }));
    expect(count(await html())).toBe("1 candidate");
  });

  it("filtered: '{matched} of {total} match · {unrecorded} not recorded', and 'Other candidates' before the first non-match", async () => {
    searchCandidates.mockResolvedValueOnce(
      page({
        filtered: true,
        matched: 14,
        unrecorded: 9,
        candidates: [row(W1), row(W2, { matchesFilters: false }), row(W3, { matchesFilters: false })],
      }),
    );
    const out = await html({ role: "mskill_cnc_turner" });
    expect(count(out)).toBe("14 of 62 match · 9 not recorded");
    expect(out.match(/<h2 class="candidate-search__divider">Other candidates<\/h2>/g)).toHaveLength(1);
    // It sits AFTER the first card (a match) and BEFORE the second (the first non-match).
    const cards = [...out.matchAll(/class="bb-card applicant"/g)].map((m) => m.index!);
    const divider = out.indexOf("candidate-search__divider");
    expect(divider).toBeGreaterThan(cards[0]!);
    expect(divider).toBeLessThan(cards[1]!);
    expect(out).not.toContain("candidate-search__note");
  });

  it("a role-only filter (never unrecorded) has no 'not recorded' part; a page of matches only: no divider", async () => {
    searchCandidates.mockResolvedValueOnce(page({ filtered: true, matched: 14 }));
    const out = await html({ role: "mskill_cnc_turner" });
    expect(count(out)).toBe("14 of 62 match");
    expect(out).not.toContain("candidate-search__divider");
  });

  it("a filter that CAN meet an unrecorded value says the third number even at 0 (ADR-0040 §4)", async () => {
    searchCandidates.mockResolvedValueOnce(page({ filtered: true, matched: 14 }));
    const out = await html({ city: "Pune" });
    expect(count(out)).toBe("14 of 62 match · 0 not recorded");
  });

  it("a later page that starts with non-matches opens with the divider", async () => {
    searchCandidates.mockResolvedValueOnce(
      page({ filtered: true, matched: 14, candidates: [row(W1, { matchesFilters: false })] }),
    );
    const out = await html({ city: "Pune", cursor: CURSOR });
    expect(out.indexOf("candidate-search__divider")).toBeLessThan(out.indexOf('class="bb-card applicant"'));
  });

  it("STRICT: the counts, and that the list shows only matches (plus the not-recorded) — no divider", async () => {
    searchCandidates.mockResolvedValueOnce(
      page({ filtered: true, strict: true, matched: 14, unrecorded: 9, candidates: [row(W1), row(W2, { matchesFilters: false })] }),
    );
    const out = await html({ city: "Pune", strict: "1" });
    expect(count(out)).toBe("14 of 62 match · 9 not recorded");
    expect(textOf(out)).toContain(
      "Only matches are shown, plus anyone whose profile doesn’t record a detail you filtered on.",
    );
    expect(out).not.toContain("candidate-search__divider");
    searchCandidates.mockResolvedValueOnce(page({ filtered: true, strict: true, matched: 2 }));
    expect(textOf(await html({ city: "Pune", strict: "1" }))).toContain("Only matches are shown.");
  });

  it("the card: role first; related says to WHAT; years in role; industry and its years (or not recorded); city only when recorded; other roles; the rung", async () => {
    searchCandidates.mockResolvedValueOnce(
      page({
        filtered: true,
        matched: 1,
        candidates: [
          row(W1, {
            matchTier: 2,
            role: { id: "mskill_vmc_operator", label: "VMC Operator" },
            otherRoles: [
              { id: "mskill_a", label: "Role A" },
              { id: "mskill_b", label: "Role B" },
              { id: "mskill_c", label: "Role C" },
              { id: "mskill_d", label: "Role D" },
              { id: "mskill_e", label: "Role E" },
            ],
            skillMonths: 54,
            industryMonths: null,
            city: null,
            tradeLevels: [
              { skillId: "mskill_cnc_turner", skillLabel: "CNC Turner", tradeLevel: "helper", tradeLevelLabel: "Helper", levelConfirmed: true },
              { skillId: "mskill_vmc_operator", skillLabel: "VMC Operator", tradeLevel: "setter", tradeLevelLabel: "Setter", levelConfirmed: true },
            ],
          }),
        ],
      }),
    );
    const card = cardsOf(await html({ role: "mskill_cnc_turner" }));
    expect(card).toContain('<span class="applicant__trade">VMC Operator</span>');
    expect(card).toContain('<span class="bb-badge bb-badge--info">Related to CNC Turner</span>');
    expect(card).toContain('<span class="applicant__bands">4.5 yrs in role</span>');
    expect(card).toContain(
      '<span class="applicant__bands">Industrial Manufacturing · years not recorded</span>',
    );
    // No city recorded: none is shown (the filter's own options are outside the cards).
    expect(card).not.toContain("Pune");
    // The rung for THIS card's role (by id) — never the other trade's.
    expect(card).toContain(
      '<span class="bb-badge bb-badge--neutral bb-badge--outline applicant__level">Setter</span>',
    );
    expect(card).not.toContain(">Helper<");
    // Four other roles at most, as tags, under a visible "Other roles".
    expect(textOf(card)).toContain("Other roles");
    for (const label of ["Role A", "Role B", "Role C", "Role D"]) expect(card).toContain(`>${label}</span>`);
    expect(card).not.toContain("Role E");
  });

  it("a recorded city and industry tenure read in full; a tier-1 card wears no related badge", async () => {
    searchCandidates.mockResolvedValueOnce(page({ candidates: [row(W1, { matchTier: 1 })] }));
    const card = cardsOf(await html());
    expect(card).toContain('<span class="applicant__bands">4 yrs in role · Pune</span>');
    expect(card).toContain(
      '<span class="applicant__bands">Industrial Manufacturing · 4.5 yrs in industry</span>',
    );
    expect(card).not.toContain("Related");
  });

  it("R74: a SAMPLE card wears the neutral 'Sample candidate' badge and offers no Unlock", async () => {
    searchCandidates.mockResolvedValueOnce(
      page({ candidates: [row(W1), row(W2, { isSample: true })] }),
    );
    const out = cardsOf(await html());
    const badge = '<span class="bb-badge bb-badge--neutral">Sample candidate</span>';
    expect(out.split(badge)).toHaveLength(2); // exactly one — on the sample card only
    expect(out).toContain('<p class="applicant__neutral">Sample profile — can’t be unlocked</p>');
    // One Unlock (the real card's), and it comes BEFORE the sample card's badge.
    expect(unlockButtons(out)).toHaveLength(1);
    expect(out.indexOf("Unlock contact (1 credit)")).toBeLessThan(out.indexOf(badge));
    expect(textOf(out)).toContain("Worker ••0002"); // the masked handle stays
  });

  it("FACELESS: no phone/email-shaped run and never a full worker id in the visible text", async () => {
    const text = textOf(await html());
    expect(text).not.toMatch(/\d{10,}/);
    expect(text).not.toMatch(/\+\d{7,}/);
    expect(text).not.toMatch(/@/);
    for (const id of [W1, W2]) expect(text).not.toContain(id);
    // The handle is the id's LAST four digits — distinct per card even where every id shares its
    // prefix (the synthetic face2000… cohort), and the payer app's own label.
    expect(text).toContain("Worker ••0001");
    expect(text).toContain("Worker ••0002");
    expect(text).not.toContain("face2000…");
  });

  it("hands the list the related-to label, the counts only (not the rows twice), and live grants for THIS page", async () => {
    getUnlocks.mockResolvedValueOnce([
      unlock(W1),
      unlock(W3), // not on this page
      unlock(W2, { status: "expired" }),
    ]);
    const props = await listProps({ role: "mskill_cnc_turner" });
    expect(props.relatedTo).toBe("CNC Turner");
    expect(props.counts).toEqual({
      total: 62,
      matched: 62,
      unrecorded: 0,
      filtered: false,
      strict: false,
      unrecordable: false, // a role filter can never meet an unrecorded value
    });
    expect(props.unlocked).toEqual({
      [W1]: { kind: "granted", unlockId: unlock(W1).unlockId, expiresAt: FUTURE },
    });
  });

  it("an already-unlocked card starts unlocked; the masked résumé shows only on an unlocked card", async () => {
    getUnlocks.mockResolvedValueOnce([unlock(W1)]);
    const out = await html();
    expect(unlockButtons(out)).toHaveLength(1);
    expect(out.match(/Open contact/g)).toHaveLength(1);
    expect(out.match(/View masked resume/g)).toHaveLength(1);
    getUnlocks.mockResolvedValueOnce([]);
    expect(await html()).not.toContain("View masked resume");
  });

  it("the balance is an affordance: unread keeps Unlock enabled; only a real zero disables it", async () => {
    getCredits.mockRejectedValueOnce(new Error("503"));
    for (const t of unlockButtons(await html())) expect(t).not.toMatch(/\bdisabled\b/);
    getCredits.mockResolvedValueOnce({ payerId: "x", balance: 0 });
    const zero = await html();
    expect(unlockButtons(zero)).toHaveLength(2);
    for (const t of unlockButtons(zero)) expect(t).toMatch(/\bdisabled\b/);
    expect(zero).toContain('href="/credits"');
  });
});

describe("all candidates — states (the head and filter never blank)", () => {
  const headKept = (out: string) => {
    expect(out).toContain('<h1 class="page-head__title">Candidates</h1>');
    expect(out).toContain('action="/candidates"');
    expect(out).toContain("candidates-views");
  };

  it("an EMPTY POOL: a calm 'No candidates to show yet' — no counts shouting zero, no Retry", async () => {
    searchCandidates.mockResolvedValueOnce(page({ total: 0, matched: 0, candidates: [] }));
    const out = await html();
    headKept(out);
    expect(stateOf(out)).toContain("No candidates to show yet");
    expect(textOf(stateOf(out))).not.toMatch(/\d/);
    expect(count(out)).toBeNull();
    expect(out).not.toContain("data-retry");
  });

  it("a STRICT search that matches nobody: its counts and the way back to everyone (strict dropped, filters kept)", async () => {
    searchCandidates.mockResolvedValueOnce(
      page({ filtered: true, strict: true, matched: 0, unrecorded: 0, candidates: [] }),
    );
    const out = await html({ role: "mskill_cnc_turner", city: "Pune", strict: "1" });
    headKept(out);
    const state = stateOf(out);
    expect(textOf(state)).toContain("No candidates match every filter");
    expect(textOf(state)).toContain("0 of 62 match");
    expect(hrefsIn(state)).toEqual(["/candidates?role=mskill_cnc_turner&city=Pune"]);
    expect(textOf(state)).toContain("Show all candidates");
    expect(linkCue(state).get("/candidates?role=mskill_cnc_turner&city=Pune")).toBe(true);
    expect(out).not.toContain("data-retry");
  });

  it("a later page with nothing left: 'No more candidates', and the pager's First page (filters kept)", async () => {
    searchCandidates.mockResolvedValueOnce(page({ filtered: true, matched: 3, candidates: [] }));
    const out = await html({ city: "Pune", cursor: CURSOR });
    expect(stateOf(out)).toContain("No more candidates");
    expect(hrefsIn(stateOf(out))).toEqual(["/candidates?city=Pune"]);
  });

  it("429: a neutral 'too many requests' — not the failure copy, no counts, a way to try again", async () => {
    searchCandidates.mockRejectedValueOnce(new Error("payer API /payer/candidates/search returned 429"));
    const out = await html();
    headKept(out);
    const state = stateOf(out);
    expect(state.startsWith('<div class="state">')).toBe(true);
    expect(textOf(state)).toContain("Too many requests");
    expect(state).toContain('data-retry="">Try again</button>');
    expect(out).not.toContain("couldn’t load");
    expect(count(out)).toBeNull();
  });

  it("a REFUSED page cursor (a 400 with a cursor): First page with the filters kept, never Retry", async () => {
    for (const refusal of [
      new PayerValidationError("/payer/candidates/search", [{ path: "cursor", message: "cursor is malformed" }]),
      new Error("payer API /payer/candidates/search returned 400"),
    ]) {
      searchCandidates.mockRejectedValueOnce(refusal);
      const out = await html({ city: "Pune", strict: "1", cursor: "abc" });
      expect(searchCandidates).toHaveBeenLastCalledWith({ city: "Pune", strict: true, cursor: "abc" });
      headKept(out);
      const state = stateOf(out);
      expect(state.startsWith('<div class="state">')).toBe(true);
      expect(textOf(state)).toContain("This page link isn’t valid");
      expect(out).not.toContain("data-retry");
      expect(hrefsIn(state)).toEqual(["/candidates?city=Pune&strict=1"]);
      expect(out).not.toContain("candidates-pager");
    }
  });

  it("a 400 with NO cursor is an outage (Retry, no First page); a later page's outage offers both", async () => {
    searchCandidates.mockRejectedValueOnce(new Error("payer API /payer/candidates/search returned 400"));
    const out = await html({ city: "Pune" });
    headKept(out);
    expect(stateOf(out)).toContain('<div class="state state--error">');
    expect(textOf(stateOf(out))).toContain("We couldn’t load candidates");
    expect(stateOf(out)).toContain('data-retry="">Retry</button>');
    expect(textOf(out)).not.toContain("First page");
    searchCandidates.mockRejectedValueOnce(new Error("payer API /payer/candidates/search returned 502"));
    const later = stateOf(await html({ city: "Pune", cursor: CURSOR }));
    expect(later).toContain('data-retry="">Retry</button>');
    expect(hrefsIn(later)).toEqual(["/candidates?city=Pune"]);
  });

  it("an unreadable answer (a parse failure) is the same outage", async () => {
    searchCandidates.mockRejectedValueOnce(new TypeError("bad shape"));
    const out = await html();
    expect(stateOf(out)).toContain("We couldn’t load candidates");
    expect(out).not.toContain("candidates-pager");
  });
});

describe("all candidates — keyset paging and the pending cue", () => {
  it("nextCursor → Next page carrying it AND the filters; the first page offers no First page", async () => {
    searchCandidates.mockResolvedValueOnce(page({ filtered: true, matched: 9, nextCursor: NEXT }));
    const out = await html({ role: "mskill_cnc_turner", strict: "1" });
    expect(out).toContain('<nav class="candidates-pager" aria-label="Candidate pages">');
    // …and where that page starts: this one showed rows 1–2.
    expect(hrefsIn(out)).toContain(`/candidates?role=mskill_cnc_turner&strict=1&cursor=${NEXT}&from=3`);
    expect(textOf(out)).not.toContain("First page");
  });

  it("a later page offers First page (the cursor dropped, the filters kept); the last page no Next", async () => {
    const out = await html({ city: "Pune", cursor: CURSOR });
    expect(searchCandidates).toHaveBeenCalledWith({ city: "Pune", cursor: CURSOR });
    expect(hrefsIn(out)).toContain("/candidates?city=Pune");
    expect(textOf(out)).toContain("First page");
    expect(textOf(out)).not.toContain("Next page");
  });

  it("one page and no cursor: no pager at all", async () => {
    expect(await html()).not.toContain("candidates-pager");
  });

  it("no link on a full page goes without the cue — and the scan sees one that does", async () => {
    searchCandidates.mockResolvedValueOnce(page({ filtered: true, matched: 9, nextCursor: NEXT }));
    getUnlocks.mockResolvedValueOnce([]);
    const links = linkCue(await html({ city: "Pune", cursor: CURSOR }));
    expect(links.size).toBeGreaterThan(3);
    expect([...links].filter(([, cued]) => !cued)).toEqual([]);
    expect(linkCue('<a href="/candidates">x</a>').get("/candidates")).toBe(false);
  });
});

describe("#2588 · the pager says which rows are on screen; the count line is the list's heading", () => {
  /** The pager's "Showing …" line, or null when it draws none. */
  const rangeOf = (markup: string) =>
    /<p class="candidates-pager__range">([^<]*)<\/p>/.exec(markup)?.[1] ?? null;
  const HEADING = '<h2 tabindex="-1" class="paged-list-heading candidate-search__count">';

  it("the count line is the list's ONE heading before the cards — focusable by script, not a tab stop", async () => {
    const out = await html();
    expect(out.split(HEADING)).toHaveLength(2);
    expect(count(out)).toBe("62 candidates");
    expect(out.indexOf(HEADING)).toBeLessThan(out.indexOf('<div class="applicants-list">'));
  });

  it("the first page of several: 'Showing 1–2 of 62', and Next page carries where its page starts", async () => {
    searchCandidates.mockResolvedValueOnce(page({ nextCursor: NEXT }));
    const out = await html();
    expect(rangeOf(out)).toBe("Showing 1–2 of 62");
    expect(hrefsIn(out)).toContain(`/candidates?cursor=${NEXT}&from=3`);
  });

  it("a later page reached by Next: 'Showing 21–22 of 62'; First page drops the cursor AND the start", async () => {
    searchCandidates.mockResolvedValueOnce(page({ nextCursor: NEXT }));
    const out = await html({ city: "Pune", cursor: CURSOR, from: "21" });
    // The start is the portal's own count: it is never sent to the API.
    expect(searchCandidates).toHaveBeenCalledWith({ city: "Pune", cursor: CURSOR });
    expect(rangeOf(out)).toBe("Showing 21–22 of 62");
    expect(hrefsIn(out)).toContain(`/candidates?city=Pune&cursor=${NEXT}&from=23`);
    expect(hrefsIn(out)).toContain("/candidates?city=Pune");
    expect(hrefsIn(out).filter((h) => h.startsWith("/candidates?city=Pune") && !h.includes("cursor"))).toEqual([
      "/candidates?city=Pune",
    ]);
  });

  it("STRICT counts the list it pages — the matches plus the not-recorded, not the whole pool", async () => {
    searchCandidates.mockResolvedValueOnce(
      page({ filtered: true, strict: true, matched: 9, unrecorded: 3, nextCursor: NEXT }),
    );
    const out = await html({ role: "mskill_cnc_turner", strict: "1" });
    expect(rangeOf(out)).toBe("Showing 1–2 of 12");
  });

  it("a later page whose start is unknown (an old link) says no range — and its Next carries none", async () => {
    searchCandidates.mockResolvedValueOnce(page({ nextCursor: NEXT }));
    const out = await html({ cursor: CURSOR });
    expect(out).toContain('<nav class="candidates-pager" aria-label="Candidate pages">');
    expect(rangeOf(out)).toBeNull();
    expect(hrefsIn(out)).toContain(`/candidates?cursor=${NEXT}`);
    expect(hrefsIn(out).some((h) => h.includes("from="))).toBe(false);
  });

  it("a start the list no longer reaches (it shrank since) is not printed", async () => {
    expect(rangeOf(await html({ cursor: CURSOR, from: "61" }))).toBe("Showing 61–62 of 62");
    expect(rangeOf(await html({ cursor: CURSOR, from: "62" }))).toBeNull();
  });

  it("one page: no pager and no range (the count line already says how many)", async () => {
    const out = await html();
    expect(out).not.toContain("candidates-pager");
  });
});
